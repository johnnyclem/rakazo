import { createHash } from "node:crypto";
import type { RecordLedgerEntry, RecordLedgerProvider } from "@rakazo/adapter-kit";
import { RecordLedgerConflict, RecordLedgerUnavailable } from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";
import type { ContentKeyRing, Prisma, PrismaClient } from "@rakazo/db";
import {
  auditEventDto,
  contentEncryptionOf,
  createRowId,
  encryptText,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { advisoryLock } from "./advisory-lock.js";

/**
 * Rows commit a moment apart across instances. Sealing only rows older than this keeps a
 * late commit from landing behind the cursor, where it would never be sealed.
 */
const SETTLE_MS = 60_000;
const SEAL_BATCH = 200;
const MAX_SEAL_BATCHES_PER_PASS = 10;
const MAX_STREAMS_PER_PASS = 200;
const APPEND_TIMEOUT_MS = 30_000;
const SEAL_TRANSACTION_MS = 30_000;

type Cursor = { createdAt: Date; id: string };

/** One row ready to seal: where it belongs, and what the sealed record says. */
interface Sealable {
  sourceId: string;
  createdAt: Date;
  kind: string;
  /**
   * The stream that takes it: a bot's, or its Space's own when `botId` is null. A row with
   * no stream is read past without a record.
   */
  stream: { spaceId: string; botId: string | null } | null;
  record: Record<string, unknown>;
  /** The same record without its bulk, for a ledger that cannot hold the whole of it. */
  compact?: () => Record<string, unknown>;
}

type Source = (tx: Prisma.TransactionClient, where: Prisma.DateTimeFilter) => Promise<Sealable[]>;

function afterCursor(cursor: Cursor | undefined) {
  return cursor
    ? {
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      }
    : {};
}

const ORDER = [{ createdAt: "asc" as const }, { id: "asc" as const }];

/** Every saved version of every memory document, in a bot's stream or its Space's. */
function memoryRevisions(cursor: Cursor | undefined): Source {
  return async (tx, createdAt) => {
    const rows = await tx.memoryRevision.findMany({
      where: { createdAt, ...afterCursor(cursor) },
      orderBy: ORDER,
      take: SEAL_BATCH,
      select: {
        id: true,
        documentId: true,
        revision: true,
        content: true,
        sourceRunId: true,
        sourceThreadId: true,
        createdAt: true,
        document: { select: { spaceId: true, botId: true, scope: true, path: true } },
      },
    });
    return rows.map(({ document, content, ...row }) => {
      const record = {
        type: "memory.revision",
        id: row.id,
        documentId: row.documentId,
        scope: document.scope,
        path: document.path,
        revision: row.revision,
        sourceRunId: row.sourceRunId,
        sourceThreadId: row.sourceThreadId,
        createdAt: row.createdAt.toISOString(),
      };
      return {
        sourceId: row.id,
        createdAt: row.createdAt,
        kind: "memory.revision",
        stream: { spaceId: document.spaceId, botId: document.botId },
        record: { ...record, content },
        compact: () => ({
          ...record,
          contentOmitted: {
            bytes: Buffer.byteLength(content),
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        }),
      };
    });
  };
}

/**
 * What bots did and what people decided in a Space, as its organization's audit log records
 * it. A bot's own actions go to its stream; everything else goes to the Space's. A copy of
 * the event kept for another organization stays out: it is that organization's record.
 */
function auditEvents(cursor: Cursor | undefined): Source {
  return async (tx, createdAt) => {
    const rows = await tx.auditEvent.findMany({
      where: { spaceId: { not: null }, createdAt, ...afterCursor(cursor) },
      orderBy: ORDER,
      take: SEAL_BATCH,
    });
    const [spaces, bots] = await Promise.all([
      tx.space.findMany({
        where: { id: { in: [...new Set(rows.map((row) => row.spaceId!))] } },
        select: { id: true, organizationId: true },
      }),
      tx.bot.findMany({
        where: {
          id: {
            in: [
              ...new Set(
                rows.flatMap((row) =>
                  row.actorType === "bot" && row.actorId ? [row.actorId] : [],
                ),
              ),
            ],
          },
        },
        select: { id: true, spaceId: true },
      }),
    ]);
    const organizationOf = new Map(spaces.map((space) => [space.id, space.organizationId]));
    const spaceOfBot = new Map(bots.map((bot) => [bot.id, bot.spaceId]));
    return rows.map((row) => {
      const spaceId = row.spaceId!;
      const own = organizationOf.get(spaceId) === row.organizationId;
      const actedHere = row.actorType === "bot" && spaceOfBot.get(row.actorId ?? "") === spaceId;
      return {
        sourceId: row.id,
        createdAt: row.createdAt,
        kind: "audit.event",
        // A deleted Space's event, or another organization's copy, gets no record.
        stream: own ? { spaceId, botId: actedHere ? row.actorId : null } : null,
        record: { type: "audit.event", ...auditEventDto(row) },
      };
    });
  };
}

const SOURCES: Record<string, (cursor: Cursor | undefined) => Source> = {
  memory_revisions: memoryRevisions,
  audit_events: auditEvents,
};

interface SealOptions {
  ring: ContentKeyRing;
  maxEntryBytes: number;
  settledBefore: Date;
}

/**
 * Seals one batch of one source and moves its cursor, atomically: a row is either sealed
 * with the cursor past it, or neither. One sealer runs at a time across the deployment, so
 * two instances never hand out the same position in a stream.
 */
async function sealBatch(
  prisma: PrismaClient,
  source: string,
  options: SealOptions,
): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      await advisoryLock(tx, "record-ledger", "seal");
      const state = await tx.recordLedgerCursor.findUnique({ where: { source } });
      const cursor = state ? { createdAt: state.lastCreatedAt, id: state.lastId } : undefined;
      const rows = await SOURCES[source]!(cursor)(tx, { lt: options.settledBefore });
      const last = rows.at(-1);
      if (!last) return 0;

      const streams = new Map<string, { id: string; sealedSeq: number }>();
      const entries: Prisma.RecordLedgerEntryCreateManyInput[] = [];
      for (const row of rows) {
        if (!row.stream) continue;
        const { spaceId, botId } = row.stream;
        const subject = botId ? `bot:${botId}` : `space:${spaceId}`;
        let stream = streams.get(subject);
        if (!stream) {
          stream = await tx.recordLedgerStream.upsert({
            where: { subject },
            create: { id: createRowId(), subject, spaceId, botId },
            update: {},
            select: { id: true, sealedSeq: true },
          });
          streams.set(subject, stream);
        }
        const streamId = stream.id;
        const id = createRowId();
        const key = await options.ring.current(spaceId);
        const seal = (record: Record<string, unknown>) =>
          encryptText(
            key,
            { table: "record_ledger_entries", column: "payload", rowId: id, owner: streamId },
            JSON.stringify(record),
          );
        const fits = (sealed: string) => Buffer.byteLength(sealed) <= options.maxEntryBytes;
        let payload = seal(row.record);
        if (!fits(payload) && row.compact) payload = seal(row.compact());
        // Whatever still does not fit keeps its place in the stream as a stub, so one oversized
        // row never holds up the rows after it.
        if (!fits(payload)) payload = seal(omitted(row));
        stream.sealedSeq += 1;
        entries.push({
          id,
          streamId,
          seq: stream.sealedSeq,
          kind: row.kind,
          sourceId: row.sourceId,
          occurredAt: row.createdAt,
          payload,
        });
      }
      if (entries.length) await tx.recordLedgerEntry.createMany({ data: entries });
      for (const stream of streams.values()) {
        await tx.recordLedgerStream.update({
          where: { id: stream.id },
          data: { sealedSeq: stream.sealedSeq },
        });
      }
      const position = { lastCreatedAt: last.createdAt, lastId: last.sourceId };
      await tx.recordLedgerCursor.upsert({
        where: { source },
        create: { source, ...position },
        update: position,
      });
      return rows.length;
    },
    { timeout: SEAL_TRANSACTION_MS },
  );
}

async function seal(prisma: PrismaClient, options: SealOptions): Promise<void> {
  for (const source of Object.keys(SOURCES)) {
    for (let batch = 0; batch < MAX_SEAL_BATCHES_PER_PASS; batch++) {
      if ((await sealBatch(prisma, source, options)) < SEAL_BATCH) break;
    }
  }
}

/** What stands in for a record no form of which fits the ledger. */
function omitted(row: Sealable): Record<string, unknown> {
  const whole = JSON.stringify(row.record);
  return {
    type: row.kind,
    id: row.sourceId,
    createdAt: row.createdAt.toISOString(),
    omitted: {
      bytes: Buffer.byteLength(whole),
      sha256: createHash("sha256").update(whole).digest("hex"),
    },
  };
}

/** The leading entries that fit one append; always at least one. */
function withinBytes<T extends { payload: string }>(rows: T[], maxBytes: number): T[] {
  let bytes = 0;
  const end = rows.findIndex((row, index) => {
    bytes += Buffer.byteLength(row.payload);
    return index > 0 && bytes > maxBytes;
  });
  return end === -1 ? rows : rows.slice(0, end);
}

/**
 * Sends each stream's sealed entries the ledger has not acknowledged, oldest first.
 * Appends are idempotent, so two instances shipping the same stream only repeat work.
 */
async function ship(
  prisma: PrismaClient,
  provider: RecordLedgerProvider,
  now: () => Date,
): Promise<void> {
  const { maxBatchEntries, maxBatchBytes } = provider.describe().capabilities;
  const streams = await prisma.recordLedgerStream.findMany({
    where: {
      stoppedAt: null,
      sealedSeq: { gt: prisma.recordLedgerStream.fields.shippedSeq },
    },
    orderBy: { id: "asc" },
    take: MAX_STREAMS_PER_PASS,
    select: { id: true, sealedSeq: true, shippedSeq: true },
  });
  for (const stream of streams) {
    let shipped = stream.shippedSeq;
    let rewound = false;
    while (shipped < stream.sealedSeq) {
      const rows = withinBytes(
        await prisma.recordLedgerEntry.findMany({
          where: { streamId: stream.id, seq: { gt: shipped } },
          orderBy: { seq: "asc" },
          take: maxBatchEntries,
          select: { seq: true, kind: true, occurredAt: true, payload: true },
        }),
        maxBatchBytes,
      );
      const last = rows.at(-1);
      if (!last) break;
      const entries: RecordLedgerEntry[] = rows.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        occurredAt: row.occurredAt,
        payload: Buffer.from(row.payload, "utf8"),
      }));
      try {
        const head = await provider.append(
          { stream: stream.id, entries },
          deadlineSignal(APPEND_TIMEOUT_MS),
        );
        shipped = last.seq;
        await prisma.recordLedgerStream.update({
          where: { id: stream.id },
          data: {
            shippedSeq: shipped,
            shippedDigest: head.seq === shipped ? head.digest : null,
            shippedAt: now(),
          },
        });
      } catch (error) {
        // The same entries would be rejected again, so this stream waits for a person.
        const rejected = error instanceof RecordLedgerUnavailable && error.reason === "rejected";
        if (!(error instanceof RecordLedgerConflict) && !rejected) throw error;
        const conflict = error instanceof RecordLedgerConflict ? error : undefined;
        const ledgerSeq = conflict?.head?.seq ?? 0;
        if (conflict?.reason === "gap" && ledgerSeq < shipped && !rewound) {
          // The ledger no longer holds what it acknowledged: send again from where it ends.
          rewound = true;
          shipped = ledgerSeq;
          await prisma.recordLedgerStream.update({
            where: { id: stream.id },
            data: { shippedSeq: shipped, shippedDigest: conflict.head?.digest ?? null },
          });
          getLogger().warn("record.ledger.rewound", {
            "record.ledger.stream": stream.id,
            "record.ledger.seq": shipped,
          });
          continue;
        }
        await prisma.recordLedgerStream.update({
          where: { id: stream.id },
          data: { stoppedAt: now() },
        });
        getLogger().error("record.ledger.stopped", error, {
          "record.ledger.stream": stream.id,
          "record.ledger.seq": shipped + 1,
          "record.ledger.reason": conflict?.reason ?? "rejected",
          "record.ledger.ledger_seq": ledgerSeq,
        });
        break;
      }
    }
  }
}

/**
 * Seals new memory revisions and audit events into their streams and ships them to the
 * ledger, for the reconciler's tick. Nobody waits on this, and one ordered writer is what
 * keeps a stream's positions unique, so it runs as a batch rather than inside each write.
 */
export function createRecordLedgerReconciler(
  prisma: PrismaClient,
  provider: RecordLedgerProvider,
  options: { now?: () => Date; settleMs?: number } = {},
): () => Promise<void> {
  const ring = contentEncryptionOf(prisma)?.ring;
  // Records leave the deployment, so they are never sent unsealed.
  if (!ring) throw new Error("A record ledger needs the content keys to seal with");
  const now = options.now ?? (() => new Date());
  const settleMs = options.settleMs ?? SETTLE_MS;
  const { maxEntryBytes } = provider.describe().capabilities;
  return async () => {
    await runAsSystem("seal the record ledger", () =>
      seal(prisma, {
        ring,
        maxEntryBytes,
        settledBefore: new Date(now().getTime() - settleMs),
      }),
    );
    try {
      await runAsSystem("ship the record ledger", () => ship(prisma, provider, now));
    } catch (error) {
      if (!(error instanceof RecordLedgerUnavailable)) throw error;
      // Sealed entries wait in the database; the next tick sends them again.
      getLogger().warn("record.ledger.unavailable", { "record.ledger.reason": error.reason });
    }
  };
}

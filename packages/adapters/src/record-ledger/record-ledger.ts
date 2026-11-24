import { createHash } from "node:crypto";
import type { RecordLedgerEntry, RecordLedgerProvider } from "@rakazo/adapter-kit";
import {
  RecordLedgerConflict,
  RecordLedgerDestinationInvalid,
  RecordLedgerUnavailable,
} from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";
import type { ContentKeyRing, Prisma, PrismaClient } from "@rakazo/db";
import { auditEventDto, contentEncryptionOf, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { advisoryLock } from "../locks/advisory-lock.js";
import { syncDestinations } from "./record-ledger-destinations.js";
import { AUDIT_EVENT_KIND, MEMORY_REVISION_KIND } from "./record-ledger-format.js";
import { syncProvisions } from "./record-ledger-provisions.js";
import {
  announceRecipientChanges,
  recipientsBySpace,
  StreamWriter,
  seal,
} from "./record-ledger-streams.js";

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
        document: { select: { spaceId: true, userId: true, botId: true, scope: true, path: true } },
      },
    });
    return rows.map(({ document, content, ...row }) => {
      const record = {
        type: MEMORY_REVISION_KIND,
        id: row.id,
        documentId: row.documentId,
        spaceId: document.spaceId,
        userId: document.userId,
        botId: document.botId,
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
        kind: MEMORY_REVISION_KIND,
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
        kind: AUDIT_EVENT_KIND,
        // A deleted Space's event, or another organization's copy, gets no record.
        stream: own ? { spaceId, botId: actedHere ? row.actorId : null } : null,
        record: { type: AUDIT_EVENT_KIND, ...auditEventDto(row) },
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
  /** The time of this pass, for the entries a stream writes about itself. */
  at: Date;
}

/** The entries a batch of rows has already been sealed into, so none is sealed twice. */
async function alreadySealed(
  tx: Prisma.TransactionClient,
  rows: readonly Sealable[],
): Promise<Set<string>> {
  const sealed = await tx.recordLedgerEntry.findMany({
    where: {
      kind: { in: [...new Set(rows.map((row) => row.kind))] },
      sourceId: { in: rows.map((row) => row.sourceId) },
    },
    select: { kind: true, sourceId: true },
  });
  return new Set(sealed.map((entry) => `${entry.kind}:${entry.sourceId}`));
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

      const sealed = await alreadySealed(tx, rows);
      const recipients = await recipientsBySpace(
        tx,
        rows.flatMap((row) => (row.stream ? [row.stream.spaceId] : [])),
      );
      const writer = new StreamWriter(tx, options.ring, options.at);

      for (const row of rows) {
        if (!row.stream || sealed.has(`${row.kind}:${row.sourceId}`)) continue;
        const { spaceId, botId } = row.stream;
        const stream = await writer.open(botId ? `bot:${botId}` : `space:${spaceId}`, row.stream);
        if (!stream) continue;
        const key = await options.ring.current(spaceId);
        await writer.prepare(stream, key, recipients.get(spaceId) ?? []);

        writer.add(
          stream,
          { kind: row.kind, sourceId: row.sourceId, occurredAt: row.createdAt },
          (seq) => {
            const fits = (payload: string) => Buffer.byteLength(payload) <= options.maxEntryBytes;
            let payload = seal(key, stream.id, seq, row.record);
            if (!fits(payload) && row.compact) payload = seal(key, stream.id, seq, row.compact());
            // Whatever still does not fit keeps its place in the stream as a stub, so one
            // oversized row never holds up the rows after it.
            return fits(payload) ? payload : seal(key, stream.id, seq, omitted(row));
          },
        );
      }
      await writer.flush();
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

async function sealNew(prisma: PrismaClient, options: SealOptions): Promise<void> {
  // A stream owed an announcement to new owner keys gets it even if nothing new happens in it.
  for (let owed = MAX_STREAMS_PER_PASS; owed === MAX_STREAMS_PER_PASS; ) {
    owed = await announceRecipientChanges(prisma, options.ring, options.at);
  }
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
  options: {
    now?: () => Date;
    settleMs?: number;
    /** Called when a Space's request for a place of its own moves on, so open screens read it again. */
    onProvisionChanged?: (spaceId: string) => void;
  } = {},
): () => Promise<void> {
  const ring = contentEncryptionOf(prisma)?.ring;
  // Records leave the deployment, so they are never sent unsealed.
  if (!ring) throw new Error("A record ledger needs the content keys to seal with");
  const now = options.now ?? (() => new Date());
  const settleMs = options.settleMs ?? SETTLE_MS;
  const { maxEntryBytes } = provider.describe().capabilities;
  return async () => {
    await runAsSystem("seal the record ledger", () =>
      sealNew(prisma, {
        ring,
        maxEntryBytes,
        settledBefore: new Date(now().getTime() - settleMs),
        at: now(),
      }),
    );
    // A place being made for an owner, which becomes theirs once it is ready. A ledger that cannot
    // be reached for it is asked again next pass.
    try {
      await runAsSystem("bring places being made for owners up to date", () =>
        syncProvisions(prisma, provider, { onChanged: options.onProvisionChanged }),
      );
    } catch (error) {
      if (error instanceof RecordLedgerUnavailable) {
        getLogger().warn("record.ledger.unavailable", { "record.ledger.reason": error.reason });
      } else {
        throw error;
      }
    }
    // Before anything is sent, so a stream's first entries go where its owner said. A ledger that
    // cannot be told does not stop the backups: they are kept wherever it keeps its own meanwhile.
    try {
      await runAsSystem("tell the record ledger where each stream is kept", () =>
        syncDestinations(prisma, provider),
      );
    } catch (error) {
      if (error instanceof RecordLedgerDestinationInvalid) {
        getLogger().warn("record.ledger.destination_invalid", {
          "record.ledger.reason": error.message,
        });
      } else if (error instanceof RecordLedgerUnavailable) {
        getLogger().warn("record.ledger.unavailable", { "record.ledger.reason": error.reason });
      } else {
        throw error;
      }
    }
    try {
      await runAsSystem("ship the record ledger", () => ship(prisma, provider, now));
    } catch (error) {
      if (!(error instanceof RecordLedgerUnavailable)) throw error;
      // Sealed entries wait in the database; the next tick sends them again.
      getLogger().warn("record.ledger.unavailable", { "record.ledger.reason": error.reason });
    }
  };
}

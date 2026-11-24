import type { RecordLedgerHead, RecordLedgerProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createRowId, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type {
  AuditEventRecord,
  MemoryRevisionRecord,
  StreamHeader,
} from "./record-ledger-format.js";
import { recipientSetDigest } from "./record-ledger-owner-keys.js";
import type {
  DecodedRecord,
  LedgerKeys,
  ReadEntry,
  StreamProblem,
} from "./record-ledger-reader.js";
import { LedgerStreamReader } from "./record-ledger-reader.js";

export interface RestoreOptions {
  prisma: PrismaClient;
  provider: RecordLedgerProvider;
  /** What opens the stream: master keys, an owner's identities, or keys the database holds. */
  keys: LedgerKeys;
  stream: string;
  signal: AbortSignal;
  /**
   * Write a bot's memory into another bot, as new revisions that its own stream then records.
   * For a deployment that is new, where the original bot and Space do not exist. Audit events
   * are never copied: they are the original organization's record.
   */
  intoBot?: string;
  /** Restore what opens, leaving out entries that do not. Without it one such entry restores nothing. */
  skipUnreadable?: boolean;
  /** Read and check everything, write nothing. */
  dryRun?: boolean;
  now?: () => Date;
}

export interface RestoreReport {
  stream: string;
  /** `bot:<id>` or `space:<id>`, when the header opened. */
  subject: string | null;
  head: RecordLedgerHead | null;
  /** Entries read from the ledger. */
  entries: number;
  memory: {
    added: number;
    existing: number;
    /** Too large for the ledger when it was written, so their content is not in it. */
    omitted: number;
    /** Revisions the database holds differently; their documents were left as they are. */
    conflicts: Array<{ path: string; revision: number }>;
  };
  audit: { added: number; existing: number; foreign: number };
  /** Records that name a different Space or bot than their stream, left out rather than trusted. */
  misplaced: number;
  /** The database's own record of the stream now matches the ledger, so sealing carries on after it. */
  linked: boolean;
  problems: StreamProblem[];
  warnings: string[];
  /** Why nothing was restored, when nothing was. */
  skipped?: string;
}

/** Where the records go. */
interface Destination {
  spaceId: string;
  userId: string | null;
  botId: string | null;
  organizationId: string;
  /** Restored where it came from, keeping its ids, rather than copied into something else. */
  inPlace: boolean;
}

/**
 * Brings the database up to what the ledger holds for one stream. It adds what is missing and
 * never changes what is there: a revision the database holds differently is reported and its
 * document left alone. Run it with the API and worker stopped, as a backup restore is.
 */
export async function restoreLedgerStream(options: RestoreOptions): Promise<RestoreReport> {
  const report = emptyReport(options.stream);
  const reader = () =>
    new LedgerStreamReader(options.provider, options.keys, options.stream, options.signal);

  // Unless asked to skip them, an entry that does not open stops the whole restore before any
  // write, so a partial history is never mistaken for the whole one.
  if (!options.skipUnreadable) {
    const check = reader();
    await check.check();
    if (check.problems.length) {
      report.head = check.head;
      report.problems = check.problems;
      report.skipped =
        "Some entries do not open; nothing was restored (use skipUnreadable to restore the rest).";
      return report;
    }
  }

  return runAsSystem("restore the record ledger", () => apply(options, report, reader()));
}

async function apply(
  options: RestoreOptions,
  report: RestoreReport,
  reader: LedgerStreamReader,
): Promise<RestoreReport> {
  const { prisma, stream } = options;
  const now = options.now ?? (() => new Date());
  let destination: Destination | undefined;
  let linker: StreamLinker | undefined;
  const conflicted = new Set<string>();
  const early: ReadEntry[] = [];

  for await (const entry of reader.entries()) {
    report.entries += 1;
    if (entry.problem) {
      // Read past, and nothing after it can be linked: a position is missing from the chain.
      linker?.stop();
      continue;
    }
    const decoded = entry.decoded;
    if (!decoded) continue;

    if (!destination) {
      if (decoded.kind === "stream.opened") {
        report.subject = decoded.header.subject;
        const resolved = await resolveDestination(prisma, decoded.header, options.intoBot);
        if (typeof resolved === "string") {
          report.skipped = resolved;
          break;
        }
        destination = resolved;
        if (destination.inPlace && !options.dryRun) {
          linker = await StreamLinker.begin(prisma, stream, decoded.header, report.warnings);
          for (const waiting of early) await linker.take(waiting);
        }
      } else if (decoded.kind === "space.key" || decoded.kind === "key.recipients") {
        // The Space key comes before the header; it is linked once the stream is placed.
        early.push(entry);
        continue;
      } else {
        // Before the header nothing says whose the stream is, so nothing in it can be placed.
        report.skipped = "The stream has no header, so it cannot be placed.";
        break;
      }
    }
    await linker?.take(entry);
    if (!destination) continue;

    if (decoded.kind === "memory.revision" || decoded.kind === "audit.event") {
      // A record goes where its stream says, never where the record itself says: one that names
      // another Space or bot is left out, so a stream cannot write into someone else's memory.
      const { record } = decoded;
      const misplaced =
        destination.inPlace &&
        (record.spaceId !== destination.spaceId ||
          (record.type === "memory.revision" && record.botId !== destination.botId));
      if (misplaced) {
        report.misplaced += 1;
        if (report.misplaced === 1) {
          report.warnings.push(
            "A record names a different Space or bot than the stream it is in, and was left out.",
          );
        }
        continue;
      }
    }
    if (decoded.kind === "memory.revision") {
      await restoreRevision(prisma, destination, decoded.record, report, conflicted, {
        dryRun: options.dryRun,
        now,
      });
    } else if (decoded.kind === "audit.event" && destination.inPlace) {
      await restoreAuditEvent(prisma, destination, decoded.record, report, options.dryRun);
    } else if (decoded.kind === "omitted" && decoded.entryKind === "memory.revision") {
      report.memory.omitted += 1;
    }
  }

  report.head = reader.head;
  report.problems = reader.problems;
  if (linker) report.linked = await linker.finish(reader.head, reader.problems.length === 0, now());
  return report;
}

function emptyReport(stream: string): RestoreReport {
  return {
    stream,
    subject: null,
    head: null,
    entries: 0,
    memory: { added: 0, existing: 0, omitted: 0, conflicts: [] },
    audit: { added: 0, existing: 0, foreign: 0 },
    misplaced: 0,
    linked: false,
    problems: [],
    warnings: [],
  };
}

/** Where a stream's records go, or why they cannot go anywhere. */
async function resolveDestination(
  prisma: PrismaClient,
  header: StreamHeader,
  intoBot: string | undefined,
): Promise<Destination | string> {
  if (intoBot) {
    if (!header.botId) return "Only a bot's stream can be restored into another bot.";
    const bot = await prisma.bot.findUnique({
      where: { id: intoBot },
      select: { spaceId: true, userId: true, space: { select: { organizationId: true } } },
    });
    if (!bot) return "The bot to restore into does not exist.";
    return {
      spaceId: bot.spaceId,
      userId: bot.userId,
      botId: intoBot,
      organizationId: bot.space.organizationId,
      inPlace: false,
    };
  }
  const space = await prisma.space.findUnique({
    where: { id: header.spaceId },
    select: { organizationId: true },
  });
  if (!space)
    return "The Space this stream belongs to does not exist here; restore into a bot instead.";
  if (header.botId) {
    const bot = await prisma.bot.findUnique({
      where: { id: header.botId },
      select: { spaceId: true },
    });
    if (!bot)
      return "The bot this stream belongs to does not exist here; restore into a bot instead.";
    if (bot.spaceId !== header.spaceId)
      return "The bot is in a different Space than the stream says.";
  }
  return {
    spaceId: header.spaceId,
    userId: null,
    botId: header.botId,
    organizationId: space.organizationId,
    inPlace: true,
  };
}

const documentKey = (record: MemoryRevisionRecord, botId: string | null) =>
  `${record.scope}\0${botId ?? ""}\0${record.path}`;

/** Adds one revision the database lacks, and moves its document forward if this is the newest. */
async function restoreRevision(
  prisma: PrismaClient,
  destination: Destination,
  record: MemoryRevisionRecord,
  report: RestoreReport,
  conflicted: Set<string>,
  { dryRun, now }: { dryRun: boolean | undefined; now: () => Date },
): Promise<void> {
  const { memory } = report;
  if (record.content === undefined) {
    memory.omitted += 1;
    return;
  }
  const content = record.content;
  const botId = destination.inPlace ? record.botId : destination.botId;
  const key = documentKey(record, botId);
  if (conflicted.has(key)) return;
  const spaceId = destination.spaceId;
  const userId = destination.inPlace ? record.userId : (destination.userId ?? record.userId);
  const inPlace = destination.inPlace;

  const outcome = await prisma.$transaction(async (tx) => {
    const found = await tx.memoryDocument.findFirst({
      where: { spaceId, scope: record.scope, botId, path: record.path },
    });
    const held = found
      ? await tx.memoryRevision.findUnique({
          where: { documentId_revision: { documentId: found.id, revision: record.revision } },
        })
      : null;
    if (held) return held.content === content ? "existing" : "conflict";
    if (dryRun) return "added";

    const document =
      found ??
      (await tx.memoryDocument.create({
        data: {
          // In place the ids are kept, so the restored rows are the ones the ledger recorded.
          id:
            inPlace &&
            !(await tx.memoryDocument.findUnique({
              where: { id: record.documentId },
              select: { id: true },
            }))
              ? record.documentId
              : undefined,
          spaceId,
          userId,
          botId,
          scope: record.scope,
          path: record.path,
          content,
          revision: record.revision,
        },
      }));
    await tx.memoryRevision.create({
      data: {
        id:
          inPlace &&
          !(await tx.memoryRevision.findUnique({ where: { id: record.id }, select: { id: true } }))
            ? record.id
            : undefined,
        documentId: document.id,
        revision: record.revision,
        content,
        sourceRunId: record.sourceRunId,
        sourceThreadId: record.sourceThreadId,
        // Restored in place it keeps its time, and its entry is already in the stream. Copied into
        // another bot it is new memory there, so it is made now, where the bot's own stream
        // will record it; its first time is in the stream it came from.
        createdAt: inPlace ? new Date(record.createdAt) : now(),
      },
    });
    if (found && record.revision > found.revision) {
      await tx.memoryDocument.update({
        where: { id: found.id },
        data: { content, revision: record.revision },
      });
    }
    return "added";
  });

  if (outcome === "conflict") {
    conflicted.add(key);
    memory.conflicts.push({ path: record.path, revision: record.revision });
  } else {
    memory[outcome] += 1;
  }
}

/** Adds one audit event the log lacks, with its own id, in the organization that recorded it. */
async function restoreAuditEvent(
  prisma: PrismaClient,
  destination: Destination,
  record: AuditEventRecord,
  report: RestoreReport,
  dryRun: boolean | undefined,
): Promise<void> {
  const { audit } = report;
  if (record.organizationId !== destination.organizationId) {
    audit.foreign += 1;
    return;
  }
  if (dryRun) {
    const held = await prisma.auditEvent.findUnique({ where: { id: record.id } });
    audit[held ? "existing" : "added"] += 1;
    return;
  }
  const { type: _type, createdAt, ...row } = record;
  const { count } = await prisma.auditEvent.createMany({
    data: [{ ...row, createdAt: new Date(createdAt) }],
    skipDuplicates: true,
  });
  audit[count ? "added" : "existing"] += 1;
}

/**
 * Keeps the database's own record of a stream in step with the ledger as entries are read, so
 * that after an in-place restore sealing carries on from where the ledger ends instead of
 * colliding with it. Entries are taken in order and only while they match what the database
 * already holds; at the first difference it stops and says so.
 */
class StreamLinker {
  private active = true;
  private keyId: string | null;
  private recipientsDigest: string | null;
  private last = 0;

  private constructor(
    private readonly prisma: PrismaClient,
    private readonly stream: string,
    private readonly sealedSeq: number,
    private readonly shippedSeq: number,
    announced: { keyId: string | null; recipientsDigest: string | null },
    private readonly spaceId: string,
    private readonly warnings: string[],
  ) {
    this.keyId = announced.keyId;
    this.recipientsDigest = announced.recipientsDigest;
  }

  static async begin(
    prisma: PrismaClient,
    stream: string,
    header: StreamHeader,
    warnings: string[],
  ): Promise<StreamLinker> {
    const existing = await prisma.recordLedgerStream.findUnique({
      where: { subject: header.subject },
    });
    const linker = new StreamLinker(
      prisma,
      stream,
      existing?.sealedSeq ?? 0,
      existing?.shippedSeq ?? 0,
      { keyId: existing?.keyId ?? null, recipientsDigest: existing?.recipientsDigest ?? null },
      header.spaceId,
      warnings,
    );
    if (existing && existing.id !== stream) {
      warnings.push(
        "The database already has a different stream for this bot or Space. It was not re-linked: remove that stream's rows, then restore again.",
      );
      linker.active = false;
    } else if (!existing) {
      await prisma.recordLedgerStream.create({
        data: {
          id: stream,
          subject: header.subject,
          spaceId: header.spaceId,
          botId: header.botId,
        },
      });
    }
    return linker;
  }

  /** Stops linking at an entry that could not be read. What was linked so far stays consistent. */
  stop(): void {
    if (this.active) {
      this.warnings.push(
        "Entries that did not open were left out, so the stream was not re-linked: sealing for it will stop until that is resolved.",
      );
    }
    this.active = false;
  }

  /** Takes the next entry: confirms the database holds it, or stores it. */
  async take(entry: ReadEntry): Promise<void> {
    if (!this.active || !entry.decoded) return;
    const payload = Buffer.from(entry.payload).toString("utf8");
    if (entry.seq <= this.sealedSeq) {
      const held = await this.prisma.recordLedgerEntry.findUnique({
        where: { streamId_seq: { streamId: this.stream, seq: entry.seq } },
        select: { payload: true },
      });
      if (held?.payload !== payload) {
        this.active = false;
        this.warnings.push(
          `The database's own entry ${entry.seq} for this stream differs from the ledger's, so the stream was not re-linked: sealing for it will stop until that is resolved.`,
        );
      } else {
        this.last = entry.seq;
      }
      return;
    }
    // What the stream last announced, and to whom, is what its next entries must carry on from.
    if (entry.decoded.kind === "space.key") {
      this.keyId = entry.decoded.envelope.id;
      this.recipientsDigest = null;
    } else if (entry.decoded.kind === "key.recipients") {
      this.keyId = entry.decoded.envelope.keyId;
      this.recipientsDigest = entry.decoded.envelope.digest;
    }
    // The entry and the stream's own count of them move together, so the database never holds an
    // entry past the end of its stream, whatever stops the restore.
    await this.prisma.$transaction(async (tx) => {
      await tx.recordLedgerEntry.create({
        data: {
          id: createRowId(),
          streamId: this.stream,
          seq: entry.seq,
          kind: entry.kind,
          sourceId: sourceIdOf(this.stream, entry.seq, entry.decoded!),
          occurredAt: entry.occurredAt,
          payload,
        },
      });
      await tx.recordLedgerStream.update({
        where: { id: this.stream },
        data: {
          sealedSeq: entry.seq,
          keyId: this.keyId,
          recipientsDigest: this.recipientsDigest,
        },
      });
    });
    this.last = entry.seq;
  }

  /**
   * The owner keys a Space is sealed to are kept in the database, so a backup older than they are
   * does not have them. A stream sealed to them would then be announced under the master key at
   * the next pass: protection lost without a word. Say so while there is still time to add them.
   */
  private async warnIfOwnerKeysLost(): Promise<void> {
    if (!this.recipientsDigest) return;
    const keys = await this.prisma.recordLedgerRecipient.findMany({
      where: { spaceId: this.spaceId },
      select: { recipient: true },
    });
    const now = keys.length ? recipientSetDigest(keys.map((key) => key.recipient)) : null;
    if (now === this.recipientsDigest) return;
    this.warnings.push(
      "This stream is sealed to owner keys the database does not have for the Space. Unless they are added again (record-ledger recipient add) before the services start, the next pass announces its key under the master key instead.",
    );
  }

  /** Points the stream at the ledger's end. Whether it was fully linked. */
  async finish(head: RecordLedgerHead | null, clean: boolean, at: Date): Promise<boolean> {
    if (this.active && !clean) {
      this.warnings.push(
        "Entries that did not open were left out, so the stream was not re-linked: sealing for it will stop until that is resolved.",
      );
    }
    if (!this.active || !clean || !head || this.last < head.seq) return false;
    if (this.shippedSeq > head.seq) {
      this.warnings.push(
        `The database believed the ledger held ${this.shippedSeq} entries, but it holds ${head.seq}: the ledger may have lost entries.`,
      );
    }
    await this.prisma.recordLedgerStream.update({
      where: { id: this.stream },
      data: {
        shippedSeq: head.seq,
        shippedDigest: head.digest,
        shippedAt: at,
        keyId: this.keyId,
        recipientsDigest: this.recipientsDigest,
        stoppedAt: null,
      },
    });
    await this.warnIfOwnerKeysLost();
    getLogger().info("record.ledger.relinked", {
      "record.ledger.stream": this.stream,
      "record.ledger.seq": head.seq,
    });
    return true;
  }
}

/** What the database files an entry under, so the same row is never sealed a second time. */
function sourceIdOf(stream: string, seq: number, decoded: DecodedRecord): string {
  switch (decoded.kind) {
    case "stream.opened":
      return stream;
    case "memory.revision":
    case "audit.event":
    case "omitted":
      return decoded.record.id;
    default:
      return `${stream}:${seq}`;
  }
}

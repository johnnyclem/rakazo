import type { ContentKeyRing, DataKey, Prisma, PrismaClient } from "@rakazo/db";
import { createRowId, encryptText } from "@rakazo/db";
import { advisoryLock } from "../locks/advisory-lock.js";
import type {
  KeyRecipientsEnvelope,
  SpaceKeyEnvelope,
  StreamHeader,
} from "./record-ledger-format.js";
import {
  entryLocation,
  KEY_RECIPIENTS_KIND,
  SPACE_KEY_KIND,
  STREAM_OPENED_KIND,
} from "./record-ledger-format.js";
import { recipientSetDigest, wrapKeyToRecipients } from "./record-ledger-owner-keys.js";

const MAX_STREAMS_PER_PASS = 200;
const TRANSACTION_MS = 30_000;

/** Seals `record` for the entry at `seq` of `stream`, under `key`. */
export const seal = (key: DataKey, stream: string, seq: number, record: unknown) =>
  encryptText(key, entryLocation(stream, seq), JSON.stringify(record));

/** A stream being written to: where it ends now, and what it still has to say about itself. */
export interface OpenStream {
  id: string;
  sealedSeq: number;
  /** The Space key the stream last announced. */
  keyId: string | null;
  /** Who it last announced it to: a digest of the owner keys, or null for a master key. */
  recipientsDigest: string | null;
  /** Set only for a stream opened in this pass, until its header is written. */
  header?: StreamHeader;
}

/** The owner keys of each Space, sorted. A Space with none is not in the map. */
export async function recipientsBySpace(
  tx: Prisma.TransactionClient,
  spaceIds: readonly string[],
): Promise<Map<string, string[]>> {
  const rows = await tx.recordLedgerRecipient.findMany({
    where: { spaceId: { in: [...new Set(spaceIds)] } },
    orderBy: { recipient: "asc" },
    select: { spaceId: true, recipient: true },
  });
  const bySpace = new Map<string, string[]>();
  for (const row of rows)
    bySpace.set(row.spaceId, [...(bySpace.get(row.spaceId) ?? []), row.recipient]);
  return bySpace;
}

/**
 * Collects the entries a pass adds to its streams, then writes them and each stream's new end
 * together. It also keeps a stream's promise to say what it takes to open it: the Space key,
 * announced to whoever may open it, and who the stream is for.
 */
export class StreamWriter {
  private readonly entries: Prisma.RecordLedgerEntryCreateManyInput[] = [];
  private readonly streams = new Map<string, OpenStream>();

  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly ring: ContentKeyRing,
    /** The time of this pass, for the entries a stream writes about itself. */
    private readonly at: Date,
  ) {}

  /** The stream for `subject`, opened if it is new. Null when its Space is already gone. */
  async open(
    subject: string,
    target: { spaceId: string; botId: string | null },
  ): Promise<OpenStream | null> {
    const cached = this.streams.get(subject);
    if (cached) return cached;
    const found = await this.tx.recordLedgerStream.findUnique({
      where: { subject },
      select: { id: true, sealedSeq: true, keyId: true, recipientsDigest: true },
    });
    const stream = found ?? (await this.create(subject, target));
    if (stream) this.streams.set(subject, stream);
    return stream;
  }

  /** A stream that already exists, to be written to by this pass. */
  take(stream: OpenStream, subject: string): OpenStream {
    this.streams.set(subject, stream);
    return stream;
  }

  private async create(
    subject: string,
    target: { spaceId: string; botId: string | null },
  ): Promise<OpenStream | null> {
    const [space, bot] = await Promise.all([
      this.tx.space.findUnique({
        where: { id: target.spaceId },
        select: { name: true, organizationId: true },
      }),
      target.botId
        ? this.tx.bot.findUnique({ where: { id: target.botId }, select: { name: true } })
        : null,
    ]);
    if (!space) return null;
    const created = await this.tx.recordLedgerStream.create({
      data: { id: createRowId(), subject, spaceId: target.spaceId, botId: target.botId },
      select: { id: true, sealedSeq: true, keyId: true, recipientsDigest: true },
    });
    return {
      ...created,
      header: {
        type: STREAM_OPENED_KIND,
        subject,
        spaceId: target.spaceId,
        botId: target.botId,
        organizationId: space.organizationId,
        spaceName: space.name,
        botName: bot?.name ?? null,
        openedAt: this.at.toISOString(),
      },
    };
  }

  /** Adds an entry at the end of `stream`; `payload` is built knowing the position it takes. */
  add(
    stream: OpenStream,
    entry: {
      kind: string;
      sourceId: string | ((seq: number) => string);
      occurredAt: Date;
    },
    payload: (seq: number) => string,
  ): void {
    stream.sealedSeq += 1;
    const seq = stream.sealedSeq;
    this.entries.push({
      id: createRowId(),
      streamId: stream.id,
      seq,
      kind: entry.kind,
      sourceId: typeof entry.sourceId === "string" ? entry.sourceId : entry.sourceId(seq),
      occurredAt: entry.occurredAt,
      payload: payload(seq),
    });
  }

  /**
   * Makes sure `stream` has announced `key` to whoever may open it now (the Space's owner keys,
   * or else a master key) and, for a new stream, has said who it is for. A stream that already
   * has history and is announced to a different audience announces every key version of the
   * Space again, so the new audience can open the history as well as what comes next.
   */
  async prepare(stream: OpenStream, key: DataKey, recipients: readonly string[]): Promise<void> {
    const digest = recipients.length ? recipientSetDigest(recipients) : null;
    if (stream.keyId !== key.id || stream.recipientsDigest !== digest) {
      const newAudience = stream.keyId !== null && stream.recipientsDigest !== digest;
      const keys = newAudience ? await this.ring.all(key.spaceId) : [key];
      for (const announced of keys) await this.announce(stream, announced, recipients, digest);
      stream.keyId = key.id;
      stream.recipientsDigest = digest;
    }
    const { header } = stream;
    if (header) {
      this.add(
        stream,
        { kind: STREAM_OPENED_KIND, sourceId: stream.id, occurredAt: this.at },
        (seq) => seal(key, stream.id, seq, header),
      );
      delete stream.header;
    }
  }

  private async announce(
    stream: OpenStream,
    key: DataKey,
    recipients: readonly string[],
    digest: string | null,
  ): Promise<void> {
    // An announcement is not a row of its own, so its place in the stream is what makes it unique.
    const sourceId = (seq: number) => `${stream.id}:${seq}`;
    if (digest) {
      const envelope: KeyRecipientsEnvelope = {
        type: KEY_RECIPIENTS_KIND,
        keyId: key.id,
        digest,
        age: await wrapKeyToRecipients(key, recipients),
      };
      this.add(stream, { kind: KEY_RECIPIENTS_KIND, sourceId, occurredAt: this.at }, () =>
        JSON.stringify(envelope),
      );
      return;
    }
    const { id, version, masterKeyId, wrappedKey } = await this.ring.wrapped(key.id);
    const envelope: SpaceKeyEnvelope = {
      type: SPACE_KEY_KIND,
      id,
      spaceId: key.spaceId,
      version,
      masterKeyId,
      wrappedKey,
    };
    this.add(stream, { kind: SPACE_KEY_KIND, sourceId, occurredAt: this.at }, () =>
      JSON.stringify(envelope),
    );
  }

  /** Writes the entries, and moves each stream's end and announced key with them. */
  async flush(): Promise<void> {
    if (this.entries.length) await this.tx.recordLedgerEntry.createMany({ data: this.entries });
    for (const stream of this.streams.values()) {
      await this.tx.recordLedgerStream.update({
        where: { id: stream.id },
        data: {
          sealedSeq: stream.sealedSeq,
          keyId: stream.keyId,
          recipientsDigest: stream.recipientsDigest,
        },
      });
    }
  }
}

interface StaleStream {
  id: string;
  subject: string;
  spaceId: string;
  sealedSeq: number;
  keyId: string | null;
  recipientsDigest: string | null;
}

/**
 * Streams whose Space has gained, lost or changed owner keys since they last announced, given
 * the announcement they are owed. Without this, a stream that has no new rows would keep its
 * old audience until something happened in it.
 */
export async function announceRecipientChanges(
  prisma: PrismaClient,
  ring: ContentKeyRing,
  at: Date,
): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      await advisoryLock(tx, "record-ledger", "seal");
      // The digest is computed here as the sealer computes it: the owner keys sorted bytewise,
      // joined by newlines, hashed, and cut to 32 hex characters.
      const stale = await tx.$queryRaw<StaleStream[]>`
        SELECT s.id, s.subject, s."spaceId", s."sealedSeq", s."keyId", s."recipientsDigest"
        FROM record_ledger_streams s
        LEFT JOIN (
          SELECT "spaceId",
            left(encode(sha256(convert_to(
              string_agg(recipient, E'\n' ORDER BY recipient COLLATE "C"), 'UTF8')), 'hex'), 32) AS digest
          FROM record_ledger_recipients
          GROUP BY "spaceId"
        ) r ON r."spaceId" = s."spaceId"
        WHERE s."sealedSeq" > 0 AND s."recipientsDigest" IS DISTINCT FROM r.digest
        ORDER BY s.id
        LIMIT ${MAX_STREAMS_PER_PASS}`;
      if (!stale.length) return 0;
      const recipients = await recipientsBySpace(
        tx,
        stale.map((stream) => stream.spaceId),
      );
      const writer = new StreamWriter(tx, ring, at);
      for (const row of stale) {
        const stream = writer.take(
          {
            id: row.id,
            sealedSeq: row.sealedSeq,
            keyId: row.keyId,
            recipientsDigest: row.recipientsDigest,
          },
          row.subject,
        );
        await writer.prepare(
          stream,
          await ring.current(row.spaceId),
          recipients.get(row.spaceId) ?? [],
        );
      }
      await writer.flush();
      return stale.length;
    },
    { timeout: TRANSACTION_MS },
  );
}

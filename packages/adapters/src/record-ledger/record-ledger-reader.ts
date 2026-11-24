import type { KeyProvider, RecordLedgerHead, RecordLedgerProvider } from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";
import type { DataKey } from "@rakazo/db";
import { ContentDecryptionError, ciphertextKeyId, decryptText } from "@rakazo/db";
import type { z } from "zod";
import type {
  AuditEventRecord,
  KeyRecipientsEnvelope,
  MemoryRevisionRecord,
  OmittedRecord,
  SpaceKeyEnvelope,
  StreamHeader,
} from "./record-ledger-format.js";
import {
  AUDIT_EVENT_KIND,
  auditEventRecordSchema,
  entryLocation,
  KEY_RECIPIENTS_KIND,
  keyRecipientsEnvelopeSchema,
  MEMORY_REVISION_KIND,
  memoryRevisionRecordSchema,
  omittedRecordSchema,
  SPACE_KEY_KIND,
  STREAM_OPENED_KIND,
  spaceKeyEnvelopeSchema,
  streamHeaderSchema,
} from "./record-ledger-format.js";
import { unwrapKeyWithIdentities } from "./record-ledger-owner-keys.js";

const READ_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 100;
/** The header sits in the first few entries; a stream whose header is not there has none. */
const HEADER_SEARCH_ENTRIES = 8;

export type StreamProblemCode = "gap" | "short" | "key" | "unreadable" | "malformed";

/** Something that stops a stream being read back faithfully. */
export interface StreamProblem {
  seq: number;
  code: StreamProblemCode;
  message: string;
}

/** What can open a stream's Space keys. Any of them may be missing; what none opens is reported. */
export interface LedgerKeys {
  /** Opens a Space key wrapped by a master key. */
  keyProvider?: KeyProvider;
  /** age identities (`AGE-SECRET-KEY-1…`) of an owner, which open a Space key sealed to them. */
  identities?: readonly string[];
  /** A key the database already holds, tried for one no announcement in the stream opened. */
  known?: (keyId: string) => Promise<DataKey | undefined>;
}

export type DecodedRecord =
  | { kind: typeof SPACE_KEY_KIND; envelope: SpaceKeyEnvelope }
  | { kind: typeof KEY_RECIPIENTS_KIND; envelope: KeyRecipientsEnvelope }
  | { kind: typeof STREAM_OPENED_KIND; header: StreamHeader }
  | { kind: typeof MEMORY_REVISION_KIND; record: MemoryRevisionRecord }
  | { kind: typeof AUDIT_EVENT_KIND; record: AuditEventRecord }
  /** A record too large for the ledger, kept as its size and digest. */
  | { kind: "omitted"; entryKind: string; record: OmittedRecord }
  /** A kind this version does not know, kept so it is listed rather than lost. */
  | { kind: "unknown"; entryKind: string };

export interface ReadEntry {
  seq: number;
  kind: string;
  occurredAt: Date;
  /** Exactly what the ledger holds. */
  payload: Uint8Array;
  /** Null when the entry could not be opened; `problem` says why. */
  decoded: DecodedRecord | null;
  problem?: StreamProblem;
}

const OPEN_FAILED =
  "does not open: it was altered, or moved from another stream or position, or sealed under a different key";

/**
 * Reads one stream back from the ledger and opens it, with nothing but the ledger and a key that
 * opens it: the stream carries its own Space keys (wrapped by a master key, or sealed to its
 * owner) and says who it is for. Entries come out in order and are checked as they go: a gap or a
 * short answer, an entry that does not open, and one that does not say what its kind promises
 * are each reported in `problems` and never guessed at. A Space key the stream announces but
 * nothing here opens is reported only if an entry needs it.
 */
export class LedgerStreamReader {
  /** Where the ledger says the stream ends, once a page has been read. */
  head: RecordLedgerHead | null = null;
  readonly problems: StreamProblem[] = [];
  private readonly opened = new Map<string, DataKey>();
  /** Why a Space key could not be opened, by key id, for the entries that needed it. */
  private readonly closed = new Map<string, string>();
  /** The entry being read, so a look ahead starts after it. */
  private position = 0;
  private scanned = false;

  constructor(
    private readonly provider: RecordLedgerProvider,
    private readonly access: LedgerKeys,
    readonly stream: string,
    private readonly signal: AbortSignal,
    private readonly pageSize = DEFAULT_PAGE_SIZE,
  ) {}

  async *entries(): AsyncGenerator<ReadEntry> {
    let expected = 1;
    for (;;) {
      const page = await this.provider.read(
        { stream: this.stream, after: expected - 1, limit: this.pageSize },
        deadlineSignal(READ_TIMEOUT_MS, this.signal),
      );
      this.head = page.head;
      if (page.entries.length === 0) break;
      for (const entry of page.entries) {
        if (entry.seq !== expected) {
          this.problem(
            entry.seq,
            "gap",
            `expected entry ${expected}, the ledger returned ${entry.seq}`,
          );
          return;
        }
        this.position = entry.seq;
        yield await this.decode(entry);
        expected += 1;
      }
      if (this.head && expected > this.head.seq) break;
    }
    if (this.head && expected - 1 < this.head.seq) {
      this.problem(
        expected,
        "short",
        `the ledger reports ${this.head.seq} entries but returned ${expected - 1}`,
      );
    }
  }

  /** Reads the whole stream without keeping it, to learn whether it reads back; its length. */
  async check(): Promise<number> {
    let length = 0;
    for await (const _entry of this.entries()) length += 1;
    return length;
  }

  private problem(seq: number, code: StreamProblemCode, message: string): StreamProblem {
    const problem = { seq, code, message };
    this.problems.push(problem);
    return problem;
  }

  private async decode(entry: {
    seq: number;
    kind: string;
    occurredAt: Date;
    payload: Uint8Array;
  }): Promise<ReadEntry> {
    const base = {
      seq: entry.seq,
      kind: entry.kind,
      occurredAt: entry.occurredAt,
      payload: entry.payload,
    };
    const text = Buffer.from(entry.payload).toString("utf8");
    const failed = (code: StreamProblemCode, message: string): ReadEntry => ({
      ...base,
      decoded: null,
      problem: this.problem(entry.seq, code, message),
    });

    if (entry.kind === SPACE_KEY_KIND) {
      const envelope = parseJson(spaceKeyEnvelopeSchema, text);
      if (!envelope) return failed("malformed", "a Space key that is not in the expected form");
      await this.openWithMasterKey(envelope);
      return { ...base, decoded: { kind: SPACE_KEY_KIND, envelope } };
    }
    if (entry.kind === KEY_RECIPIENTS_KIND) {
      const envelope = parseJson(keyRecipientsEnvelopeSchema, text);
      if (!envelope) return failed("malformed", "an owner key that is not in the expected form");
      await this.openWithIdentities(envelope);
      return { ...base, decoded: { kind: KEY_RECIPIENTS_KIND, envelope } };
    }
    if (!KNOWN_KINDS.has(entry.kind)) {
      return { ...base, decoded: { kind: "unknown", entryKind: entry.kind } };
    }

    const keyId = ciphertextKeyId(text);
    if (!keyId) return failed("malformed", "a sealed entry that is not in the sealed form");
    const key = await this.keyFor(keyId);
    if (!key) {
      const why = this.closed.get(keyId);
      return failed(
        "key",
        why
          ? `Space key ${keyId} cannot be opened: ${why}`
          : `sealed under Space key ${keyId}, which the stream never opened`,
      );
    }
    let plain: string;
    try {
      plain = decryptText(key, entryLocation(this.stream, entry.seq), text);
    } catch (error) {
      if (!(error instanceof ContentDecryptionError)) throw error;
      return failed("unreadable", OPEN_FAILED);
    }

    const value = parseJsonValue(plain);
    const stub = parseValue(omittedRecordSchema, value);
    if (stub) return { ...base, decoded: { kind: "omitted", entryKind: entry.kind, record: stub } };
    const decoded = decodeRecord(entry.kind, value);
    return decoded
      ? { ...base, decoded }
      : failed("malformed", `a ${entry.kind} entry that does not say what it should`);
  }

  /**
   * The Space key `keyId`: from what the stream has announced so far, else from the database,
   * else from what it announces later. A stream announces a key to a new owner after the entries
   * that key sealed, since nothing in it can be rewritten, so the rest of the stream is read once
   * for announcements when an entry needs a key that nothing before it opened.
   */
  private async keyFor(keyId: string): Promise<DataKey | undefined> {
    const opened = this.opened.get(keyId);
    if (opened) return opened;
    if (this.access.known) {
      try {
        const known = await this.access.known(keyId);
        if (known) {
          this.opened.set(keyId, known);
          return known;
        }
      } catch (error) {
        this.closed.set(keyId, error instanceof Error ? error.message : String(error));
      }
    }
    if (!this.scanned) await this.scanAhead();
    return this.opened.get(keyId);
  }

  /** Opens every Space key announced after the entry being read, without decoding anything else. */
  private async scanAhead(): Promise<void> {
    this.scanned = true;
    let after = this.position;
    for (;;) {
      const page = await this.provider.read(
        { stream: this.stream, after, limit: Math.max(this.pageSize, DEFAULT_PAGE_SIZE) },
        deadlineSignal(READ_TIMEOUT_MS, this.signal),
      );
      if (!page.entries.length) return;
      for (const entry of page.entries) {
        after = entry.seq;
        const text = Buffer.from(entry.payload).toString("utf8");
        if (entry.kind === SPACE_KEY_KIND) {
          const envelope = parseJson(spaceKeyEnvelopeSchema, text);
          if (envelope) await this.openWithMasterKey(envelope);
        } else if (entry.kind === KEY_RECIPIENTS_KIND) {
          const envelope = parseJson(keyRecipientsEnvelopeSchema, text);
          if (envelope) await this.openWithIdentities(envelope);
        }
      }
      if (page.head && after >= page.head.seq) return;
    }
  }

  private async openWithMasterKey(envelope: SpaceKeyEnvelope): Promise<void> {
    if (this.opened.has(envelope.id)) return;
    const { keyProvider } = this.access;
    if (!keyProvider) {
      this.closed.set(envelope.id, "it is wrapped by a master key, and none was given");
      return;
    }
    try {
      const key = await keyProvider.unwrap(envelope, {
        spaceId: envelope.spaceId,
        version: envelope.version,
      });
      this.opened.set(envelope.id, {
        id: envelope.id,
        spaceId: envelope.spaceId,
        version: envelope.version,
        key,
      });
    } catch (error) {
      this.closed.set(envelope.id, error instanceof Error ? error.message : String(error));
    }
  }

  private async openWithIdentities(envelope: KeyRecipientsEnvelope): Promise<void> {
    if (this.opened.has(envelope.keyId)) return;
    const identities = this.access.identities ?? [];
    const key = await unwrapKeyWithIdentities(envelope.age, identities);
    if (key && key.id === envelope.keyId) {
      this.opened.set(key.id, key);
      this.closed.delete(key.id);
      return;
    }
    this.closed.set(
      envelope.keyId,
      identities.length
        ? "none of the identities you gave opens it"
        : "it is sealed to its owner's keys; give an identity",
    );
  }
}

const KNOWN_KINDS = new Set([STREAM_OPENED_KIND, MEMORY_REVISION_KIND, AUDIT_EVENT_KIND]);

function decodeRecord(kind: string, value: unknown): DecodedRecord | null {
  if (kind === STREAM_OPENED_KIND) {
    const header = parseValue(streamHeaderSchema, value);
    return header && { kind, header };
  }
  if (kind === MEMORY_REVISION_KIND) {
    const record = parseValue(memoryRevisionRecordSchema, value);
    // A revision holds its content or says why it does not; one that does neither is not trusted.
    return record && (record.content !== undefined || record.contentOmitted)
      ? { kind, record }
      : null;
  }
  const record = parseValue(auditEventRecordSchema, value);
  return record && { kind: AUDIT_EVENT_KIND, record };
}

function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseValue<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseJson<T extends z.ZodType>(schema: T, text: string): z.infer<T> | null {
  return parseValue(schema, parseJsonValue(text));
}

export interface LedgerStreamInfo {
  stream: string;
  head: RecordLedgerHead | null;
  /** The ledger holds the stream but cannot read it back. */
  unreadable: boolean;
  /** Who the stream is for, when its header opened. */
  header: StreamHeader | null;
  problems: StreamProblem[];
}

/**
 * Every stream the ledger holds, with who each is for. Opening a header needs a key that opens
 * the stream, so one that none does is listed with its problems and no name.
 */
export async function* listLedgerStreams(
  provider: RecordLedgerProvider,
  keys: LedgerKeys,
  signal: AbortSignal,
): AsyncGenerator<LedgerStreamInfo> {
  let after: string | undefined;
  do {
    const page = await provider.list(
      { after, limit: DEFAULT_PAGE_SIZE },
      deadlineSignal(READ_TIMEOUT_MS, signal),
    );
    for (const summary of page.streams) {
      // Only the first few entries are wanted, so only a few are asked for.
      const reader = new LedgerStreamReader(
        provider,
        keys,
        summary.stream,
        signal,
        HEADER_SEARCH_ENTRIES,
      );
      let header: StreamHeader | null = null;
      if (!summary.unreadable) {
        for await (const entry of reader.entries()) {
          if (entry.decoded?.kind === STREAM_OPENED_KIND) header = entry.decoded.header;
          if (header || entry.seq >= HEADER_SEARCH_ENTRIES) break;
        }
      }
      yield {
        stream: summary.stream,
        head: summary.head,
        unreadable: summary.unreadable,
        header,
        problems: reader.problems,
      };
    }
    after = page.next ?? undefined;
  } while (after);
}

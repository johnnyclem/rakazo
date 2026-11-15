import type { AdapterDescriptor } from "./types.js";

/** One sealed record at its place in a stream. */
export interface RecordLedgerEntry {
  /** 1-based and contiguous within the stream. */
  seq: number;
  /** A short dotted label such as `memory.revision`. Sent in the clear. */
  kind: string;
  /** When the recorded thing happened. Sent in the clear. */
  occurredAt: Date;
  /** Sealed bytes. A provider stores them and never reads them. */
  payload: Uint8Array;
}

/** Where a stream ends in the ledger. */
export interface RecordLedgerHead {
  seq: number;
  /** The provider's own tamper-evident digest of the stream up to `seq`. */
  digest: string;
}

export interface RecordLedgerAppendRequest {
  /** Opaque stream id: lowercase letters and digits, at most 64 characters. */
  stream: string;
  /** Consecutive entries, oldest first. */
  entries: readonly RecordLedgerEntry[];
}

export interface RecordLedgerCapabilities {
  /** Runs without the network; only the emulator. */
  offline: boolean;
  /** The largest payload one entry may carry. */
  maxEntryBytes: number;
  /** The most entries, and the most payload bytes in total, one append may carry. */
  maxBatchEntries: number;
  maxBatchBytes: number;
}

/**
 * An append-only store outside this deployment that keeps each stream in order and makes
 * rewriting it detectable. Product code seals every payload before it gets here. Core runs
 * with none configured.
 */
export interface RecordLedgerProvider {
  describe(): AdapterDescriptor<RecordLedgerCapabilities>;
  /**
   * Appends `entries` to the stream. Entries the stream already holds are accepted when
   * they are identical, so a caller that never saw the answer sends the same entries again.
   * Throws `RecordLedgerConflict` when the stream cannot take them, and
   * `RecordLedgerUnavailable` when nothing is known to have been stored.
   */
  append(request: RecordLedgerAppendRequest, signal: AbortSignal): Promise<RecordLedgerHead>;
}

/**
 * The stream cannot take the entries. `gap`: they start past the stream's end, and `head`
 * says where it ends. `conflict`: the stream already holds a different entry at one of
 * those positions.
 */
export class RecordLedgerConflict extends Error {
  override readonly name = "RecordLedgerConflict";
  constructor(
    readonly reason: "gap" | "conflict",
    readonly head: RecordLedgerHead | null,
  ) {
    super(
      reason === "gap"
        ? "The record ledger is behind these entries."
        : "The record ledger holds a different entry.",
    );
  }
}

/**
 * The ledger refused the credential, was unreachable, or failed. Nothing is known to have
 * been stored, so callers send the same entries again later.
 */
export class RecordLedgerUnavailable extends Error {
  override readonly name = "RecordLedgerUnavailable";
  constructor(
    readonly reason: "credential" | "rejected" | "unavailable",
    options?: { cause?: unknown },
  ) {
    super(
      reason === "credential"
        ? "The record ledger refused the credential."
        : reason === "rejected"
          ? "The record ledger rejected the request."
          : "The record ledger is unavailable.",
      options,
    );
  }
}

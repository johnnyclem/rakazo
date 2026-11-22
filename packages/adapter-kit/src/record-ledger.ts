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

export interface RecordLedgerReadRequest {
  stream: string;
  /** Read the entries after this position; 0 reads from the start. */
  after: number;
  /** At most this many; the provider may return fewer. */
  limit: number;
}

export interface RecordLedgerReadResult {
  /** Consecutive from `after + 1`, oldest first. Empty when the stream has nothing past `after`. */
  entries: RecordLedgerEntry[];
  /** Where the stream ends now; null when the ledger holds no such stream. */
  head: RecordLedgerHead | null;
}

export interface RecordLedgerListRequest {
  /** Continue after this stream id; omit to start from the first. */
  after?: string;
  limit: number;
}

export interface RecordLedgerStreamSummary {
  stream: string;
  head: RecordLedgerHead | null;
  /** The provider holds the stream but cannot read it back. */
  unreadable: boolean;
}

export interface RecordLedgerListResult {
  streams: RecordLedgerStreamSummary[];
  /** Pass as `after` for the next page; null at the end. */
  next: string | null;
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

/** Why a stream's off-site copy is behind: the owner has not allowed the ledger to write there, or something failed. */
export type RecordLedgerAnchorError = "not_allowed" | "failed";

/** Where one stream's off-site copy is kept, and how far it has got. */
export interface RecordLedgerAnchorStatus {
  /** The place it is kept now; null when it is kept wherever the ledger keeps its own. */
  destination: string | null;
  /** How many entries are there, and how many the stream has. */
  anchoredSeq: number;
  headSeq: number;
  error: RecordLedgerAnchorError | null;
}

/**
 * What an owner may name as the place their stream's off-site copy is kept is not a usable one.
 * The message is for the owner to read.
 */
export class RecordLedgerDestinationInvalid extends Error {
  override readonly name = "RecordLedgerDestinationInvalid";
}

/**
 * A ledger that can keep a stream's off-site copy somewhere its owner holds, so that nobody who
 * runs the ledger, or this deployment, controls it. A destination is a string only the provider
 * understands; core passes it through and shows the provider's own label for it.
 */
export interface RecordLedgerAnchoring {
  /** What the provider calls such a place, for a person to read. */
  readonly label: string;
  /** The identity the ledger writes as: what an owner has to allow at the place they keep the copy. */
  writer(signal: AbortSignal): Promise<string>;
  /** Throws `RecordLedgerDestinationInvalid` unless `destination` could be a place. Needs no network. */
  validate(destination: string): void;
  /**
   * Keeps `stream`'s off-site copy at `destination` from now on, or with null back where the ledger
   * keeps its own. What was kept before stays where it is. Throws `RecordLedgerUnavailable` when
   * the ledger cannot be reached or does not take it.
   */
  setDestination(stream: string, destination: string | null, signal: AbortSignal): Promise<void>;
  /** Where `stream` is kept and how far it has got; null when the ledger holds neither. */
  status(stream: string, signal: AbortSignal): Promise<RecordLedgerAnchorStatus | null>;
}

/** How far making a place for an owner has got. */
export type RecordLedgerProvisionState = "pending" | "ready" | "failed";

export interface RecordLedgerProvisionSnapshot {
  state: RecordLedgerProvisionState;
  /** The place, once it is ready; usable as a destination. */
  destination: string | null;
  /** Why it stopped, for operators to read. Never shown to people. */
  error: string | null;
}

/** Why the ledger will not make a place for this owner or this request. */
export type RecordLedgerProvisionRefusal = "invalid_owner" | "key_conflict" | "limit_reached";

/** The ledger turned a request for a place down; the message is for operators. */
export class RecordLedgerProvisionRefused extends Error {
  override readonly name = "RecordLedgerProvisionRefused";
  constructor(
    readonly reason: RecordLedgerProvisionRefusal,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A ledger that can make a place for an owner to keep their stream's off-site copy, and hand it
 * over, so the owner holds it from the start and nobody who runs the ledger can take it back. The
 * owner is an Ed25519 public key: the private half stays with them. The place that comes back is
 * a destination for `RecordLedgerAnchoring`.
 */
export interface RecordLedgerProvisioning {
  /** The kind of key an owner holds. */
  readonly ownerKey: "ed25519";
  /** Whether the ledger can make a place now; false when it was not set up to. */
  available(signal: AbortSignal): Promise<boolean>;
  /**
   * Starts making a place for `ownerKey`, or says where an earlier request under `key` has got to.
   * Safe to repeat: one key never makes two places, and a request that failed is picked up again.
   * Throws `RecordLedgerProvisionRefused` for a request it will not serve and
   * `RecordLedgerUnavailable` when it cannot be reached.
   */
  begin(key: string, ownerKey: string, signal: AbortSignal): Promise<RecordLedgerProvisionSnapshot>;
}

/**
 * An append-only store outside this deployment that keeps each stream in order and makes
 * rewriting it detectable. Product code seals every payload before it gets here. Core runs
 * with none configured.
 */
export interface RecordLedgerProvider {
  describe(): AdapterDescriptor<RecordLedgerCapabilities>;
  /** Present when owners can name where their streams' off-site copy is kept. */
  readonly anchoring?: RecordLedgerAnchoring;
  /** Present when it can also make that place for an owner who has none. */
  readonly provisioning?: RecordLedgerProvisioning;
  /**
   * Appends `entries` to the stream. Entries the stream already holds are accepted when
   * they are identical, so a caller that never saw the answer sends the same entries again.
   * Throws `RecordLedgerConflict` when the stream cannot take them, and
   * `RecordLedgerUnavailable` when nothing is known to have been stored.
   */
  append(request: RecordLedgerAppendRequest, signal: AbortSignal): Promise<RecordLedgerHead>;
  /**
   * Reads entries back, so a stream can be rebuilt after the deployment that wrote it is gone.
   * Throws `RecordLedgerUnavailable` when the ledger cannot be reached or refuses the credential.
   */
  read(request: RecordLedgerReadRequest, signal: AbortSignal): Promise<RecordLedgerReadResult>;
  /** The streams the ledger holds, in a stable order, a page at a time. */
  list(request: RecordLedgerListRequest, signal: AbortSignal): Promise<RecordLedgerListResult>;
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

import { createHash } from "node:crypto";
import type {
  RecordLedgerAnchoring,
  RecordLedgerAnchorStatus,
  RecordLedgerAppendRequest,
  RecordLedgerEntry,
  RecordLedgerHead,
  RecordLedgerListRequest,
  RecordLedgerListResult,
  RecordLedgerProvider,
  RecordLedgerProvisioning,
  RecordLedgerProvisionSnapshot,
  RecordLedgerReadRequest,
  RecordLedgerReadResult,
} from "@rakazo/adapter-kit";
import {
  RecordLedgerConflict,
  RecordLedgerDestinationInvalid,
  RecordLedgerProvisionRefused,
  RecordLedgerUnavailable,
} from "@rakazo/adapter-kit";

interface StoredEntry {
  kind: string;
  occurredAt: number;
  payload: Uint8Array;
  digest: string;
}

/** Offline ledger for tests and local runs: every stream lives in this process's memory. */
export class RecordLedgerEmulator implements RecordLedgerProvider {
  readonly streams = new Map<string, StoredEntry[]>();
  /** While set, every append fails as if the ledger were down. */
  unavailable = false;
  /** Where each stream that names a place is kept. */
  readonly destinations = new Map<string, string>();
  /** What each request for a place has asked for and how far it has got, by key. */
  readonly provisions = new Map<
    string,
    {
      ownerKey: string;
      state: RecordLedgerProvisionSnapshot["state"];
      destination: string | null;
      /** The owner pays for it. */
      paid: boolean;
    }
  >();
  /** What `begin` was asked, in order, so a test can see a request was repeated rather than redone. */
  readonly provisionCalls: Array<{ key: string; ownerKey: string }> = [];
  /** Whether it can make places at all; off, as a ledger that was not set up to. */
  canProvision = true;
  /** While set, a request that is made fails. */
  failProvisions = false;
  /** The most places it will make; refuses past it. */
  provisionLimit = Number.POSITIVE_INFINITY;
  /** Whether it sells places to owners who pay; off, as a ledger that was not set up to. */
  canSell = false;
  /** What a place costs when it is sold. */
  price = 1.5;
  /** How much has been sent for each request that is paid for, by key. */
  readonly sent = new Map<string, number>();
  /** Places that have not allowed the ledger to write yet. */
  readonly notAllowed = new Set<string>();
  /** How far each stream is kept at each place: `<destination>\n<stream>` to a count. */
  private readonly kept = new Map<string, number>();

  /** Lets what the ledger holds reach the places it has been told about, as a pass of anchoring would. */
  anchorNow(): void {
    for (const [stream, destination] of this.destinations) {
      if (this.notAllowed.has(destination)) continue;
      this.kept.set(`${destination}\n${stream}`, this.streams.get(stream)?.length ?? 0);
    }
  }

  readonly anchoring: RecordLedgerAnchoring = {
    label: "Place",
    writer: async () => "emulator-writer",
    validate: (destination) => {
      if (!/^[a-z0-9-]{5,63}$/.test(destination)) {
        throw new RecordLedgerDestinationInvalid("Not a place the emulator can keep things at");
      }
    },
    setDestination: async (stream, destination, signal) => {
      signal.throwIfAborted();
      if (this.unavailable) throw new RecordLedgerUnavailable("unavailable");
      if (destination === null) this.destinations.delete(stream);
      else this.destinations.set(stream, destination);
    },
    status: async (stream, signal): Promise<RecordLedgerAnchorStatus | null> => {
      signal.throwIfAborted();
      if (this.unavailable) throw new RecordLedgerUnavailable("unavailable");
      const destination = this.destinations.get(stream) ?? null;
      const headSeq = this.streams.get(stream)?.length ?? 0;
      if (!destination && headSeq === 0) return null;
      return {
        destination,
        anchoredSeq: destination ? (this.kept.get(`${destination}\n${stream}`) ?? 0) : 0,
        headSeq,
        error: destination && this.notAllowed.has(destination) ? "not_allowed" : null,
      };
    },
  };

  /** Sends `amount` toward a request that is paid for, as its owner would from their own wallet. */
  pay(key: string, amount: number): void {
    this.sent.set(key, (this.sent.get(key) ?? 0) + amount);
  }

  /** What is still to be paid for a request, or null when it is free or has been paid. */
  private due(key: string): RecordLedgerProvisionSnapshot["payment"] {
    const provision = this.provisions.get(key);
    if (!provision?.paid) return null;
    const missing = this.price - (this.sent.get(key) ?? 0);
    if (missing <= 0) return null;
    return {
      asset: "TEST",
      amount: String(this.price),
      shortfall: String(missing),
      address: `pay-${key}`,
    };
  }

  /** Finishes every request that is still being made, as the ledger would given a moment. */
  completeProvisions(): void {
    for (const [key, provision] of this.provisions) {
      // A request waiting for its payment is not being made yet.
      if (provision.state === "pending" && !this.due(key)) {
        this.provisions.set(key, {
          ...provision,
          state: "ready",
          destination: `place-${this.provisions.size}x${key.length}`,
        });
      }
    }
  }

  readonly provisioning: RecordLedgerProvisioning = {
    ownerKey: "ed25519",
    available: async (signal) => {
      signal.throwIfAborted();
      if (this.unavailable) throw new RecordLedgerUnavailable("unavailable");
      return this.canProvision;
    },
    sale: {
      available: async (signal) => {
        signal.throwIfAborted();
        if (this.unavailable) throw new RecordLedgerUnavailable("unavailable");
        return this.canSell;
      },
    },
    begin: async (key, ownerKey, signal, options): Promise<RecordLedgerProvisionSnapshot> => {
      signal.throwIfAborted();
      if (this.unavailable) throw new RecordLedgerUnavailable("unavailable");
      this.provisionCalls.push({ key, ownerKey });
      // A ledger that does not sell has no way to ask for payment.
      if (options?.paid && !this.canSell) throw new RecordLedgerUnavailable("rejected");
      if (!/^[A-Za-z0-9_-]{43}$/.test(ownerKey)) {
        throw new RecordLedgerProvisionRefused("invalid_owner", "Not an Ed25519 public key");
      }
      const existing = this.provisions.get(key);
      if (existing && existing.ownerKey !== ownerKey) {
        throw new RecordLedgerProvisionRefused(
          "key_conflict",
          "That key was used for another owner",
        );
      }
      if (!existing && this.provisions.size >= this.provisionLimit) {
        throw new RecordLedgerProvisionRefused("limit_reached", "As many places as it may make");
      }
      if (existing?.state === "failed" && !this.failProvisions) {
        this.provisions.set(key, { ...existing, state: "pending" });
      } else if (!existing) {
        this.provisions.set(key, {
          ownerKey,
          state: this.failProvisions ? "failed" : "pending",
          destination: null,
          paid: options?.paid === true,
        });
      }
      const now = this.provisions.get(key)!;
      return {
        state: now.state,
        destination: now.destination,
        error: now.state === "failed" ? "could not be made" : null,
        payment: this.due(key),
      };
    },
  };

  describe() {
    return {
      id: "emulator",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        offline: true,
        maxEntryBytes: 256 * 1024,
        maxBatchEntries: 100,
        maxBatchBytes: 2 * 1024 * 1024,
      },
    };
  }

  async append(request: RecordLedgerAppendRequest, signal: AbortSignal): Promise<RecordLedgerHead> {
    signal.throwIfAborted();
    if (this.unavailable) throw new RecordLedgerUnavailable("unavailable");
    const stored = this.streams.get(request.stream) ?? [];
    const first = request.entries[0];
    const consecutive = request.entries.every((entry, index) => entry.seq === first!.seq + index);
    if (!first || !consecutive || first.seq > stored.length + 1) {
      throw new RecordLedgerConflict("gap", headOf(stored));
    }
    const resent = request.entries.filter((entry) => entry.seq <= stored.length);
    if (resent.some((entry) => !sameEntry(stored[entry.seq - 1]!, entry))) {
      throw new RecordLedgerConflict("conflict", headOf(stored));
    }
    for (const entry of request.entries.slice(resent.length)) {
      const previous = stored.at(-1)?.digest ?? "";
      stored.push({
        kind: entry.kind,
        occurredAt: entry.occurredAt.getTime(),
        payload: Uint8Array.from(entry.payload),
        digest: createHash("sha256")
          .update(`${previous}\n${entry.seq}\n${entry.kind}\n${entry.occurredAt.toISOString()}\n`)
          .update(entry.payload)
          .digest("hex"),
      });
    }
    this.streams.set(request.stream, stored);
    return headOf(stored)!;
  }

  async read(
    request: RecordLedgerReadRequest,
    signal: AbortSignal,
  ): Promise<RecordLedgerReadResult> {
    signal.throwIfAborted();
    if (this.unavailable) throw new RecordLedgerUnavailable("unavailable");
    const stored = this.streams.get(request.stream) ?? [];
    return {
      entries: stored.slice(request.after, request.after + request.limit).map((entry, index) => ({
        seq: request.after + index + 1,
        kind: entry.kind,
        occurredAt: new Date(entry.occurredAt),
        payload: Uint8Array.from(entry.payload),
      })),
      head: headOf(stored),
    };
  }

  async list(
    request: RecordLedgerListRequest,
    signal: AbortSignal,
  ): Promise<RecordLedgerListResult> {
    signal.throwIfAborted();
    if (this.unavailable) throw new RecordLedgerUnavailable("unavailable");
    const ids = [...this.streams.keys()].sort().filter((id) => id > (request.after ?? ""));
    const page = ids.slice(0, request.limit);
    return {
      streams: page.map((stream) => ({
        stream,
        head: headOf(this.streams.get(stream)!),
        unreadable: false,
      })),
      next: ids.length > request.limit ? page.at(-1)! : null,
    };
  }
}

function headOf(stored: StoredEntry[]): RecordLedgerHead | null {
  const last = stored.at(-1);
  return last ? { seq: stored.length, digest: last.digest } : null;
}

function sameEntry(stored: StoredEntry, entry: RecordLedgerEntry): boolean {
  return (
    stored.kind === entry.kind &&
    stored.occurredAt === entry.occurredAt.getTime() &&
    Buffer.from(stored.payload).equals(Buffer.from(entry.payload))
  );
}

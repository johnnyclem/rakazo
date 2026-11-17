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
  RecordLedgerReadRequest,
  RecordLedgerReadResult,
} from "@rakazo/adapter-kit";
import {
  RecordLedgerConflict,
  RecordLedgerDestinationInvalid,
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

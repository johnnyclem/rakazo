import { createHash } from "node:crypto";
import type {
  RecordLedgerAppendRequest,
  RecordLedgerEntry,
  RecordLedgerHead,
  RecordLedgerProvider,
} from "@rakazo/adapter-kit";
import { RecordLedgerConflict, RecordLedgerUnavailable } from "@rakazo/adapter-kit";

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

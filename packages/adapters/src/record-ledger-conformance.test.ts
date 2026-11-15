import { createHash } from "node:crypto";
import type { RecordLedgerEntry, RecordLedgerProvider } from "@rakazo/adapter-kit";
import { RecordLedgerConflict } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { AgentVaultRecordLedger } from "./agentvault-record-ledger.js";
import { RecordLedgerEmulator } from "./record-ledger-emulator.js";

const signal = new AbortController().signal;

function entry(seq: number, text = `record ${seq}`): RecordLedgerEntry {
  return {
    seq,
    kind: "memory.revision",
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
    payload: new TextEncoder().encode(text),
  };
}

type WireEntry = { seq: number; kind: string; at: string; payload: string; hash: string };

/** The gateway's append route, in memory: what a ledger gateway answers, without the network. */
function gatewayWire(): typeof fetch {
  const streams = new Map<string, WireEntry[]>();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const stream = /\/v1\/streams\/([^/]+)\/entries$/.exec(new URL(String(input)).pathname)?.[1];
    if (!stream || init?.method !== "POST") return json(404, { error: "not_found" });
    const stored = streams.get(stream) ?? [];
    const last = stored.at(-1);
    const head = last ? { seq: last.seq, hash: last.hash } : null;
    const sent = (JSON.parse(String(init.body)) as { entries: Omit<WireEntry, "hash">[] }).entries;
    const first = sent[0]!;
    if (sent.some((item, index) => item.seq !== first.seq + index) || first.seq > stored.length + 1)
      return json(409, { error: "gap", head });
    const resent = sent.filter((item) => item.seq <= stored.length);
    const differs = (item: Omit<WireEntry, "hash">) => {
      const kept = stored[item.seq - 1]!;
      return kept.kind !== item.kind || kept.at !== item.at || kept.payload !== item.payload;
    };
    if (resent.some(differs)) return json(409, { error: "conflict", head });
    for (const item of sent.slice(resent.length)) {
      const previous = stored.at(-1)?.hash ?? "0".repeat(64);
      const hash = createHash("sha256")
        .update([stream, item.seq, previous, item.kind, item.at, item.payload].join("\n"))
        .digest("hex");
      stored.push({ ...item, hash });
    }
    streams.set(stream, stored);
    const end = stored.at(-1)!;
    return json(200, { head: { seq: end.seq, hash: end.hash }, appended: sent.length });
  }) as typeof fetch;
}

const providers: Array<[string, () => RecordLedgerProvider]> = [
  ["emulator", () => new RecordLedgerEmulator()],
  [
    "agentvault (offline wire)",
    () =>
      new AgentVaultRecordLedger({
        baseUrl: "https://ledger.example.test",
        token: "fake-token",
        fetch: gatewayWire(),
      }),
  ],
];

async function conflict(attempt: Promise<unknown>): Promise<RecordLedgerConflict> {
  const error = await attempt.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(RecordLedgerConflict);
  return error as RecordLedgerConflict;
}

describe.each(providers)("record ledger provider conformance: %s", (_name, create) => {
  it("appends consecutive entries and reports where the stream ends", async () => {
    const ledger = create();
    const first = await ledger.append({ stream: "stream1", entries: [entry(1), entry(2)] }, signal);
    expect(first.seq).toBe(2);
    expect(first.digest).not.toBe("");
    const second = await ledger.append({ stream: "stream1", entries: [entry(3)] }, signal);
    expect(second.seq).toBe(3);
    expect(second.digest).not.toBe(first.digest);
  });

  it("accepts entries it already holds without storing them twice", async () => {
    const ledger = create();
    const head = await ledger.append({ stream: "stream1", entries: [entry(1), entry(2)] }, signal);
    expect(
      await ledger.append({ stream: "stream1", entries: [entry(1), entry(2)] }, signal),
    ).toEqual(head);
    // A retry that overlaps what was stored and carries on past it.
    const extended = await ledger.append(
      { stream: "stream1", entries: [entry(2), entry(3)] },
      signal,
    );
    expect(extended.seq).toBe(3);
  });

  it("refuses to replace an entry it holds, and leaves the stream as it was", async () => {
    const ledger = create();
    const head = await ledger.append({ stream: "stream1", entries: [entry(1), entry(2)] }, signal);
    const error = await conflict(
      ledger.append({ stream: "stream1", entries: [entry(2, "rewritten"), entry(3)] }, signal),
    );
    expect(error).toMatchObject({ reason: "conflict", head });
    expect(await ledger.append({ stream: "stream1", entries: [entry(2)] }, signal)).toEqual(head);
  });

  it("refuses entries that start past the end of the stream, and says where it ends", async () => {
    const ledger = create();
    expect(
      await conflict(ledger.append({ stream: "stream1", entries: [entry(2)] }, signal)),
    ).toMatchObject({ reason: "gap", head: null });
    const head = await ledger.append({ stream: "stream1", entries: [entry(1)] }, signal);
    expect(
      await conflict(ledger.append({ stream: "stream1", entries: [entry(3)] }, signal)),
    ).toMatchObject({ reason: "gap", head });
  });

  it("keeps streams apart", async () => {
    const ledger = create();
    await ledger.append({ stream: "stream1", entries: [entry(1), entry(2)] }, signal);
    const other = await ledger.append({ stream: "stream2", entries: [entry(1)] }, signal);
    expect(other.seq).toBe(1);
  });

  it("gives a digest that depends on everything before it", async () => {
    const ledger = create();
    const one = await ledger.append(
      { stream: "stream1", entries: [entry(1, "a"), entry(2)] },
      signal,
    );
    const two = await ledger.append(
      { stream: "stream2", entries: [entry(1, "b"), entry(2)] },
      signal,
    );
    expect(one.digest).not.toBe(two.digest);
  });

  it("declares limits a caller can batch within", () => {
    const { capabilities } = create().describe();
    expect(capabilities.maxEntryBytes).toBeGreaterThan(0);
    expect(capabilities.maxBatchEntries).toBeGreaterThan(0);
    expect(capabilities.maxBatchBytes).toBeGreaterThanOrEqual(capabilities.maxEntryBytes);
  });
});

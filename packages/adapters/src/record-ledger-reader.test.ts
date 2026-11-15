import { randomBytes } from "node:crypto";
import type { RecordLedgerEntry, RecordLedgerProvider } from "@rakazo/adapter-kit";
import type { DataKey } from "@rakazo/db";
import { encryptText, LocalKeyProvider } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { RecordLedgerEmulator } from "./record-ledger-emulator.js";
import { entryLocation } from "./record-ledger-format.js";
import type { ReadEntry } from "./record-ledger-reader.js";
import { LedgerStreamReader, listLedgerStreams } from "./record-ledger-reader.js";

const signal = new AbortController().signal;
const STREAM = "stream1";
const at = new Date("2026-01-02T03:04:05.000Z");

const masterA = { id: "a", key: randomBytes(32) };
const masterB = { id: "b", key: randomBytes(32) };
const keysA = new LocalKeyProvider([masterA]);

/** A Space key, wrapped as the database stores it, and the data key itself for sealing. */
async function spaceKey(provider = keysA, spaceId = "space-1", version = 1) {
  const dataKey = randomBytes(32);
  const wrapped = await provider.wrap(dataKey, { spaceId, version });
  const key: DataKey = { id: `key-${spaceId}-${version}`, spaceId, version, key: dataKey };
  const envelope = { type: "space.key", id: key.id, spaceId, version, ...wrapped };
  return { key, envelope };
}

const header = (extra: Record<string, unknown> = {}) => ({
  type: "stream.opened",
  subject: "bot:bot-1",
  spaceId: "space-1",
  botId: "bot-1",
  organizationId: "org-1",
  spaceName: "Support",
  botName: "Researcher",
  openedAt: at.toISOString(),
  ...extra,
});

const revision = (seq: number, extra: Record<string, unknown> = {}) => ({
  type: "memory.revision",
  id: `rev-${seq}`,
  documentId: "doc-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  scope: "bot",
  path: "MEMORY.md",
  revision: seq - 2,
  content: `note ${seq}`,
  sourceRunId: null,
  sourceThreadId: null,
  createdAt: at.toISOString(),
  ...extra,
});

const audit = {
  type: "audit.event",
  id: "audit-1",
  createdAt: at.toISOString(),
  organizationId: "org-1",
  spaceId: "space-1",
  spaceName: "Support",
  actorType: "bot",
  actorId: "bot-1",
  actorLabel: "Researcher",
  action: "tool.call",
  targetType: null,
  targetId: null,
  targetLabel: null,
  outcome: "success",
  runId: null,
  threadId: null,
  ip: null,
  userAgent: null,
  metadata: { tool: "gmail_send" },
};

const clear = (kind: string, value: unknown): RecordLedgerEntry => ({
  seq: 0,
  kind,
  occurredAt: at,
  payload: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
});

const sealed = (
  kind: string,
  key: DataKey,
  value: unknown,
  stream = STREAM,
  seq = 0,
): RecordLedgerEntry => ({
  seq,
  kind,
  occurredAt: at,
  payload: Buffer.from(encryptText(key, entryLocation(stream, seq), JSON.stringify(value))),
});

/** A ledger holding `entries`, numbered from 1 in the order given; a sealed one names its own position. */
async function ledgerOf(
  entries: RecordLedgerEntry[],
  stream = STREAM,
  ledger = new RecordLedgerEmulator(),
) {
  await ledger.append(
    { stream, entries: entries.map((entry, index) => ({ ...entry, seq: index + 1 })) },
    signal,
  );
  return ledger;
}

/** A well-formed stream: key, header, two revisions, an audit event, and a record too large to hold. */
async function wholeStream(provider = keysA, stream = STREAM) {
  const { key, envelope } = await spaceKey(provider);
  const entries = [
    clear("space.key", envelope),
    sealed("stream.opened", key, header(), stream, 2),
    sealed("memory.revision", key, revision(3), stream, 3),
    sealed("memory.revision", key, revision(4), stream, 4),
    sealed("audit.event", key, audit, stream, 5),
    sealed(
      "memory.revision",
      key,
      {
        type: "memory.revision",
        id: "rev-6",
        createdAt: at.toISOString(),
        omitted: { bytes: 9, sha256: "f".repeat(64) },
      },
      stream,
      6,
    ),
  ];
  return { key, envelope, entries, ledger: await ledgerOf(entries, stream) };
}

async function readAll(reader: LedgerStreamReader): Promise<ReadEntry[]> {
  const read: ReadEntry[] = [];
  for await (const entry of reader.entries()) read.push(entry);
  return read;
}

describe("LedgerStreamReader", () => {
  it("opens a stream from the ledger and the master keys alone", async () => {
    const { ledger } = await wholeStream();

    const reader = new LedgerStreamReader(ledger, keysA, STREAM, signal);
    const read = await readAll(reader);

    expect(reader.problems).toEqual([]);
    expect(reader.head?.seq).toBe(6);
    expect(read.map((entry) => [entry.seq, entry.decoded?.kind])).toEqual([
      [1, "space.key"],
      [2, "stream.opened"],
      [3, "memory.revision"],
      [4, "memory.revision"],
      [5, "audit.event"],
      [6, "omitted"],
    ]);
    expect(read[1]!.decoded).toMatchObject({
      header: { subject: "bot:bot-1", botName: "Researcher", spaceName: "Support" },
    });
    expect(read[3]!.decoded).toMatchObject({ record: { content: "note 4", revision: 2 } });
    expect(read[4]!.decoded).toMatchObject({
      record: { action: "tool.call", metadata: { tool: "gmail_send" } },
    });
    expect(read[5]!.decoded).toMatchObject({
      entryKind: "memory.revision",
      record: { omitted: { bytes: 9 } },
    });
    // What the ledger holds is handed back untouched, for keeping a copy of it.
    expect(Buffer.from(read[2]!.payload).toString()).toMatch(/^rkz1:/);
  });

  it("reads a long stream a page at a time, in order", async () => {
    const { key, envelope } = await spaceKey();
    const entries = [
      clear("space.key", envelope),
      sealed("stream.opened", key, header(), STREAM, 2),
      ...[3, 4, 5, 6, 7].map((seq) => sealed("memory.revision", key, revision(seq), STREAM, seq)),
    ];
    const ledger = await ledgerOf(entries);

    const reader = new LedgerStreamReader(ledger, keysA, STREAM, signal, 2);
    const read = await readAll(reader);

    expect(read.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(reader.problems).toEqual([]);
  });

  it("names a master key it does not have, and each entry that needed the key it protects", async () => {
    const { ledger } = await wholeStream();

    const reader = new LedgerStreamReader(ledger, new LocalKeyProvider([masterB]), STREAM, signal);
    const read = await readAll(reader);

    expect(reader.problems[0]).toMatchObject({ seq: 1, code: "key" });
    expect(reader.problems[0]!.message).toMatch(/not configured/);
    expect(reader.problems.slice(1).map((problem) => [problem.seq, problem.code])).toEqual([
      [2, "key"],
      [3, "key"],
      [4, "key"],
      [5, "key"],
      [6, "key"],
    ]);
    expect(read.slice(1).every((entry) => entry.decoded === null)).toBe(true);
  });

  it("refuses an entry moved to another position, or from another stream", async () => {
    const { key, envelope } = await spaceKey();
    const entries = [
      clear("space.key", envelope),
      sealed("stream.opened", key, header(), STREAM, 2),
      // Sealed for position 4 but sitting at 3, and the other way round.
      sealed("memory.revision", key, revision(3), STREAM, 4),
      sealed("memory.revision", key, revision(4), STREAM, 3),
      // Sealed for the same position of a different stream.
      sealed("memory.revision", key, revision(5), "stream2", 5),
      sealed("memory.revision", key, revision(6), STREAM, 6),
    ];

    const reader = new LedgerStreamReader(await ledgerOf(entries), keysA, STREAM, signal);
    const read = await readAll(reader);

    expect(reader.problems.map((problem) => [problem.seq, problem.code])).toEqual([
      [3, "unreadable"],
      [4, "unreadable"],
      [5, "unreadable"],
    ]);
    expect(read.map((entry) => entry.decoded?.kind ?? null)).toEqual([
      "space.key",
      "stream.opened",
      null,
      null,
      null,
      "memory.revision",
    ]);
  });

  it("refuses an entry whose bytes were changed", async () => {
    const { entries } = await wholeStream();
    const bytes = Buffer.from(entries[2]!.payload);
    bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0x01;
    const tampered = await ledgerOf([
      ...entries.slice(0, 2),
      { ...entries[2]!, payload: bytes },
      ...entries.slice(3),
    ]);

    const reader = new LedgerStreamReader(tampered, keysA, STREAM, signal);
    await readAll(reader);

    expect(reader.problems.map((problem) => [problem.seq, problem.code])).toEqual([
      [3, "unreadable"],
    ]);
  });

  it("refuses a Space key whose envelope was altered", async () => {
    const { key, envelope } = await spaceKey();
    // The wrap binds the Space and version, so an envelope claiming another does not open.
    const forged = { ...envelope, spaceId: "space-2" };
    const entries = [clear("space.key", forged), sealed("stream.opened", key, header(), STREAM, 2)];

    const reader = new LedgerStreamReader(await ledgerOf(entries), keysA, STREAM, signal);
    await readAll(reader);

    expect(reader.problems.map((problem) => [problem.seq, problem.code])).toEqual([
      [1, "key"],
      [2, "key"],
    ]);
  });

  it("does not trust an entry that does not say what its kind promises", async () => {
    const { key, envelope } = await spaceKey();
    const entries = [
      clear("space.key", envelope),
      sealed("stream.opened", key, header(), STREAM, 2),
      sealed("memory.revision", key, { type: "memory.revision", id: "x" }, STREAM, 3),
      // Neither its content nor a reason it has none.
      sealed("memory.revision", key, revision(4, { content: undefined }), STREAM, 4),
      sealed("audit.event", key, { type: "audit.event", id: "x" }, STREAM, 5),
      clear("space.key", "{not json"),
    ];

    const reader = new LedgerStreamReader(await ledgerOf(entries), keysA, STREAM, signal);
    await readAll(reader);

    expect(reader.problems.map((problem) => [problem.seq, problem.code])).toEqual([
      [3, "malformed"],
      [4, "malformed"],
      [5, "malformed"],
      [6, "malformed"],
    ]);
  });

  it("keeps an entry of a kind it does not know, without opening it", async () => {
    const { key, envelope } = await spaceKey();
    const entries = [
      clear("space.key", envelope),
      sealed("stream.opened", key, header(), STREAM, 2),
      clear("tool.run", "something a later version wrote"),
    ];

    const reader = new LedgerStreamReader(await ledgerOf(entries), keysA, STREAM, signal);
    const read = await readAll(reader);

    expect(reader.problems).toEqual([]);
    expect(read[2]!.decoded).toEqual({ kind: "unknown", entryKind: "tool.run" });
  });

  it("stops at a gap, and reports a ledger that returns fewer entries than it holds", async () => {
    const { entries } = await wholeStream();
    const served = entries.map((entry, index) => ({ ...entry, seq: index + 1 }));
    const head = { seq: 6, digest: "d" };
    const serving = (answer: RecordLedgerEntry[]) =>
      ({
        read: async (request: { after: number; limit: number }) => ({
          entries: answer.filter((entry) => entry.seq > request.after).slice(0, request.limit),
          head,
        }),
      }) as unknown as RecordLedgerProvider;

    const gap = new LedgerStreamReader(
      serving([served[0]!, served[1]!, served[3]!]),
      keysA,
      STREAM,
      signal,
    );
    expect((await readAll(gap)).map((entry) => entry.seq)).toEqual([1, 2]);
    expect(gap.problems).toEqual([
      { seq: 4, code: "gap", message: "expected entry 3, the ledger returned 4" },
    ]);

    const short = new LedgerStreamReader(serving(served.slice(0, 3)), keysA, STREAM, signal);
    const pages: number[] = [];
    for await (const entry of short.entries()) pages.push(entry.seq);
    expect(pages).toEqual([1, 2, 3]);
    expect(short.problems.at(-1)).toMatchObject({ code: "short" });
  });
});

describe("listLedgerStreams", () => {
  it("says who each stream is for, and lists one the keys do not open without a name", async () => {
    const mine = await wholeStream(keysA, "stream1");
    const keysB = new LocalKeyProvider([masterB]);
    const theirs = await wholeStream(keysB, "stream2");
    const ledger = mine.ledger;
    await ledger.append(
      {
        stream: "stream2",
        entries: theirs.entries.map((entry, index) => ({ ...entry, seq: index + 1 })),
      },
      signal,
    );

    const listed = [];
    for await (const info of listLedgerStreams(ledger, keysA, signal)) listed.push(info);

    expect(listed.map((info) => info.stream)).toEqual(["stream1", "stream2"]);
    expect(listed[0]).toMatchObject({
      head: { seq: 6 },
      unreadable: false,
      header: { subject: "bot:bot-1", botName: "Researcher", spaceName: "Support" },
      problems: [],
    });
    expect(listed[1]).toMatchObject({ header: null, unreadable: false });
    expect(listed[1]!.problems[0]).toMatchObject({ seq: 1, code: "key" });
  });
});

import { randomBytes } from "node:crypto";
import type { RecordLedgerEntry, RecordLedgerProvider } from "@rakazo/adapter-kit";
import type { DataKey } from "@rakazo/db";
import { encryptText, LocalKeyProvider } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { RecordLedgerEmulator } from "./record-ledger-emulator.js";
import { entryLocation } from "./record-ledger-format.js";
import { generateOwnerIdentity, wrapKeyToRecipients } from "./record-ledger-owner-keys.js";
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

    const reader = new LedgerStreamReader(ledger, { keyProvider: keysA }, STREAM, signal);
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

    const reader = new LedgerStreamReader(ledger, { keyProvider: keysA }, STREAM, signal, 2);
    const read = await readAll(reader);

    expect(read.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(reader.problems).toEqual([]);
  });

  it("names a master key it does not have, and each entry that needed the key it protects", async () => {
    const { ledger } = await wholeStream();

    const reader = new LedgerStreamReader(
      ledger,
      { keyProvider: new LocalKeyProvider([masterB]) },
      STREAM,
      signal,
    );
    const read = await readAll(reader);

    // The key's announcement is fine; what is reported is each entry that needed it, with why.
    expect(reader.problems.map((problem) => [problem.seq, problem.code])).toEqual([
      [2, "key"],
      [3, "key"],
      [4, "key"],
      [5, "key"],
      [6, "key"],
    ]);
    expect(reader.problems[0]!.message).toMatch(/cannot be opened: .*not configured/);
    expect(read[0]!.decoded).toMatchObject({ kind: "space.key" });
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

    const reader = new LedgerStreamReader(
      await ledgerOf(entries),
      { keyProvider: keysA },
      STREAM,
      signal,
    );
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

    const reader = new LedgerStreamReader(tampered, { keyProvider: keysA }, STREAM, signal);
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

    const reader = new LedgerStreamReader(
      await ledgerOf(entries),
      { keyProvider: keysA },
      STREAM,
      signal,
    );
    await readAll(reader);

    expect(reader.problems.map((problem) => [problem.seq, problem.code])).toEqual([[2, "key"]]);
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

    const reader = new LedgerStreamReader(
      await ledgerOf(entries),
      { keyProvider: keysA },
      STREAM,
      signal,
    );
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

    const reader = new LedgerStreamReader(
      await ledgerOf(entries),
      { keyProvider: keysA },
      STREAM,
      signal,
    );
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
      { keyProvider: keysA },
      STREAM,
      signal,
    );
    expect((await readAll(gap)).map((entry) => entry.seq)).toEqual([1, 2]);
    expect(gap.problems).toEqual([
      { seq: 4, code: "gap", message: "expected entry 3, the ledger returned 4" },
    ]);

    const short = new LedgerStreamReader(
      serving(served.slice(0, 3)),
      { keyProvider: keysA },
      STREAM,
      signal,
    );
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
    for await (const info of listLedgerStreams(ledger, { keyProvider: keysA }, signal))
      listed.push(info);

    expect(listed.map((info) => info.stream)).toEqual(["stream1", "stream2"]);
    expect(listed[0]).toMatchObject({
      head: { seq: 6 },
      unreadable: false,
      header: { subject: "bot:bot-1", botName: "Researcher", spaceName: "Support" },
      problems: [],
    });
    expect(listed[1]).toMatchObject({ header: null, unreadable: false });
    expect(listed[1]!.problems[0]).toMatchObject({ seq: 2, code: "key" });
  });
});

/** An entry announcing `key` to its owner, as the sealer writes it. */
async function ownerKey(
  key: DataKey,
  recipients: string[],
  keyId = key.id,
): Promise<RecordLedgerEntry> {
  return clear("key.recipients", {
    type: "key.recipients",
    keyId,
    digest: "d".repeat(32),
    age: await wrapKeyToRecipients(key, recipients),
  });
}

describe("a stream sealed to its owner", () => {
  /** [owner key, header, two revisions], sealed under a Space key no master key wraps. */
  async function ownerStream() {
    const owner = await generateOwnerIdentity();
    const { key } = await spaceKey();
    const entries = [
      await ownerKey(key, [owner.recipient]),
      sealed("stream.opened", key, header(), STREAM, 2),
      sealed("memory.revision", key, revision(3), STREAM, 3),
      sealed("memory.revision", key, revision(4), STREAM, 4),
    ];
    return { owner, key, entries, ledger: await ledgerOf(entries) };
  }

  it("opens with the owner's identity alone, no master key at all", async () => {
    const { owner, ledger } = await ownerStream();

    const reader = new LedgerStreamReader(ledger, { identities: [owner.identity] }, STREAM, signal);
    const read = await readAll(reader);

    expect(reader.problems).toEqual([]);
    expect(read.map((entry) => entry.decoded?.kind)).toEqual([
      "key.recipients",
      "stream.opened",
      "memory.revision",
      "memory.revision",
    ]);
    expect(read[3]!.decoded).toMatchObject({ record: { content: "note 4" } });
  });

  it("says it is sealed to its owner when no identity is given, and a master key does not help", async () => {
    const { ledger } = await ownerStream();

    for (const keys of [{}, { keyProvider: keysA }]) {
      const reader = new LedgerStreamReader(ledger, keys, STREAM, signal);
      await readAll(reader);
      expect(reader.problems.map((problem) => [problem.seq, problem.code])).toEqual([
        [2, "key"],
        [3, "key"],
        [4, "key"],
      ]);
      expect(reader.problems[0]!.message).toMatch(/sealed to its owner's keys; give an identity/);
    }
  });

  it("says so when the identity given is not the owner's", async () => {
    const { ledger } = await ownerStream();
    const stranger = await generateOwnerIdentity();

    const reader = new LedgerStreamReader(
      ledger,
      { identities: [stranger.identity] },
      STREAM,
      signal,
    );
    await readAll(reader);

    expect(reader.problems[0]!.message).toMatch(/none of the identities you gave opens it/);
  });

  it("opens a stream announced both ways with either key", async () => {
    const owner = await generateOwnerIdentity();
    const { key, envelope } = await spaceKey();
    const entries = [
      clear("space.key", envelope),
      await ownerKey(key, [owner.recipient]),
      sealed("stream.opened", key, header(), STREAM, 3),
      sealed("memory.revision", key, revision(4), STREAM, 4),
    ];
    const ledger = await ledgerOf(entries);

    for (const keys of [{ keyProvider: keysA }, { identities: [owner.identity] }]) {
      const reader = new LedgerStreamReader(ledger, keys, STREAM, signal);
      await readAll(reader);
      expect(reader.problems).toEqual([]);
    }
  });

  it("opens each key version a stream announced, as the owner holds them all", async () => {
    const owner = await generateOwnerIdentity();
    const first = (await spaceKey(keysA, "space-1", 1)).key;
    const second = (await spaceKey(keysA, "space-1", 2)).key;
    const entries = [
      await ownerKey(first, [owner.recipient]),
      sealed("stream.opened", first, header(), STREAM, 2),
      sealed("memory.revision", first, revision(3), STREAM, 3),
      await ownerKey(second, [owner.recipient]),
      sealed("memory.revision", second, revision(5), STREAM, 5),
    ];

    const reader = new LedgerStreamReader(
      await ledgerOf(entries),
      { identities: [owner.identity] },
      STREAM,
      signal,
    );
    const read = await readAll(reader);

    expect(reader.problems).toEqual([]);
    expect(read.map((entry) => entry.decoded?.kind)).toEqual([
      "key.recipients",
      "stream.opened",
      "memory.revision",
      "key.recipients",
      "memory.revision",
    ]);
  });

  it("opens entries sealed before the stream announced the key to the owner", async () => {
    const owner = await generateOwnerIdentity();
    const { key, envelope } = await spaceKey();
    // Announced to the master key first; the owner is announced to afterwards, as the entries
    // before it cannot be rewritten.
    const entries = [
      clear("space.key", envelope),
      sealed("stream.opened", key, header(), STREAM, 2),
      sealed("memory.revision", key, revision(3), STREAM, 3),
      await ownerKey(key, [owner.recipient]),
      sealed("memory.revision", key, revision(5), STREAM, 5),
    ];
    const ledger = await ledgerOf(entries);

    const reader = new LedgerStreamReader(ledger, { identities: [owner.identity] }, STREAM, signal);
    const read = await readAll(reader);

    expect(reader.problems).toEqual([]);
    expect(read.map((entry) => entry.decoded?.kind)).toEqual([
      "space.key",
      "stream.opened",
      "memory.revision",
      "key.recipients",
      "memory.revision",
    ]);
  });

  it("does not look ahead when the keys came first", async () => {
    const { key, envelope } = await spaceKey();
    const entries = [
      clear("space.key", envelope),
      sealed("stream.opened", key, header(), STREAM, 2),
      sealed("memory.revision", key, revision(3), STREAM, 3),
    ];
    const ledger = await ledgerOf(entries);
    let reads = 0;
    const counting = {
      read: (request: Parameters<typeof ledger.read>[0], on: AbortSignal) => {
        reads += 1;
        return ledger.read(request, on);
      },
    } as unknown as RecordLedgerProvider;

    await readAll(new LedgerStreamReader(counting, { keyProvider: keysA }, STREAM, signal));

    expect(reads).toBe(1);
  });

  it("does not take a key an announcement claims to be, only the one it wraps", async () => {
    const owner = await generateOwnerIdentity();
    const { key } = await spaceKey();
    // An announcement labelled as another key: what it wraps says what it is.
    const entries = [
      await ownerKey(key, [owner.recipient], "some-other-key"),
      sealed("stream.opened", key, header(), STREAM, 2),
    ];

    const reader = new LedgerStreamReader(
      await ledgerOf(entries),
      { identities: [owner.identity] },
      STREAM,
      signal,
    );
    await readAll(reader);

    expect(reader.problems.map((problem) => [problem.seq, problem.code])).toEqual([[2, "key"]]);
  });

  it("falls back to a key the database holds, and says why when it cannot", async () => {
    const { key } = await spaceKey();
    const entries = [
      clear("tool.run", "no announcement of any key"),
      sealed("stream.opened", key, header(), STREAM, 2),
    ];
    const ledger = await ledgerOf(entries);

    const found = new LedgerStreamReader(
      ledger,
      { known: async (id) => (id === key.id ? key : undefined) },
      STREAM,
      signal,
    );
    await readAll(found);
    expect(found.problems).toEqual([]);

    const missing = new LedgerStreamReader(
      ledger,
      { known: async () => undefined },
      STREAM,
      signal,
    );
    await readAll(missing);
    expect(missing.problems[0]!.message).toMatch(/which the stream never opened/);

    const broken = new LedgerStreamReader(
      ledger,
      {
        known: async () => {
          throw new Error("the master key is gone");
        },
      },
      STREAM,
      signal,
    );
    await readAll(broken);
    expect(broken.problems[0]!.message).toMatch(/cannot be opened: the master key is gone/);
  });

  it("lists the stream with who it is for once the identity is given", async () => {
    const { owner, ledger } = await ownerStream();

    const without = [];
    for await (const info of listLedgerStreams(ledger, {}, signal)) without.push(info);
    const withIdentity = [];
    for await (const info of listLedgerStreams(ledger, { identities: [owner.identity] }, signal))
      withIdentity.push(info);

    expect(without[0]).toMatchObject({ header: null });
    expect(withIdentity[0]).toMatchObject({ header: { botName: "Researcher" }, problems: [] });
  });
});

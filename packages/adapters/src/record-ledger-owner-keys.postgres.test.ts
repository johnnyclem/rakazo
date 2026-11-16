import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LedgerFixture } from "./record-ledger.test-support.js";
import { createLedgerFixture } from "./record-ledger.test-support.js";
import { RecordLedgerEmulator } from "./record-ledger-emulator.js";
import {
  generateOwnerIdentity,
  recipientSetDigest,
  unwrapKeyWithIdentities,
} from "./record-ledger-owner-keys.js";
import type { LedgerKeys } from "./record-ledger-reader.js";
import { LedgerStreamReader } from "./record-ledger-reader.js";
import { restoreLedgerStream } from "./record-ledger-restore.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const signal = new AbortController().signal;

describePostgres("record ledger sealed to its owner (PostgreSQL)", () => {
  // Each test has its own Space, and so its own key and its own owner keys.
  let fixture: LedgerFixture;
  let ledger: RecordLedgerEmulator;
  let botId: string;

  const reconcile = () => fixture.reconciler(ledger)();
  const remember = (content: string, path?: string) => fixture.remember(botId, content, { path });
  const streamOf = () => fixture.streamOf(`bot:${botId}`);
  const kinds = async () => (await streamOf())!.entries.map((entry) => entry.kind);

  /** The stream as the ledger holds it, read with only what `keys` gives. */
  async function readWith(keys: LedgerKeys) {
    const reader = new LedgerStreamReader(ledger, keys, (await streamOf())!.id, signal);
    const read = [];
    for await (const entry of reader.entries()) read.push(entry);
    return { read, problems: reader.problems };
  }

  beforeEach(async () => {
    fixture = await createLedgerFixture(databaseUrl!);
    ledger = new RecordLedgerEmulator();
    botId = await fixture.newBot();
  });

  afterEach(async () => fixture?.close());

  it("seals a new stream to the owner's key alone, so only the owner can open it", async () => {
    const owner = await generateOwnerIdentity();
    await fixture.addRecipient(owner.recipient);
    await remember("hello, owner");

    await reconcile();

    const stream = (await streamOf())!;
    expect(stream.entries.map((entry) => entry.kind)).toEqual([
      "key.recipients",
      "stream.opened",
      "memory.revision",
    ]);
    const digest = recipientSetDigest([owner.recipient]);
    expect(JSON.parse(stream.entries[0]!.payload)).toMatchObject({
      type: "key.recipients",
      keyId: stream.keyId,
      digest,
    });
    // Nothing a master key could open is in the stream.
    expect(stream.entries[0]!.payload).not.toMatch(/wrappedKey|masterKeyId/);
    expect(stream).toMatchObject({ recipientsDigest: digest, shippedSeq: 3 });

    const dataKey = await fixture.keys.byId(stream.keyId!);
    const announced = JSON.parse(stream.entries[0]!.payload) as { age: string };
    const opened = await unwrapKeyWithIdentities(announced.age, [owner.identity]);
    expect(Buffer.from(opened!.key).equals(Buffer.from(dataKey.key))).toBe(true);

    // From the ledger and the owner's identity alone: no master key, no database.
    const withIdentity = await readWith({ identities: [owner.identity] });
    expect(withIdentity.problems).toEqual([]);
    expect(withIdentity.read[1]!.decoded).toMatchObject({ header: { botName: "Researcher" } });
    expect(withIdentity.read[2]!.decoded).toMatchObject({ record: { content: "hello, owner" } });

    // The master key opens nothing: that is the point of sealing to the owner.
    const withMaster = await readWith({ keyProvider: fixture.keys.provider });
    expect(withMaster.problems.map((problem) => problem.seq)).toEqual([2, 3]);
    expect(withMaster.problems[0]!.message).toMatch(/sealed to its owner's keys/);
  });

  it("gives an owner key added later the stream it already holds, even when nothing new happens", async () => {
    await remember("written before owner keys");
    await reconcile();
    expect(await kinds()).toEqual(["space.key", "stream.opened", "memory.revision"]);
    const owner = await generateOwnerIdentity();
    await fixture.addRecipient(owner.recipient);

    await reconcile();

    const stream = (await streamOf())!;
    expect(stream.entries.map((entry) => entry.kind)).toEqual([
      "space.key",
      "stream.opened",
      "memory.revision",
      "key.recipients",
    ]);
    expect(stream).toMatchObject({
      sealedSeq: 4,
      shippedSeq: 4,
      recipientsDigest: recipientSetDigest([owner.recipient]),
    });
    // The owner opens what was written before they had a key.
    const read = await readWith({ identities: [owner.identity] });
    expect(read.problems).toEqual([]);
    expect(read.read[2]!.decoded).toMatchObject({
      record: { content: "written before owner keys" },
    });
    // And a pass with nothing to announce adds nothing.
    await reconcile();
    expect((await streamOf())!.entries).toHaveLength(4);
  });

  it("announces every key version when owner keys arrive after the key has rotated", async () => {
    await remember("under the first key");
    await reconcile();
    await fixture.keys.rotate(fixture.spaceId);
    await remember("under the second key");
    await reconcile();
    const owner = await generateOwnerIdentity();
    await fixture.addRecipient(owner.recipient);

    await reconcile();

    expect(await kinds()).toEqual([
      "space.key",
      "stream.opened",
      "memory.revision",
      "space.key",
      "memory.revision",
      "key.recipients",
      "key.recipients",
    ]);
    const read = await readWith({ identities: [owner.identity] });
    expect(read.problems).toEqual([]);
    expect(
      read.read
        .filter((entry) => entry.decoded?.kind === "memory.revision")
        .map((entry) => entry.decoded),
    ).toMatchObject([
      { record: { content: "under the first key" } },
      { record: { content: "under the second key" } },
    ]);
  });

  it("announces a rotated key to the owner", async () => {
    const owner = await generateOwnerIdentity();
    await fixture.addRecipient(owner.recipient);
    await remember("before");
    await reconcile();
    const rotated = await fixture.keys.rotate(fixture.spaceId);

    await remember("after");
    await reconcile();

    const stream = (await streamOf())!;
    expect(stream.entries.map((entry) => entry.kind)).toEqual([
      "key.recipients",
      "stream.opened",
      "memory.revision",
      "key.recipients",
      "memory.revision",
    ]);
    expect(JSON.parse(stream.entries[3]!.payload)).toMatchObject({ keyId: rotated.id });
    expect(stream.keyId).toBe(rotated.id);
    expect((await readWith({ identities: [owner.identity] })).problems).toEqual([]);
  });

  it("gives a second owner key the whole history, so either can open it", async () => {
    const [first, second] = [await generateOwnerIdentity(), await generateOwnerIdentity()];
    await fixture.addRecipient(first.recipient);
    await remember("written for the first key");
    await reconcile();

    await fixture.addRecipient(second.recipient);
    await reconcile();

    const stream = (await streamOf())!;
    expect(stream.recipientsDigest).toBe(recipientSetDigest([first.recipient, second.recipient]));
    expect(stream.entries.map((entry) => entry.kind).at(-1)).toBe("key.recipients");
    for (const owner of [first, second]) {
      const read = await readWith({ identities: [owner.identity] });
      expect(read.problems).toEqual([]);
      expect(read.read[2]!.decoded).toMatchObject({
        record: { content: "written for the first key" },
      });
    }
  });

  it("stops announcing to a removed owner key, and rotating the Space key cuts it off from what follows", async () => {
    const [kept, removed] = [await generateOwnerIdentity(), await generateOwnerIdentity()];
    await fixture.addRecipient(kept.recipient);
    await fixture.addRecipient(removed.recipient);
    await remember("while both held keys");
    await reconcile();

    await fixture.removeRecipient(removed.recipient);
    await reconcile();
    expect((await streamOf())!.recipientsDigest).toBe(recipientSetDigest([kept.recipient]));
    // Removing a key cannot take back a key it already opened: what is under it stays open to it.
    expect((await readWith({ identities: [removed.identity] })).problems).toEqual([]);

    await fixture.keys.rotate(fixture.spaceId);
    await remember("after the rotation");
    await reconcile();

    expect((await readWith({ identities: [kept.identity] })).problems).toEqual([]);
    const cutOff = await readWith({ identities: [removed.identity] });
    expect(cutOff.problems.map((problem) => problem.code)).toEqual(["key"]);
    expect(cutOff.read.at(-1)!.decoded).toBeNull();
  });

  it("goes back to a master key when the last owner key is removed", async () => {
    const owner = await generateOwnerIdentity();
    await fixture.addRecipient(owner.recipient);
    await remember("sealed to the owner");
    await reconcile();

    await fixture.removeRecipient(owner.recipient);
    await reconcile();

    const stream = (await streamOf())!;
    expect(stream.entries.map((entry) => entry.kind).at(-1)).toBe("space.key");
    expect(stream.recipientsDigest).toBeNull();
    expect((await readWith({ keyProvider: fixture.keys.provider })).problems).toEqual([]);
  });

  /** Two revisions of one document, sealed and shipped; then the second revision's row is lost. */
  async function loseTheSecondRevision() {
    const first = await remember("first revision");
    const second = await remember("second revision");
    await reconcile();
    await fixture.prisma.memoryRevision.delete({ where: { id: second.id } });
    await fixture.prisma.memoryDocument.update({
      where: { id: first.documentId },
      data: { content: "first revision", revision: 1 },
    });
    return second;
  }

  const restore = (keys: LedgerKeys, extra: { intoBot?: string } = {}) =>
    streamOf().then((stream) =>
      restoreLedgerStream({
        prisma: fixture.db,
        provider: ledger,
        keys,
        stream: stream!.id,
        signal,
        ...extra,
      }),
    );

  it("restores with the owner's identity alone, with no master key and no database keys", async () => {
    const owner = await generateOwnerIdentity();
    await fixture.addRecipient(owner.recipient);
    const second = await loseTheSecondRevision();

    const report = await restore({ identities: [owner.identity] });

    expect(report).toMatchObject({ memory: { added: 1, existing: 1 }, linked: true, problems: [] });
    expect(
      await fixture.prisma.memoryRevision.findUnique({ where: { id: second.id } }),
    ).toMatchObject({
      content: "second revision",
    });
  });

  it("restores into another bot with the owner's identity alone", async () => {
    const owner = await generateOwnerIdentity();
    await fixture.addRecipient(owner.recipient);
    await loseTheSecondRevision();
    const target = await fixture.newBot("Reborn");

    const report = await restore({ identities: [owner.identity] }, { intoBot: target });

    expect(report).toMatchObject({ memory: { added: 2 }, problems: [] });
    expect(
      await fixture.prisma.memoryDocument.findFirst({
        where: { botId: target, path: "MEMORY.md" },
      }),
    ).toMatchObject({ content: "second revision", revision: 2 });
  });

  it("restores in place from the keys the database holds, when nobody gives it a key", async () => {
    const owner = await generateOwnerIdentity();
    await fixture.addRecipient(owner.recipient);
    await loseTheSecondRevision();

    const unopened = await restore({});
    expect(unopened.skipped).toMatch(/nothing was restored/);
    expect(unopened.problems[0]!.message).toMatch(/sealed to its owner's keys/);

    const report = await restore({ known: (id) => fixture.keys.find(id) });

    expect(report).toMatchObject({ memory: { added: 1 }, linked: true, problems: [] });
  });

  it("warns when a restored database has lost the owner keys a stream is sealed to", async () => {
    const owner = await generateOwnerIdentity();
    await fixture.addRecipient(owner.recipient);
    await loseTheSecondRevision();
    // As a backup older than the owner keys leaves it: the stream remembers them, the Space does not.
    await fixture.prisma.recordLedgerRecipient.deleteMany({ where: { spaceId: fixture.spaceId } });

    const report = await restore({ identities: [owner.identity] });

    expect(report.linked).toBe(true);
    expect(report.warnings.join(" ")).toMatch(/sealed to owner keys the database does not have/);

    // With the keys added back there is nothing to warn about.
    await fixture.addRecipient(owner.recipient);
    expect((await restore({ identities: [owner.identity] })).warnings).toEqual([]);
  });

  it("re-links what a stream announced, so sealing carries on without announcing it again", async () => {
    const owner = await generateOwnerIdentity();
    await fixture.addRecipient(owner.recipient);
    await remember("before the rotation");
    await reconcile();
    const rotated = await fixture.keys.rotate(fixture.spaceId);
    const later = await remember("after the rotation");
    await reconcile();
    const stream = (await streamOf())!;
    expect(stream.entries.map((entry) => entry.kind)).toEqual([
      "key.recipients",
      "stream.opened",
      "memory.revision",
      "key.recipients",
      "memory.revision",
    ]);

    const firstKeyId = (JSON.parse(stream.entries[0]!.payload) as { keyId: string }).keyId;

    // As a backup taken before the rotation leaves it: the rotation's entries and row are gone.
    await fixture.prisma.memoryRevision.delete({ where: { id: later.id } });
    await fixture.prisma.recordLedgerEntry.deleteMany({
      where: { streamId: stream.id, seq: { gt: 3 } },
    });
    await fixture.prisma.recordLedgerStream.update({
      where: { id: stream.id },
      data: { sealedSeq: 3, shippedSeq: 3, keyId: firstKeyId },
    });
    await fixture.prisma.recordLedgerCursor.deleteMany();

    const report = await restore({ identities: [owner.identity] });

    expect(report).toMatchObject({ linked: true, problems: [], warnings: [] });
    expect(await streamOf()).toMatchObject({
      keyId: rotated.id,
      recipientsDigest: recipientSetDigest([owner.recipient]),
      sealedSeq: 5,
    });
    await remember("a new note");
    await reconcile();
    // One new revision, and no second announcement of a key the stream already announced.
    expect(await kinds()).toHaveLength(6);
    expect((await kinds()).at(-1)).toBe("memory.revision");
  });
});

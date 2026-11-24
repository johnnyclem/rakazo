import type { RecordLedgerAppendRequest } from "@rakazo/adapter-kit";
import { RecordLedgerUnavailable } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecordLedgerReconciler } from "./record-ledger.js";
import type { LedgerFixture } from "./record-ledger.test-support.js";
import { createLedgerFixture } from "./record-ledger.test-support.js";
import { RecordLedgerEmulator } from "./record-ledger-emulator.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describe("record ledger reconciler", () => {
  it("refuses to run without the content keys it seals with", () => {
    expect(() =>
      createRecordLedgerReconciler({} as PrismaClient, new RecordLedgerEmulator()),
    ).toThrow(/content keys/);
  });
});

describePostgres("record ledger (PostgreSQL)", () => {
  let fixture: LedgerFixture;
  let ledger: RecordLedgerEmulator;
  let botId: string;

  const reconciler = (provider = ledger) => fixture.reconciler(provider);

  beforeAll(async () => {
    fixture = await createLedgerFixture(databaseUrl!);
  });

  afterAll(async () => fixture?.close());

  beforeEach(async () => {
    ledger = new RecordLedgerEmulator();
    botId = await fixture.newBot();
    // Earlier tests' rows are sealed, so each test sees only what it writes.
    await reconciler(new RecordLedgerEmulator())();
  });

  const remember = (content: string, options?: { shared?: boolean; path?: string }) =>
    fixture.remember(botId, content, options);

  it("seals a bot's memory and actions into its stream, and the rest into the Space's", async () => {
    const first = await remember("Likes pour-over coffee");
    const second = await remember("Likes pour-over coffee, no sugar");
    const shared = await remember("The company is Acme", { shared: true });
    const toolCall = await fixture.audit({
      action: "tool.call",
      actorType: "bot",
      actorId: botId,
    });
    const approval = await fixture.audit({ action: "approval.decided" });
    // Not this Space's record: an account event, and another organization's copy of an event.
    await fixture.audit({ action: "auth.sign_in", spaceId: null });
    await fixture.audit({
      action: "credential.used",
      organizationId: fixture.otherOrganizationId,
    });

    await reconciler()();

    const bot = (await fixture.streamOf(`bot:${botId}`))!;
    expect(fixture.recordsOf(bot.entries).map((entry) => [entry.kind, entry.sourceId])).toEqual([
      ["memory.revision", first.id],
      ["memory.revision", second.id],
      ["audit.event", toolCall.id],
    ]);
    expect(await fixture.open(bot.entries[3]!)).toMatchObject({
      type: "memory.revision",
      id: second.id,
      spaceId: fixture.spaceId,
      userId: fixture.userId,
      botId,
      scope: "bot",
      path: "MEMORY.md",
      revision: 2,
      content: "Likes pour-over coffee, no sugar",
    });
    expect(await fixture.open(bot.entries[4]!)).toMatchObject({
      type: "audit.event",
      id: toolCall.id,
      organizationId: fixture.organizationId,
      action: "tool.call",
    });

    const space = (await fixture.streamOf(`space:${fixture.spaceId}`))!;
    expect(
      fixture
        .recordsOf(space.entries)
        .slice(-2)
        .map((entry) => [entry.kind, entry.sourceId]),
    ).toEqual([
      ["memory.revision", shared.id],
      ["audit.event", approval.id],
    ]);
    expect(space.entries.map((entry) => entry.seq)).toEqual(
      space.entries.map((_, index) => index + 1),
    );

    // The ledger holds every entry, acknowledged, and never a readable word of a record.
    expect(bot).toMatchObject({ sealedSeq: 5, shippedSeq: 5, stoppedAt: null });
    const sent = ledger.streams.get(bot.id)!;
    expect(sent).toHaveLength(5);
    expect(Buffer.from(sent[3]!.payload).toString()).toBe(bot.entries[3]!.payload);
    expect(Buffer.from(sent[3]!.payload).toString()).not.toContain("pour-over");
    expect(bot.shippedDigest).toBe(sent[4]!.digest);
    expect(bot.shippedAt).toBeInstanceOf(Date);
    expect(ledger.streams.get(space.id)).toHaveLength(space.entries.length);
  });

  it("gives a stream what it takes to open it: its Space key, wrapped, and who it is for", async () => {
    await remember("hello");

    await reconciler()();

    const stream = (await fixture.streamOf(`bot:${botId}`))!;
    const [key, header, revision] = stream.entries;
    expect(key).toMatchObject({
      seq: 1,
      kind: "space.key",
      sourceId: `${stream.id}:1`,
    });
    const envelope = JSON.parse(key!.payload) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      type: "space.key",
      id: stream.keyId,
      spaceId: fixture.spaceId,
      version: 1,
    });
    // Only the wrapped form is in the ledger: the key itself never is.
    const dataKey = await fixture.keys.byId(stream.keyId!);
    for (const form of ["base64url", "base64", "hex"] as const) {
      expect(key!.payload).not.toContain(Buffer.from(dataKey.key).toString(form));
    }
    expect(header).toMatchObject({ seq: 2, kind: "stream.opened", sourceId: stream.id });
    expect(await fixture.open(header!)).toMatchObject({
      type: "stream.opened",
      subject: `bot:${botId}`,
      spaceId: fixture.spaceId,
      botId,
      organizationId: fixture.organizationId,
      spaceName: "Support",
      botName: "Researcher",
    });
    expect(revision).toMatchObject({ seq: 3, kind: "memory.revision" });
    // The stream's name says nothing about whose it is.
    expect(stream.id).not.toContain(botId);
    expect(stream.id).not.toContain(fixture.spaceId);
    // The clear entry is sent as it is; the sealed ones are not readable.
    expect(Buffer.from(ledger.streams.get(stream.id)![0]!.payload).toString()).toBe(key!.payload);
    expect(Buffer.from(ledger.streams.get(stream.id)![1]!.payload).toString()).not.toContain(
      "Researcher",
    );
  });

  it("announces the new Space key when it rotates, and the old entries still open", async () => {
    await remember("before");
    await reconciler()();
    const rotated = await fixture.keys.rotate(fixture.spaceId);

    await remember("after");
    await reconciler()();

    const stream = (await fixture.streamOf(`bot:${botId}`))!;
    expect(stream.entries.map((entry) => entry.kind)).toEqual([
      "space.key",
      "stream.opened",
      "memory.revision",
      "space.key",
      "memory.revision",
    ]);
    expect(JSON.parse(stream.entries[3]!.payload)).toMatchObject({
      id: rotated.id,
      version: rotated.version,
    });
    expect(stream.keyId).toBe(rotated.id);
    expect(await fixture.open(stream.entries[2]!)).toMatchObject({ content: "before" });
    expect(await fixture.open(stream.entries[4]!)).toMatchObject({ content: "after" });
  });

  it("seals each row once, however often it runs", async () => {
    await remember("first");
    const reconcile = reconciler();
    await reconcile();
    await reconcile();
    expect(fixture.recordsOf((await fixture.streamOf(`bot:${botId}`))!.entries)).toHaveLength(1);

    const next = await remember("second");
    await reconcile();
    const stream = (await fixture.streamOf(`bot:${botId}`))!;
    expect(stream.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(stream.entries[3]!.sourceId).toBe(next.id);
    expect(ledger.streams.get(stream.id)).toHaveLength(4);
  });

  it("does not seal a row the database already holds an entry for", async () => {
    await remember("already sealed");
    const reconcile = reconciler();
    await reconcile();
    const before = (await fixture.streamOf(`bot:${botId}`))!;
    // As after an in-place restore: the cursor is behind rows that are already in the stream.
    await fixture.prisma.recordLedgerCursor.deleteMany();

    await reconcile();

    const after = (await fixture.streamOf(`bot:${botId}`))!;
    expect(after.entries.map((entry) => entry.id)).toEqual(before.entries.map((entry) => entry.id));
    expect(after).toMatchObject({ sealedSeq: before.sealedSeq, stoppedAt: null });
  });

  it("leaves rows that have not settled for a later pass", async () => {
    await remember("too fresh");
    await createRecordLedgerReconciler(fixture.db, ledger, { settleMs: 60_000 })();
    expect(await fixture.streamOf(`bot:${botId}`)).toBeNull();
    await reconciler()();
    expect((await fixture.streamOf(`bot:${botId}`))!.sealedSeq).toBe(3);
  });

  it("keeps sealing while the ledger is down, and catches up when it is back", async () => {
    ledger.unavailable = true;
    await remember("first");
    const reconcile = reconciler();
    await reconcile();
    await remember("second");
    await reconcile();
    expect(await fixture.streamOf(`bot:${botId}`)).toMatchObject({ sealedSeq: 4, shippedSeq: 0 });

    ledger.unavailable = false;
    await reconcile();
    const stream = (await fixture.streamOf(`bot:${botId}`))!;
    expect(stream).toMatchObject({ sealedSeq: 4, shippedSeq: 4 });
    expect(ledger.streams.get(stream.id)).toHaveLength(4);
  });

  it("sends a stream again to a ledger that lost it", async () => {
    await remember("first");
    await remember("second");
    const reconcile = reconciler();
    await reconcile();
    const before = (await fixture.streamOf(`bot:${botId}`))!;
    expect(before.shippedSeq).toBe(4);

    ledger.streams.clear();
    await remember("third");
    await reconcile();

    const stream = (await fixture.streamOf(`bot:${botId}`))!;
    expect(stream).toMatchObject({ sealedSeq: 5, shippedSeq: 5, stoppedAt: null });
    expect(
      ledger.streams.get(stream.id)!.map((entry) => Buffer.from(entry.payload).toString()),
    ).toEqual(stream.entries.map((entry) => entry.payload));
  });

  it("stops a stream the ledger disagrees with, and keeps shipping the others", async () => {
    ledger.unavailable = true;
    await remember("the real first entry");
    const reconcile = reconciler();
    await reconcile();
    const sealed = (await fixture.streamOf(`bot:${botId}`))!;
    ledger.unavailable = false;
    // The ledger already holds something else at this stream's first position.
    await ledger.append(
      {
        stream: sealed.id,
        entries: [
          {
            seq: 1,
            kind: "space.key",
            occurredAt: new Date(0),
            payload: new TextEncoder().encode("someone else's entry"),
          },
        ],
      },
      new AbortController().signal,
    );
    await remember("shared, and unaffected", { shared: true });

    await reconcile();

    const stopped = (await fixture.streamOf(`bot:${botId}`))!;
    expect(stopped.shippedSeq).toBe(0);
    expect(stopped.stoppedAt).toBeInstanceOf(Date);
    const space = (await fixture.streamOf(`space:${fixture.spaceId}`))!;
    expect(space.shippedSeq).toBe(space.sealedSeq);

    // A stopped stream still seals, and is not sent again until someone clears it.
    const appends: RecordLedgerAppendRequest[] = [];
    const append = ledger.append.bind(ledger);
    ledger.append = (request, signal) => {
      appends.push(request);
      return append(request, signal);
    };
    await remember("sealed while stopped");
    await reconcile();
    expect(await fixture.streamOf(`bot:${botId}`)).toMatchObject({ sealedSeq: 4, shippedSeq: 0 });
    expect(appends.map((request) => request.stream)).not.toContain(sealed.id);
  });

  it("records a memory too large for the ledger by its size and digest", async () => {
    class SmallLedger extends RecordLedgerEmulator {
      override describe() {
        const described = super.describe();
        return { ...described, capabilities: { ...described.capabilities, maxEntryBytes: 2_000 } };
      }
    }
    const small = new SmallLedger();
    const content = "long note ".repeat(1_000);
    const revision = await remember(content, { path: "notes.md" });

    await reconciler(small)();

    const stream = (await fixture.streamOf(`bot:${botId}`))!;
    const record = await fixture.open(fixture.recordsOf(stream.entries)[0]!);
    expect(record).toMatchObject({
      type: "memory.revision",
      id: revision.id,
      path: "notes.md",
      contentOmitted: { bytes: content.length },
    });
    expect(record).not.toHaveProperty("content");
    expect(small.streams.get(stream.id)).toHaveLength(3);
  });

  it("keeps a record that cannot fit in its place as a stub, and carries on", async () => {
    class TinyLedger extends RecordLedgerEmulator {
      override describe() {
        const described = super.describe();
        return { ...described, capabilities: { ...described.capabilities, maxEntryBytes: 600 } };
      }
    }
    const tiny = new TinyLedger();
    const big = await remember("a note ".repeat(200), { path: "big.md" });
    const next = await fixture.audit({ action: "tool.call", actorType: "bot", actorId: botId });

    await reconciler(tiny)();

    const stream = (await fixture.streamOf(`bot:${botId}`))!;
    expect(fixture.recordsOf(stream.entries).map((entry) => [entry.seq, entry.sourceId])).toEqual([
      [3, big.id],
      [4, next.id],
    ]);
    const stub = await fixture.open(stream.entries[2]!);
    expect(stub).toMatchObject({
      type: "memory.revision",
      id: big.id,
      omitted: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(stub).not.toHaveProperty("content");
    expect(tiny.streams.get(stream.id)).toHaveLength(4);
  });

  it("stops a stream the ledger rejects as malformed, and does not ask again", async () => {
    let asked = 0;
    class Rejecting extends RecordLedgerEmulator {
      override async append(): Promise<never> {
        asked += 1;
        throw new RecordLedgerUnavailable("rejected");
      }
    }
    await remember("first");
    const reconcile = reconciler(new Rejecting());

    await reconcile();
    await reconcile();

    expect(await fixture.streamOf(`bot:${botId}`)).toMatchObject({
      sealedSeq: 3,
      shippedSeq: 0,
      stoppedAt: expect.any(Date),
    });
    expect(asked).toBe(1);
  });

  it("drops a bot's stream with the bot", async () => {
    await remember("soon forgotten");
    await reconciler()();
    const stream = (await fixture.streamOf(`bot:${botId}`))!;
    await fixture.prisma.bot.delete({ where: { id: botId } });
    expect(await fixture.streamOf(`bot:${botId}`)).toBeNull();
    expect(await fixture.prisma.recordLedgerEntry.count({ where: { streamId: stream.id } })).toBe(
      0,
    );
  });
});

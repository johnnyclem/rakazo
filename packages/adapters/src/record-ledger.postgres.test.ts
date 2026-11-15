import type { RecordLedgerAppendRequest } from "@rakazo/adapter-kit";
import { RecordLedgerUnavailable } from "@rakazo/adapter-kit";
import type { ContentKeyRing, PrismaClient } from "@rakazo/db";
import { asSystem, ciphertextKeyId, createDb, decryptText } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecordLedgerReconciler } from "./record-ledger.js";
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
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `ledger-org-${suffix}`;
  const otherOrganizationId = `${organizationId}-other`;
  const spaceId = `ledger-space-${suffix}`;
  const userId = `ledger-user-${suffix}`;
  let db: PrismaClient;
  let prisma: PrismaClient;
  let keys: ContentKeyRing;
  let close: () => Promise<void>;
  let ledger: RecordLedgerEmulator;
  let botId: string;
  let bots = 0;

  /** Every row already written counts as settled. */
  const reconciler = (provider = ledger) =>
    createRecordLedgerReconciler(db, provider, {
      settleMs: 0,
      now: () => new Date(Date.now() + 5_000),
    });

  beforeAll(async () => {
    const created = createDb(databaseUrl!, { encryptContent: true });
    db = created.prisma;
    prisma = asSystem(db);
    keys = created.contentKeys;
    close = async () => {
      await prisma.organization.deleteMany({
        where: { id: { in: [organizationId, otherOrganizationId] } },
      });
      await db.$disconnect();
      await created.pool.end();
    };
    for (const id of [organizationId, otherOrganizationId]) {
      await prisma.organization.create({
        data: { id, name: "Acme", slug: id, createdAt: new Date() },
      });
    }
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Support" } });
  });

  afterAll(async () => close?.());

  beforeEach(async () => {
    ledger = new RecordLedgerEmulator();
    bots += 1;
    botId = `ledger-bot-${suffix}-${bots}`;
    await prisma.bot.create({
      data: { id: botId, spaceId, userId, name: "Researcher", color: "ink" },
    });
    // Earlier tests' rows are sealed, so each test sees only what it writes.
    await reconciler(new RecordLedgerEmulator())();
  });

  async function remember(content: string, options: { shared?: boolean; path?: string } = {}) {
    const where = {
      spaceId,
      scope: options.shared ? "user" : "bot",
      botId: options.shared ? null : botId,
      path: options.path ?? "MEMORY.md",
    };
    const existing = await prisma.memoryDocument.findFirst({ where });
    const document = existing
      ? await prisma.memoryDocument.update({
          where: { id: existing.id },
          data: { content, revision: existing.revision + 1 },
        })
      : await prisma.memoryDocument.create({ data: { ...where, userId, content } });
    return prisma.memoryRevision.create({
      data: { documentId: document.id, revision: document.revision, content },
    });
  }

  function audit(data: {
    action: string;
    actorType?: string;
    actorId?: string;
    organizationId?: string;
    spaceId?: string | null;
  }) {
    return prisma.auditEvent.create({
      data: {
        organizationId,
        spaceId,
        actorType: "user",
        actorId: userId,
        outcome: "success",
        ...data,
      },
    });
  }

  const streamOf = (subject: string) =>
    prisma.recordLedgerStream.findUnique({
      where: { subject },
      include: { entries: { orderBy: { seq: "asc" } } },
    });

  /** What a sealed entry says, opened with the Space's key as its owner would. */
  async function open(entry: { id: string; streamId: string; payload: string }) {
    const key = await keys.byId(ciphertextKeyId(entry.payload)!);
    const location = {
      table: "record_ledger_entries",
      column: "payload",
      rowId: entry.id,
      owner: entry.streamId,
    };
    return JSON.parse(decryptText(key, location, entry.payload)) as Record<string, unknown>;
  }

  it("seals a bot's memory and actions into its stream, and the rest into the Space's", async () => {
    const first = await remember("Likes pour-over coffee");
    const second = await remember("Likes pour-over coffee, no sugar");
    const shared = await remember("The company is Acme", { shared: true });
    const toolCall = await audit({ action: "tool.call", actorType: "bot", actorId: botId });
    const approval = await audit({ action: "approval.decided" });
    // Not this Space's record: an account event, and another organization's copy of an event.
    await audit({ action: "auth.sign_in", spaceId: null });
    await audit({ action: "credential.used", organizationId: otherOrganizationId });

    await reconciler()();

    const bot = (await streamOf(`bot:${botId}`))!;
    expect(bot.entries.map((entry) => [entry.seq, entry.kind, entry.sourceId])).toEqual([
      [1, "memory.revision", first.id],
      [2, "memory.revision", second.id],
      [3, "audit.event", toolCall.id],
    ]);
    expect(await open(bot.entries[1]!)).toMatchObject({
      type: "memory.revision",
      id: second.id,
      scope: "bot",
      path: "MEMORY.md",
      revision: 2,
      content: "Likes pour-over coffee, no sugar",
    });
    expect(await open(bot.entries[2]!)).toMatchObject({
      type: "audit.event",
      id: toolCall.id,
      action: "tool.call",
    });

    const space = (await streamOf(`space:${spaceId}`))!;
    expect(space.entries.slice(-2).map((entry) => [entry.kind, entry.sourceId])).toEqual([
      ["memory.revision", shared.id],
      ["audit.event", approval.id],
    ]);
    expect(space.entries.map((entry) => entry.seq)).toEqual(
      space.entries.map((_, index) => index + 1),
    );

    // The ledger holds every entry, acknowledged, and never a readable word of it.
    expect(bot).toMatchObject({ sealedSeq: 3, shippedSeq: 3, stoppedAt: null });
    const sent = ledger.streams.get(bot.id)!;
    expect(sent).toHaveLength(3);
    expect(Buffer.from(sent[1]!.payload).toString()).toBe(bot.entries[1]!.payload);
    expect(Buffer.from(sent[1]!.payload).toString()).not.toContain("pour-over");
    expect(bot.shippedDigest).toBe(sent[2]!.digest);
    expect(bot.shippedAt).toBeInstanceOf(Date);
    expect(ledger.streams.get(space.id)).toHaveLength(space.entries.length);
  });

  it("seals each row once, however often it runs", async () => {
    await remember("first");
    const reconcile = reconciler();
    await reconcile();
    await reconcile();
    expect((await streamOf(`bot:${botId}`))!.entries).toHaveLength(1);

    const next = await remember("second");
    await reconcile();
    const stream = (await streamOf(`bot:${botId}`))!;
    expect(stream.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(stream.entries[1]!.sourceId).toBe(next.id);
    expect(ledger.streams.get(stream.id)).toHaveLength(2);
  });

  it("leaves rows that have not settled for a later pass", async () => {
    await remember("too fresh");
    await createRecordLedgerReconciler(db, ledger, { settleMs: 60_000 })();
    expect(await streamOf(`bot:${botId}`)).toBeNull();
    await reconciler()();
    expect((await streamOf(`bot:${botId}`))!.sealedSeq).toBe(1);
  });

  it("keeps sealing while the ledger is down, and catches up when it is back", async () => {
    ledger.unavailable = true;
    await remember("first");
    const reconcile = reconciler();
    await reconcile();
    await remember("second");
    await reconcile();
    expect(await streamOf(`bot:${botId}`)).toMatchObject({ sealedSeq: 2, shippedSeq: 0 });

    ledger.unavailable = false;
    await reconcile();
    const stream = (await streamOf(`bot:${botId}`))!;
    expect(stream).toMatchObject({ sealedSeq: 2, shippedSeq: 2 });
    expect(ledger.streams.get(stream.id)).toHaveLength(2);
  });

  it("sends a stream again to a ledger that lost it", async () => {
    await remember("first");
    await remember("second");
    const reconcile = reconciler();
    await reconcile();
    const before = (await streamOf(`bot:${botId}`))!;
    expect(before.shippedSeq).toBe(2);

    ledger.streams.clear();
    await remember("third");
    await reconcile();

    const stream = (await streamOf(`bot:${botId}`))!;
    expect(stream).toMatchObject({ sealedSeq: 3, shippedSeq: 3, stoppedAt: null });
    expect(
      ledger.streams.get(stream.id)!.map((entry) => Buffer.from(entry.payload).toString()),
    ).toEqual(stream.entries.map((entry) => entry.payload));
  });

  it("stops a stream the ledger disagrees with, and keeps shipping the others", async () => {
    ledger.unavailable = true;
    await remember("the real first entry");
    const reconcile = reconciler();
    await reconcile();
    const sealed = (await streamOf(`bot:${botId}`))!;
    ledger.unavailable = false;
    // The ledger already holds something else at this stream's first position.
    await ledger.append(
      {
        stream: sealed.id,
        entries: [
          {
            seq: 1,
            kind: "memory.revision",
            occurredAt: new Date(0),
            payload: new TextEncoder().encode("someone else's entry"),
          },
        ],
      },
      new AbortController().signal,
    );
    await remember("shared, and unaffected", { shared: true });

    await reconcile();

    const stopped = (await streamOf(`bot:${botId}`))!;
    expect(stopped.shippedSeq).toBe(0);
    expect(stopped.stoppedAt).toBeInstanceOf(Date);
    const space = (await streamOf(`space:${spaceId}`))!;
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
    expect(await streamOf(`bot:${botId}`)).toMatchObject({ sealedSeq: 2, shippedSeq: 0 });
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

    const stream = (await streamOf(`bot:${botId}`))!;
    const record = await open(stream.entries[0]!);
    expect(record).toMatchObject({
      type: "memory.revision",
      id: revision.id,
      path: "notes.md",
      contentOmitted: { bytes: content.length },
    });
    expect(record).not.toHaveProperty("content");
    expect(small.streams.get(stream.id)).toHaveLength(1);
  });

  it("keeps a record that cannot fit in its place as a stub, and carries on", async () => {
    class TinyLedger extends RecordLedgerEmulator {
      override describe() {
        const described = super.describe();
        return { ...described, capabilities: { ...described.capabilities, maxEntryBytes: 400 } };
      }
    }
    const tiny = new TinyLedger();
    const big = await remember("a note ".repeat(200), { path: "big.md" });
    const next = await audit({ action: "tool.call", actorType: "bot", actorId: botId });

    await reconciler(tiny)();

    const stream = (await streamOf(`bot:${botId}`))!;
    expect(stream.entries.map((entry) => [entry.seq, entry.sourceId])).toEqual([
      [1, big.id],
      [2, next.id],
    ]);
    const stub = await open(stream.entries[0]!);
    expect(stub).toMatchObject({
      type: "memory.revision",
      id: big.id,
      omitted: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(stub).not.toHaveProperty("content");
    expect(tiny.streams.get(stream.id)).toHaveLength(2);
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

    expect(await streamOf(`bot:${botId}`)).toMatchObject({
      sealedSeq: 1,
      shippedSeq: 0,
      stoppedAt: expect.any(Date),
    });
    expect(asked).toBe(1);
  });

  it("drops a bot's stream with the bot", async () => {
    await remember("soon forgotten");
    await reconciler()();
    const stream = (await streamOf(`bot:${botId}`))!;
    await prisma.bot.delete({ where: { id: botId } });
    expect(await streamOf(`bot:${botId}`)).toBeNull();
    expect(await prisma.recordLedgerEntry.count({ where: { streamId: stream.id } })).toBe(0);
  });
});

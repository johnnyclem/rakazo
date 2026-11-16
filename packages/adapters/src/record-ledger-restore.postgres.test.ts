import { encryptText, LocalKeyProvider, masterKeysFromEnv } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LedgerFixture } from "./record-ledger.test-support.js";
import { createLedgerFixture } from "./record-ledger.test-support.js";
import { RecordLedgerEmulator } from "./record-ledger-emulator.js";
import { entryLocation } from "./record-ledger-format.js";
import { restoreLedgerStream } from "./record-ledger-restore.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const signal = new AbortController().signal;

describePostgres("record ledger restore (PostgreSQL)", () => {
  let fixture: LedgerFixture;
  let ledger: RecordLedgerEmulator;
  let botId: string;

  const reconcile = () => fixture.reconciler(ledger)();
  const remember = (content: string, options?: { shared?: boolean; path?: string }) =>
    fixture.remember(botId, content, options);
  const streamOf = () => fixture.streamOf(`bot:${botId}`);

  const restore = async (
    options: Partial<Parameters<typeof restoreLedgerStream>[0]> & { stream?: string } = {},
  ) =>
    restoreLedgerStream({
      prisma: fixture.db,
      provider: ledger,
      keyProvider: fixture.keys.provider,
      stream: options.stream ?? (await streamOf())!.id,
      signal,
      ...options,
    });

  beforeAll(async () => {
    fixture = await createLedgerFixture(databaseUrl!);
  });

  afterAll(async () => fixture?.close());

  beforeEach(async () => {
    ledger = new RecordLedgerEmulator();
    botId = await fixture.newBot();
    // Earlier tests' rows are sealed, so each test sees only what it writes.
    await fixture.reconciler(new RecordLedgerEmulator())();
  });

  /** A bot with two documents and an action, all sealed and shipped to the ledger. */
  async function seed() {
    const first = await remember("v1: likes coffee");
    const second = await remember("v2: likes coffee, no sugar");
    const notes = await remember("tea at 80C", { path: "notes.md" });
    const action = await fixture.audit({ action: "tool.call", actorType: "bot", actorId: botId });
    await reconcile();
    return { first, second, notes, action };
  }

  /**
   * The database as a backup taken after the first revision would leave it: the later rows and
   * their ledger entries gone, and the stream's counts as they were then.
   */
  async function rollBack(seeded: Awaited<ReturnType<typeof seed>>) {
    const { prisma } = fixture;
    const stream = (await streamOf())!;
    await prisma.memoryRevision.deleteMany({
      where: { id: { in: [seeded.second.id, seeded.notes.id] } },
    });
    await prisma.memoryDocument.deleteMany({ where: { id: seeded.notes.documentId } });
    await prisma.memoryDocument.update({
      where: { id: seeded.first.documentId },
      data: { content: "v1: likes coffee", revision: 1 },
    });
    await prisma.auditEvent.delete({ where: { id: seeded.action.id } });
    await prisma.recordLedgerEntry.deleteMany({ where: { streamId: stream.id, seq: { gt: 3 } } });
    await prisma.recordLedgerStream.update({
      where: { id: stream.id },
      data: { sealedSeq: 3, shippedSeq: 3, shippedDigest: null },
    });
    await prisma.recordLedgerCursor.deleteMany();
  }

  it("restores what a database brought back from an older backup lacks, and sealing carries on after it", async () => {
    const seeded = await seed();
    const stream = (await streamOf())!;
    expect(ledger.streams.get(stream.id)).toHaveLength(6);
    await rollBack(seeded);

    const report = await restore();

    expect(report).toMatchObject({
      subject: `bot:${botId}`,
      entries: 6,
      memory: { added: 2, existing: 1, omitted: 0, conflicts: [] },
      audit: { added: 1, existing: 0, foreign: 0 },
      linked: true,
      problems: [],
      warnings: [],
    });
    expect(report.skipped).toBeUndefined();

    const { prisma } = fixture;
    const document = (await prisma.memoryDocument.findUnique({
      where: { id: seeded.first.documentId },
    }))!;
    expect(document).toMatchObject({ content: "v2: likes coffee, no sugar", revision: 2, botId });
    // The restored rows are the rows the ledger recorded, under their own ids.
    expect(
      await prisma.memoryRevision.findUnique({ where: { id: seeded.second.id } }),
    ).toMatchObject({
      documentId: document.id,
      revision: 2,
      content: "v2: likes coffee, no sugar",
    });
    expect(
      await prisma.memoryDocument.findUnique({ where: { id: seeded.notes.documentId } }),
    ).toMatchObject({
      path: "notes.md",
      content: "tea at 80C",
      botId,
    });
    expect(await prisma.auditEvent.findUnique({ where: { id: seeded.action.id } })).toMatchObject({
      action: "tool.call",
      actorId: botId,
    });

    // The database's own record of the stream again matches the ledger's, entry for entry.
    const relinked = (await streamOf())!;
    const sent = ledger.streams.get(relinked.id)!;
    expect(relinked).toMatchObject({
      sealedSeq: 6,
      shippedSeq: 6,
      shippedDigest: sent.at(-1)!.digest,
      stoppedAt: null,
    });
    expect(relinked.entries.map((entry) => entry.payload)).toEqual(
      sent.map((entry) => Buffer.from(entry.payload).toString()),
    );

    // New activity continues the stream. Nothing restored is sealed a second time.
    await remember("v3: now prefers tea");
    await reconcile();
    const after = (await streamOf())!;
    expect(after).toMatchObject({ sealedSeq: 7, shippedSeq: 7, stoppedAt: null });
    expect(ledger.streams.get(after.id)).toHaveLength(7);
    expect(fixture.recordsOf(after.entries).map((entry) => entry.kind)).toEqual([
      "memory.revision",
      "memory.revision",
      "memory.revision",
      "audit.event",
      "memory.revision",
    ]);
  });

  it("changes nothing the second time", async () => {
    const seeded = await seed();
    await rollBack(seeded);
    await restore();

    const again = await restore();

    expect(again).toMatchObject({
      memory: { added: 0, existing: 3, conflicts: [] },
      audit: { added: 0, existing: 1 },
      linked: true,
      problems: [],
    });
    expect(
      await fixture.prisma.memoryRevision.count({ where: { documentId: seeded.first.documentId } }),
    ).toBe(2);
    expect((await streamOf())!.entries).toHaveLength(6);
  });

  it("never overwrites a revision the database holds differently", async () => {
    const seeded = await seed();
    await fixture.prisma.memoryRevision.update({
      where: { id: seeded.second.id },
      data: { content: "changed here since" },
    });

    const report = await restore();

    expect(report.memory).toMatchObject({
      added: 0,
      existing: 2,
      conflicts: [{ path: "MEMORY.md", revision: 2 }],
    });
    expect(
      await fixture.prisma.memoryRevision.findUnique({ where: { id: seeded.second.id } }),
    ).toMatchObject({
      content: "changed here since",
    });
    expect(report.linked).toBe(true);
  });

  it("restores a bot's memory into another bot in another Space, as new revisions its own stream records", async () => {
    const seeded = await seed();
    const { prisma } = fixture;
    const spaceId = `${fixture.spaceId}-new`;
    await prisma.space.create({
      data: { id: spaceId, organizationId: fixture.organizationId, name: "Fresh" },
    });
    const target = `${botId}-new`;
    await prisma.bot.create({
      data: { id: target, spaceId, userId: `${fixture.userId}-new`, name: "Reborn", color: "ink" },
    });
    const original = (await streamOf())!;

    const report = await restore({ intoBot: target });

    expect(report).toMatchObject({
      subject: `bot:${botId}`,
      memory: { added: 3, existing: 0, conflicts: [] },
      // An audit event is the original organization's record, so it is never copied.
      audit: { added: 0, existing: 0, foreign: 0 },
      linked: false,
      problems: [],
    });
    const documents = await prisma.memoryDocument.findMany({
      where: { botId: target },
      orderBy: { path: "asc" },
    });
    expect(
      documents.map((document) => [document.path, document.content, document.revision]),
    ).toEqual([
      ["MEMORY.md", "v2: likes coffee, no sugar", 2],
      ["notes.md", "tea at 80C", 1],
    ]);
    expect(
      documents.every(
        (document) => document.spaceId === spaceId && document.userId === `${fixture.userId}-new`,
      ),
    ).toBe(true);
    // New rows with new ids: the original bot's are untouched, and its stream with them.
    expect(documents.map((document) => document.id)).not.toContain(seeded.first.documentId);
    const revisions = await prisma.memoryRevision.findMany({
      where: { documentId: documents[0]!.id },
      orderBy: { revision: "asc" },
    });
    expect(revisions.map((revision) => revision.content)).toEqual([
      "v1: likes coffee",
      "v2: likes coffee, no sugar",
    ]);
    expect(revisions.map((revision) => revision.id)).not.toContain(seeded.second.id);
    expect(await streamOf()).toMatchObject({ id: original.id, sealedSeq: 6 });

    // They are ordinary new memory in the new bot, so its own stream records them under its Space's key.
    await reconcile();
    const reborn = (await fixture.streamOf(`bot:${target}`))!;
    expect(reborn.keyId).not.toBe(original.keyId);
    const records = await Promise.all(
      fixture.recordsOf(reborn.entries).map((entry) => fixture.open(entry)),
    );
    expect(records.map((record) => record.content).sort()).toEqual(
      ["tea at 80C", "v1: likes coffee", "v2: likes coffee, no sugar"].sort(),
    );
  });

  it("refuses a stream with an entry that does not open, and restores nothing unless told to skip it", async () => {
    const seeded = await seed();
    await rollBack(seeded);
    const stream = (await streamOf())!;
    const stored = ledger.streams.get(stream.id)!;
    // Entry 5 (the notes revision) was altered in the ledger.
    stored[4]!.payload[stored[4]!.payload.length - 3]! ^= 0x01;

    const refused = await restore();

    expect(refused.skipped).toMatch(/nothing was restored/);
    expect(refused.problems).toMatchObject([{ seq: 5, code: "unreadable" }]);
    expect(refused.memory.added).toBe(0);
    expect(
      await fixture.prisma.memoryDocument.findUnique({ where: { id: seeded.first.documentId } }),
    ).toMatchObject({ revision: 1 });
    expect(
      await fixture.prisma.auditEvent.findUnique({ where: { id: seeded.action.id } }),
    ).toBeNull();

    const partial = await restore({ skipUnreadable: true });

    expect(partial).toMatchObject({
      memory: { added: 1, existing: 1 },
      audit: { added: 1 },
      linked: false,
      problems: [{ seq: 5, code: "unreadable" }],
    });
    expect(partial.warnings.join(" ")).toMatch(/did not open/);
    expect(
      await fixture.prisma.memoryDocument.findUnique({ where: { id: seeded.notes.documentId } }),
    ).toBeNull();
    // What was linked is consistent: no entry past the end of the stream's own count.
    const relinked = (await streamOf())!;
    expect(relinked.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(relinked.sealedSeq).toBe(4);
  });

  it("says which master key is missing, and writes nothing", async () => {
    const seeded = await seed();
    await rollBack(seeded);
    const stream = (await streamOf())!;

    const report = await restore({
      keyProvider: new LocalKeyProvider([{ id: "other", key: new Uint8Array(32).fill(7) }]),
    });

    expect(report.skipped).toMatch(/nothing was restored/);
    expect(report.problems[0]).toMatchObject({ seq: 1, code: "key" });
    expect(report.problems[0]!.message).toMatch(/not configured/);
    expect(await streamOf()).toMatchObject({ id: stream.id, sealedSeq: 3 });
    expect(
      await fixture.prisma.memoryRevision.findUnique({ where: { id: seeded.second.id } }),
    ).toBeNull();
  });

  it("opens the ledger with the master keys alone, and writes nothing on a dry run", async () => {
    const seeded = await seed();
    await rollBack(seeded);

    // The keys come from the environment, not from the database.
    const report = await restore({
      keyProvider: new LocalKeyProvider(masterKeysFromEnv()),
      dryRun: true,
    });

    expect(report).toMatchObject({
      memory: { added: 2, existing: 1 },
      audit: { added: 1 },
      linked: false,
      problems: [],
    });
    expect(
      await fixture.prisma.memoryRevision.findUnique({ where: { id: seeded.second.id } }),
    ).toBeNull();
    expect(
      await fixture.prisma.auditEvent.findUnique({ where: { id: seeded.action.id } }),
    ).toBeNull();
    expect(await streamOf()).toMatchObject({ sealedSeq: 3, shippedSeq: 3 });
  });

  it("does not re-link a stream when the database already has another one for the same bot", async () => {
    await seed();
    const stream = (await streamOf())!;
    await fixture.prisma.recordLedgerStream.delete({ where: { id: stream.id } });
    const other = await fixture.prisma.recordLedgerStream.create({
      data: { id: `other-${stream.id}`, subject: `bot:${botId}`, spaceId: fixture.spaceId, botId },
    });

    const report = await restore({ stream: stream.id });

    expect(report.linked).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/different stream/);
    expect(report.memory.existing).toBe(3);
    expect(await streamOf()).toMatchObject({ id: other.id, sealedSeq: 0 });
  });

  it("does not re-link a stream whose entries differ from the ledger's", async () => {
    await seed();
    const stream = (await streamOf())!;
    await fixture.prisma.recordLedgerEntry.update({
      where: { streamId_seq: { streamId: stream.id, seq: 4 } },
      data: { payload: "rkz1:not-what-the-ledger-holds" },
    });
    await fixture.prisma.recordLedgerStream.update({
      where: { id: stream.id },
      data: { stoppedAt: new Date() },
    });

    const report = await restore();

    expect(report.linked).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/entry 4 for this stream differs/);
    // The stream stays stopped for a person to look at, rather than being set going again.
    expect((await streamOf())!.stoppedAt).toBeInstanceOf(Date);
  });

  it("warns that the ledger may have lost entries, and sends them again", async () => {
    await seed();
    const stream = (await streamOf())!;
    ledger.streams.get(stream.id)!.length = 4;

    const report = await restore();

    expect(report.head?.seq).toBe(4);
    expect(report.warnings.join(" ")).toMatch(/believed the ledger held 6 entries, but it holds 4/);
    expect(report.linked).toBe(true);
    expect(await streamOf()).toMatchObject({ sealedSeq: 6, shippedSeq: 4 });

    await reconcile();
    expect(ledger.streams.get(stream.id)).toHaveLength(6);
    expect(await streamOf()).toMatchObject({ shippedSeq: 6, stoppedAt: null });
  });

  it("restores the Space's shared memory and audit trail from its own stream", async () => {
    const path = `shared-${botId}.md`;
    const shared = await remember("The company is Acme", { shared: true, path });
    const event = await fixture.audit({ action: "approval.decided" });
    await reconcile();
    const stream = (await fixture.streamOf(`space:${fixture.spaceId}`))!;
    await fixture.prisma.memoryRevision.delete({ where: { id: shared.id } });
    await fixture.prisma.memoryDocument.delete({ where: { id: shared.documentId } });
    await fixture.prisma.auditEvent.delete({ where: { id: event.id } });

    const report = await restore({ stream: stream.id });

    expect(report).toMatchObject({
      subject: `space:${fixture.spaceId}`,
      audit: { added: 1 },
      linked: true,
      problems: [],
    });
    expect(report.memory.added).toBeGreaterThanOrEqual(1);
    expect(
      await fixture.prisma.memoryDocument.findUnique({ where: { id: shared.documentId } }),
    ).toMatchObject({
      scope: "user",
      botId: null,
      userId: fixture.userId,
      content: "The company is Acme",
    });
    expect(await fixture.prisma.auditEvent.findUnique({ where: { id: event.id } })).toMatchObject({
      action: "approval.decided",
    });
  });

  it("leaves out a record that names another bot or Space than the stream it is in", async () => {
    await seed();
    const stream = (await streamOf())!;
    const stored = ledger.streams.get(stream.id)!;
    const key = await fixture.keys.byId(stream.keyId!);
    const other = await fixture.newBot("Someone else");
    const forged = (seq: number, record: Record<string, unknown>) => ({
      seq,
      kind: record.type as string,
      occurredAt: new Date(),
      payload: Buffer.from(encryptText(key, entryLocation(stream.id, seq), JSON.stringify(record))),
    });
    const revision = {
      type: "memory.revision",
      id: "forged-revision",
      documentId: "forged-document",
      spaceId: fixture.spaceId,
      userId: fixture.userId,
      botId: other,
      scope: "bot",
      path: "MEMORY.md",
      revision: 1,
      content: "written into someone else's memory",
      sourceRunId: null,
      sourceThreadId: null,
      createdAt: new Date().toISOString(),
    };
    const event = {
      type: "audit.event",
      id: "forged-event",
      createdAt: new Date().toISOString(),
      organizationId: fixture.organizationId,
      spaceId: "some-other-space",
      spaceName: null,
      actorType: "bot",
      actorId: botId,
      actorLabel: null,
      action: "tool.call",
      targetType: null,
      targetId: null,
      targetLabel: null,
      outcome: "success",
      runId: null,
      threadId: null,
      ip: null,
      userAgent: null,
      metadata: {},
    };
    await ledger.append(
      {
        stream: stream.id,
        entries: [forged(stored.length + 1, revision), forged(stored.length + 2, event)],
      },
      signal,
    );

    const report = await restore();

    expect(report.misplaced).toBe(2);
    expect(
      report.warnings.filter((warning) => /different Space or bot/.test(warning)),
    ).toHaveLength(1);
    expect(await fixture.prisma.memoryDocument.findFirst({ where: { botId: other } })).toBeNull();
    expect(
      await fixture.prisma.auditEvent.findUnique({ where: { id: "forged-event" } }),
    ).toBeNull();
    expect(report.memory).toMatchObject({ added: 0, existing: 3 });
  });

  it("explains why a stream that has nowhere to go was not restored", async () => {
    await seed();
    const stream = (await streamOf())!;
    await fixture.prisma.bot.delete({ where: { id: botId } });

    const gone = await restore({ stream: stream.id });
    expect(gone.skipped).toMatch(/bot this stream belongs to does not exist here/);
    expect(gone.memory.added).toBe(0);

    const nowhere = await restore({ stream: stream.id, intoBot: "no-such-bot" });
    expect(nowhere.skipped).toMatch(/bot to restore into does not exist/);
  });
});

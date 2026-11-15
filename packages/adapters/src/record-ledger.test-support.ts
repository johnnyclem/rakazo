import type { ContentKeyRing, Prisma, PrismaClient } from "@rakazo/db";
import { asSystem, ciphertextKeyId, createDb, decryptText } from "@rakazo/db";
import { createRecordLedgerReconciler } from "./record-ledger.js";
import type { RecordLedgerEmulator } from "./record-ledger-emulator.js";
import { entryLocation, SPACE_KEY_KIND, STREAM_OPENED_KIND } from "./record-ledger-format.js";

export type StreamWithEntries = Prisma.RecordLedgerStreamGetPayload<{ include: { entries: true } }>;

/** A Space in a database with content encryption on, and the means to write what the ledger records. */
export interface LedgerFixture {
  db: PrismaClient;
  /** The same client with every call run as the system, for setting up and inspecting rows. */
  prisma: PrismaClient;
  keys: ContentKeyRing;
  organizationId: string;
  otherOrganizationId: string;
  spaceId: string;
  userId: string;
  newBot(name?: string): Promise<string>;
  /** A pass of the sealer and shipper in which every row already written counts as settled. */
  reconciler(provider: RecordLedgerEmulator): () => Promise<void>;
  remember(
    botId: string,
    content: string,
    options?: { shared?: boolean; path?: string },
  ): Promise<Prisma.MemoryRevisionGetPayload<object>>;
  audit(data: {
    action: string;
    actorType?: string;
    actorId?: string;
    organizationId?: string;
    spaceId?: string | null;
  }): Promise<Prisma.AuditEventGetPayload<object>>;
  streamOf(subject: string): Promise<StreamWithEntries | null>;
  /** What a sealed entry says, opened with its Space key at its place in its stream. */
  open(entry: { streamId: string; seq: number; payload: string }): Promise<Record<string, unknown>>;
  /** The entries of a stream that record something, leaving out its key and its header. */
  recordsOf<T extends { kind: string }>(entries: T[]): T[];
  close(): Promise<void>;
}

export async function createLedgerFixture(databaseUrl: string): Promise<LedgerFixture> {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `ledger-org-${suffix}`;
  const otherOrganizationId = `${organizationId}-other`;
  const spaceId = `ledger-space-${suffix}`;
  const userId = `ledger-user-${suffix}`;
  const created = createDb(databaseUrl, { encryptContent: true });
  const db = created.prisma;
  const prisma = asSystem(db);
  let bots = 0;

  for (const id of [organizationId, otherOrganizationId]) {
    await prisma.organization.create({
      data: { id, name: "Acme", slug: id, createdAt: new Date() },
    });
  }
  await prisma.space.create({ data: { id: spaceId, organizationId, name: "Support" } });

  return {
    db,
    prisma,
    keys: created.contentKeys,
    organizationId,
    otherOrganizationId,
    spaceId,
    userId,
    async newBot(name = "Researcher") {
      bots += 1;
      const id = `ledger-bot-${suffix}-${bots}`;
      await prisma.bot.create({ data: { id, spaceId, userId, name, color: "ink" } });
      return id;
    },
    reconciler: (provider) =>
      createRecordLedgerReconciler(db, provider, {
        settleMs: 0,
        now: () => new Date(Date.now() + 5_000),
      }),
    async remember(botId, content, options = {}) {
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
    },
    audit: (data) =>
      prisma.auditEvent.create({
        data: {
          organizationId,
          spaceId,
          actorType: "user",
          actorId: userId,
          outcome: "success",
          ...data,
        },
      }),
    streamOf: (subject) =>
      prisma.recordLedgerStream.findUnique({
        where: { subject },
        include: { entries: { orderBy: { seq: "asc" } } },
      }),
    async open(entry) {
      const key = await created.contentKeys.byId(ciphertextKeyId(entry.payload)!);
      const plain = decryptText(key, entryLocation(entry.streamId, entry.seq), entry.payload);
      return JSON.parse(plain) as Record<string, unknown>;
    },
    recordsOf: (entries) =>
      entries.filter((entry) => entry.kind !== SPACE_KEY_KIND && entry.kind !== STREAM_OPENED_KIND),
    async close() {
      await prisma.organization.deleteMany({
        where: { id: { in: [organizationId, otherOrganizationId] } },
      });
      await db.$disconnect();
      await created.pool.end();
    },
  };
}

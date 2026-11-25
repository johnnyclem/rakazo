import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMeetingMediaSession } from "./app-meeting-media.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("which meeting session media may answer (PostgreSQL)", () => {
  let system: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let sessionId: string;
  const address = `meeting-media-${randomUUID()}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "test", address }),
    );
    const session = await system.meetingSession.create({
      data: {
        spaceId: identity.spaceId,
        botId: identity.botId,
        userId: identity.userId,
        provider: "test",
        platform: "test",
        status: "joined",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    sessionId = session.id;
  });
  afterAll(async () => {
    try {
      if (identity) {
        await system.messagingIdentity.deleteMany({ where: { provider: "test", address } });
        await system.organization.deleteMany({ where: { id: identity.spaceId } });
        await system.user.deleteMany({ where: { id: identity.userId } });
      }
    } finally {
      await close?.();
    }
  });

  const load = () =>
    loadMeetingMediaSession(
      { prisma: system, providerId: "test", enabled: () => true, voice: true },
      sessionId,
    );

  it("reports a paused bot as paused, not as a session that is gone", async () => {
    expect(await load()).toMatchObject({ admitted: true, voice: true, paused: false });
    await system.bot.update({ where: { id: identity.botId }, data: { pausedAt: new Date() } });
    expect(await load()).toMatchObject({ admitted: true, paused: true });
    await system.bot.update({ where: { id: identity.botId }, data: { pausedAt: null } });
    expect(await load()).toMatchObject({ admitted: true, paused: false });
  });
});

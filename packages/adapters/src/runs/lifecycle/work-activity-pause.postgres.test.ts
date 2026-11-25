import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WorkActivities } from "./work-activity.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("the live status card and a paused bot (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `work-activity-pause-${randomUUID()}@rakazo.test`;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    identity = await runAsSystem("work activity pause fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
  });
  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("does not show a run the pause holds as a bot at work", async () => {
    const { userId, spaceId, botId, threadId } = identity;
    const task = await system.task.create({
      data: { userId, spaceId, botId, threadId, prompt: "held", status: "queued" },
    });
    await system.run.create({
      data: {
        userId,
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        trigger: "user",
        status: "queued",
      },
    });
    const send = vi.fn(async () => "sent" as const);
    const activities = new WorkActivities(
      system,
      "offline-activity-key",
      { send, start: async () => "sent" },
      0,
    );
    const token = "ab".repeat(32);
    await system.bot.update({ where: { id: botId }, data: { pausedAt: new Date() } });
    expect(await activities.register(userId, "session-1", token)).toBe(false);
    await system.bot.update({ where: { id: botId }, data: { pausedAt: null } });
    expect(await activities.register(userId, "session-1", token)).toBe(true);
    // Let the card's first push finish before the database closes.
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });
});

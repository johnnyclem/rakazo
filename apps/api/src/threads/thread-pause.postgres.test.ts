import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelThreadRuns } from "./thread-stop.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("stopping a paused bot's chat (PostgreSQL)", () => {
  let system: PrismaClient;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  const address = `thread-pause-${randomUUID()}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider: "test", address }),
    );
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

  it("cancels the runs the pause is holding", async () => {
    const { userId, spaceId, botId, threadId } = identity;
    const task = await system.task.create({
      data: { userId, spaceId, botId, threadId, prompt: "held", status: "queued" },
    });
    const held = await system.run.create({
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
    await system.bot.update({ where: { id: botId }, data: { pausedAt: new Date() } });
    const actor = { userId, spaceId } as Actor;

    await runAsTenant(actor, () =>
      prisma.$transaction(
        cancelThreadRuns(actor, { kind: "bot", botId, threadId }),
        THREAD_LOCK_TRANSACTION_OPTIONS,
      ),
    );

    expect((await system.run.findUniqueOrThrow({ where: { id: held.id } })).status).toBe(
      "cancelled",
    );
  });
});

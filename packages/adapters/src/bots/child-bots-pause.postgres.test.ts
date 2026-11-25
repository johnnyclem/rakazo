import { randomUUID } from "node:crypto";
import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnBot } from "./child-bots.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("a paused bot cannot spawn another (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  let actor: Actor;
  const jobs: BackgroundJob[] = [];
  const address = `spawn-pause-${randomUUID()}@rakazo.test`;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    identity = await runAsSystem("spawn pause fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    actor = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      email: "",
      isDeploymentOwner: false,
    };
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

  const spawn = async (spawnKey: string) => {
    const { userId, spaceId, botId, threadId } = identity;
    const task = await system.task.create({
      data: { userId, spaceId, botId, threadId, prompt: "fixture", status: "running" },
    });
    const run = await system.run.create({
      data: {
        userId,
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        trigger: "user",
        status: "running",
      },
    });
    return runAsTenant(actor, () =>
      spawnBot(
        {
          prisma: db.prisma,
          jobs: { enqueue: async (job: BackgroundJob) => void jobs.push(job) } as JobPublisher,
        },
        {
          spawnedBy: {
            id: identity.botId,
            name: "Chief",
            spaceId: identity.spaceId,
            userId: identity.userId,
          },
          runId: run.id,
          spawnKey,
          name: `Scout ${spawnKey}`,
          prompt: "Look around",
        },
      ),
    );
  };
  const spawned = (spawnKey: string) =>
    system.bot.count({ where: { spaceId: identity.spaceId, spawnKey } });

  it("creates no bot and no run while the spawner is paused, and spawns after the resume", async () => {
    await system.bot.update({ where: { id: identity.botId }, data: { pausedAt: new Date() } });
    expect(await spawn("held")).toEqual({ error: "Chief is paused." });
    expect(await spawned("held")).toBe(0);
    expect(jobs).toHaveLength(0);

    await system.bot.update({ where: { id: identity.botId }, data: { pausedAt: null } });
    expect(await spawn("held")).toMatchObject({ ok: true });
    expect(await spawned("held")).toBe(1);
  });
});

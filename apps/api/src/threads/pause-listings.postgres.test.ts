import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  botRunStatuses,
  createDb,
  createGroupRepos,
  createRepos,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listSpaceRuns } from "./runs.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("how a paused bot is listed (PostgreSQL)", () => {
  let system: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let actor: Actor;
  const address = `pause-listings-${randomUUID()}`;

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
    actor = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      email: "",
      isDeploymentOwner: false,
    } as Actor;
  });
  beforeEach(async () => {
    await system.run.deleteMany({ where: { spaceId: identity.spaceId } });
    await setPaused(false);
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

  const setPaused = (paused: boolean) =>
    system.bot.update({
      where: { id: identity.botId },
      data: { pausedAt: paused ? new Date() : null },
    });

  async function createRun(status: string) {
    const { userId, spaceId, botId, threadId } = identity;
    const task = await system.task.create({
      data: { userId, spaceId, botId, threadId, prompt: "held", status: "queued" },
    });
    return system.run.create({
      data: { userId, spaceId, botId, threadId, taskId: task.id, trigger: "user", status },
    });
  }

  it("leaves a paused bot's queued run out of the active activity list", async () => {
    const queued = await createRun("queued");
    expect((await listSpaceRuns(system, actor, "active")).map((row) => row.runId)).toContain(
      queued.id,
    );

    await setPaused(true);
    expect(await listSpaceRuns(system, actor, "active")).toEqual([]);
  });

  it("keeps a paused bot's running run in the active activity list", async () => {
    const running = await createRun("running");
    await setPaused(true);
    expect((await listSpaceRuns(system, actor, "active")).map((row) => row.runId)).toEqual([
      running.id,
    ]);
  });

  it("reports paused on the roster, the bot view and a group's members", async () => {
    const repos = createRepos(system);
    const peer = await system.bot.create({
      data: { spaceId: identity.spaceId, userId: identity.userId, name: "Peer", color: "blue" },
    });
    await system.thread.create({
      data: { spaceId: identity.spaceId, userId: identity.userId, botId: peer.id },
    });
    const group = await system.chatGroup.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        name: "Team",
        members: { create: [{ botId: identity.botId }, { botId: peer.id }] },
      },
    });
    await system.thread.create({
      data: { spaceId: identity.spaceId, userId: identity.userId, groupId: group.id },
    });
    await createRun("queued");
    await setPaused(true);
    try {
      const roster = await repos.listSpaceBotsForSpaces([identity.spaceId], identity.userId);
      expect(roster.find((bot) => bot.id === identity.botId)?.status).toBe("paused");
      expect((await repos.getBotView(actor, identity.botId)).status).toBe("paused");
      const groups = await createGroupRepos(system).listGroups(actor);
      const members = groups.find((row) => row.id === group.id)?.members;
      expect(members?.find((member) => member.botId === identity.botId)?.status).toBe("paused");
      expect(members?.find((member) => member.botId === peer.id)?.status).toBe("idle");
      expect((await botRunStatuses(system, [identity.botId])).get(identity.botId)).toBe("paused");
    } finally {
      await system.chatGroup.delete({ where: { id: group.id } });
      await system.bot.delete({ where: { id: peer.id } });
    }
  });

  it("reports pausing while a paused bot's run is still going, and idle once resumed", async () => {
    await createRun("running");
    await setPaused(true);
    expect((await botRunStatuses(system, [identity.botId])).get(identity.botId)).toBe("pausing");

    await system.run.deleteMany({ where: { spaceId: identity.spaceId } });
    await setPaused(false);
    expect((await botRunStatuses(system, [identity.botId])).get(identity.botId)).toBe("idle");
  });
});

import { randomUUID } from "node:crypto";
import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { FleetPauseScope, PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  IsolationError,
  pauseBots,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconcileStuckWork } from "../runs/lifecycle/stuck-work.js";
import { resumeBots } from "./fleet-resume.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;
const HOUR_MS = 60 * 60_000;

describePostgres("pausing and resuming bots (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  let actor: Actor;
  let jobs: BackgroundJob[];
  let strangerBotId: string;
  const address = `pause-${randomUUID()}@rakazo.test`;
  const strangerAddress = `pause-other-${randomUUID()}@rakazo.test`;
  let stranger: Awaited<ReturnType<typeof provisionMessagingIdentity>>;

  const asMember = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);
  const pause = (scope: FleetPauseScope, now?: Date) =>
    asMember(() => pauseBots(db.prisma, actor, scope, now));
  const resume = (scope: FleetPauseScope) => asMember(() => resumeBots(deps(), actor, scope));
  const deps = () => ({
    prisma: db.prisma,
    jobs: { enqueue: async (job: BackgroundJob) => void jobs.push(job) },
  });
  const newBot = (name: string, data: { archivedAt?: Date } = {}) =>
    system.bot
      .create({
        data: { spaceId: identity.spaceId, userId: identity.userId, name, color: "blue", ...data },
      })
      .then((bot) => bot.id);
  const pausedAt = async (id: string) =>
    (await system.bot.findUniqueOrThrow({ where: { id } })).pausedAt;
  const heldRun = async (botId: string, data: { updatedAt?: Date } = {}) => {
    const { userId, spaceId, threadId } = identity;
    const task = await system.task.create({
      data: { userId, spaceId, botId, threadId, prompt: "fixture", status: "queued" },
    });
    return system.run.create({
      data: {
        userId,
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        trigger: "user",
        status: "queued",
        ...data,
      },
    });
  };

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    identity = await runAsSystem("pause fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    stranger = await runAsSystem("pause fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address: strangerAddress }),
    );
    strangerBotId = stranger.botId;
    actor = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      email: address,
      isDeploymentOwner: false,
    };
  });
  beforeEach(async () => {
    jobs = [];
    await system.run.deleteMany({ where: { spaceId: identity.spaceId } });
    await system.task.deleteMany({ where: { spaceId: identity.spaceId } });
    await system.chatGroup.deleteMany({ where: { spaceId: identity.spaceId } });
    await system.bot.deleteMany({
      where: { spaceId: identity.spaceId, id: { not: identity.botId } },
    });
    await system.bot.updateMany({ data: { pausedAt: null } });
  });
  afterAll(async () => {
    for (const [who, id] of [
      [address, identity],
      [strangerAddress, stranger],
    ] as const) {
      if (!id) continue;
      await system.messagingIdentity.deleteMany({ where: { address: who } });
      await system.organization.deleteMany({ where: { id: id.spaceId } });
      await system.user.deleteMany({ where: { id: id.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("pauses one bot, keeps the first pause time and reports only what changed", async () => {
    const first = new Date(Date.now() - 60_000);
    expect(await pause({ kind: "bot", botId: identity.botId }, first)).toEqual([identity.botId]);

    expect(await pause({ kind: "bot", botId: identity.botId })).toEqual([]);
    expect(await pausedAt(identity.botId)).toEqual(first);
  });

  it("pauses the members of a group and no other bot", async () => {
    const member = await newBot("Member");
    const outsider = await newBot("Outsider");
    const group = await system.chatGroup.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        name: "Crew",
        members: { create: [{ botId: identity.botId }, { botId: member }] },
      },
    });

    const changed = await pause({ kind: "group", groupId: group.id });

    expect(changed.sort()).toEqual([identity.botId, member].sort());
    expect(await pausedAt(outsider)).toBeNull();
  });

  it("pauses every live bot in the Space and leaves archived bots and other Spaces alone", async () => {
    const archived = await newBot("Archived", { archivedAt: new Date() });
    const other = await newBot("Other");

    const changed = await pause({ kind: "space" });

    expect(changed.sort()).toEqual([identity.botId, other].sort());
    expect(await pausedAt(archived)).toBeNull();
    expect(await pausedAt(strangerBotId)).toBeNull();
  });

  it.each([
    () => ({ kind: "bot" as const, botId: "missing-bot" }),
    () => ({ kind: "group" as const, groupId: "missing-group" }),
    () => ({ kind: "bot" as const, botId: strangerBotId }),
  ])("does not find a bot or group outside the Space", async (scope) => {
    await expect(pause(scope())).rejects.toBeInstanceOf(IsolationError);
  });

  it("resumes the paused bots and wakes each run they held once", async () => {
    const other = await newBot("Other");
    await pause({ kind: "space" });
    const held = await heldRun(identity.botId);
    const second = await heldRun(identity.botId);
    const running = await heldRun(other);
    await system.run.update({ where: { id: running.id }, data: { status: "running" } });

    const resumed = await resume({ kind: "bot", botId: identity.botId });

    expect(resumed).toEqual([identity.botId]);
    expect(await pausedAt(identity.botId)).toBeNull();
    expect(await pausedAt(other)).not.toBeNull();
    expect(
      jobs.flatMap((job) => (job.name === "run.continue" ? [job.payload.runId] : [])).sort(),
    ).toEqual([held.id, second.id].sort());
    expect(jobs.every((job) => job.keepExisting === true)).toBe(true);
  });

  it("wakes nothing when no bot was paused", async () => {
    await heldRun(identity.botId);

    expect(await resume({ kind: "space" })).toEqual([]);
    expect(jobs).toEqual([]);
  });

  it("starts the stuck-work clock again at the resume", async () => {
    await pause({ kind: "space" });
    const held = await heldRun(identity.botId, { updatedAt: new Date(Date.now() - 48 * HOUR_MS) });

    await resume({ kind: "space" });
    await reconcileStuckWork({
      prisma: system,
      jobs: deps().jobs as unknown as JobPublisher,
      now: new Date(),
      batchSize: 100,
    });

    expect((await system.run.findUniqueOrThrow({ where: { id: held.id } })).status).toBe("queued");
  });
});

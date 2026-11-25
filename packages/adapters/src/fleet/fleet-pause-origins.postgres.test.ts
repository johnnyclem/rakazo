import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { messageConnectedAgent } from "../bots/agent-connections.js";
import { handoffToGroupBot } from "../bots/group-handoff.js";
import { messageBot } from "../messaging/bot-messages.js";
import { reconcileStrategicInitiatives } from "../routines/strategic-initiative.js";
import { wakeRoutine } from "../runs/assembly/run-routines.js";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { claimRun } from "../runs/lifecycle/run-lifecycle.js";
import { wakeTicketAssignee } from "../tasks/ticket-wake.js";
import { resumeBots } from "./fleet-resume.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("what a paused bot refuses, skips or holds (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  let target: { id: string; threadId: string };
  let jobs: BackgroundJob[];
  let deps: ExecutorDeps;
  const address = `pause-origins-${randomUUID()}@rakazo.test`;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    identity = await runAsSystem("pause origins fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    const { userId, spaceId } = identity;
    const bot = await system.bot.create({
      data: { spaceId, userId, name: "Target", color: "blue", crossSpaceCommunication: true },
    });
    const thread = await system.thread.create({ data: { spaceId, userId, botId: bot.id } });
    target = { id: bot.id, threadId: thread.id };
  });
  beforeEach(async () => {
    const { spaceId } = identity;
    await system.routine.deleteMany({ where: { spaceId } });
    await system.run.deleteMany({ where: { spaceId } });
    await system.bot.updateMany({ where: { spaceId }, data: { pausedAt: null } });
    jobs = [];
    deps = {
      prisma: system,
      jobs: {
        enqueue: async (job: BackgroundJob) => void jobs.push(job),
        cancel: async () => undefined,
      },
      events: { notify: async () => undefined, append: async () => undefined },
    } as unknown as ExecutorDeps;
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

  const pauseTarget = () =>
    system.bot.update({ where: { id: target.id }, data: { pausedAt: new Date() } });
  const runsOf = (botId: string) => system.run.findMany({ where: { botId } });

  async function createRun(data: {
    botId: string;
    threadId: string;
    trigger: string;
    status: string;
  }) {
    const { userId, spaceId } = identity;
    const task = await system.task.create({
      data: {
        userId,
        spaceId,
        botId: data.botId,
        threadId: data.threadId,
        prompt: "x",
        status: "queued",
      },
    });
    return system.run.create({ data: { userId, spaceId, taskId: task.id, ...data } });
  }
  const senderRun = () =>
    createRun({
      botId: identity.botId,
      threadId: identity.threadId,
      trigger: "user",
      status: "running",
    });

  it("refuses message_bot to a paused bot and creates no run", async () => {
    const source = await senderRun();
    await pauseTarget();

    const result = await messageBot(
      deps,
      source,
      { id: identity.botId, name: "Sender" },
      { bot_id: target.id, message: "hello" },
    );

    expect(result).toEqual({ ok: false, error: "Target is paused." });
    expect(await runsOf(target.id)).toHaveLength(0);
  });

  it("refuses message_bot again when the pause lands after the target was resolved", async () => {
    const source = await senderRun();
    const racing = Object.create(system) as PrismaClient;
    const realTransaction = system.$transaction.bind(system);
    let paused = false;
    racing.$transaction = (async (...args: Parameters<PrismaClient["$transaction"]>) => {
      if (!paused) {
        paused = true;
        await pauseTarget();
      }
      return realTransaction(...args);
    }) as PrismaClient["$transaction"];

    const result = await messageBot(
      { ...deps, prisma: racing },
      source,
      { id: identity.botId, name: "Sender" },
      { bot_id: target.id, message: "hello" },
    );

    expect(result).toEqual({ ok: false, error: "Target is paused." });
    expect(await runsOf(target.id)).toHaveLength(0);
  });

  it("delivers message_bot once the target is not paused", async () => {
    const source = await senderRun();

    const result = await messageBot(
      deps,
      source,
      { id: identity.botId, name: "Sender" },
      { bot_id: target.id, message: "hello" },
    );

    expect(result).toMatchObject({ ok: true, botId: target.id });
    expect(await runsOf(target.id)).toHaveLength(1);
  });

  it("refuses handoff_to_bot to a paused group member and creates no run", async () => {
    const { userId, spaceId, botId } = identity;
    const group = await system.chatGroup.create({
      data: {
        spaceId,
        userId,
        name: "Team",
        members: { create: [{ botId }, { botId: target.id }] },
      },
    });
    const thread = await system.thread.create({ data: { spaceId, userId, groupId: group.id } });
    const source = await createRun({
      botId,
      threadId: thread.id,
      trigger: "user",
      status: "running",
    });
    await pauseTarget();

    const result = await handoffToGroupBot(deps, source, group.id, {
      bot_id: target.id,
      message: "your turn",
    });

    expect(result).toEqual({ error: "Target is paused." });
    expect(await runsOf(target.id)).toHaveLength(0);
    await system.chatGroup.delete({ where: { id: group.id } });
  });

  it("refuses a message to a paused connected agent and creates no run", async () => {
    const { userId, spaceId, botId } = identity;
    const provider = "email";
    const targetAddress = `target-${randomUUID()}@rakazo.test`;
    await system.messagingIdentity.create({
      data: { provider, address: targetAddress, userId, spaceId, botId: target.id },
    });
    await system.agentConnection.create({
      data: { requesterBotId: botId, targetBotId: target.id, status: "approved" },
    });
    const source = await senderRun();
    await pauseTarget();

    try {
      const result = await messageConnectedAgent(
        deps,
        source,
        { id: botId, name: "Sender" },
        { address: targetAddress, message: "hello" },
      );

      expect(result).toEqual({ ok: false, error: "Target is paused." });
      expect(await runsOf(target.id)).toHaveLength(0);
    } finally {
      await system.agentConnection.deleteMany({ where: { requesterBotId: botId } });
      await system.messagingIdentity.deleteMany({ where: { botId: target.id } });
    }
  });

  describe("routines", () => {
    const dueAt = () => new Date(Date.now() - 60_000);
    const routine = (data: Record<string, unknown>) =>
      system.routine.create({
        data: {
          userId: identity.userId,
          spaceId: identity.spaceId,
          botId: identity.botId,
          threadId: identity.threadId,
          name: "report",
          prompt: "Report",
          active: true,
          nextRunAt: dueAt(),
          ...data,
        },
      });
    const pauseSender = () =>
      system.bot.update({ where: { id: identity.botId }, data: { pausedAt: new Date() } });

    it("skips a recurring occurrence without a run and schedules the next one", async () => {
      const due = dueAt();
      const row = await routine({ crons: ["* * * * *"], nextRunAt: due });
      await pauseSender();

      await wakeRoutine(deps, row.id, due.toISOString());

      expect(await runsOf(identity.botId)).toHaveLength(0);
      const after = await system.routine.findUniqueOrThrow({ where: { id: row.id } });
      expect(after).toMatchObject({ active: true });
      expect(after.nextRunAt!.getTime()).toBeGreaterThan(due.getTime());
      expect(jobs).toHaveLength(1);
    });

    it("skips a change check without a run and schedules the next one", async () => {
      const due = dueAt();
      const row = await routine({
        crons: [],
        nextRunAt: due,
        watch: { kind: "tool", tool: "read_changes", everyMinutes: 15 },
      });
      await pauseSender();

      await wakeRoutine(deps, row.id, due.toISOString());

      expect(await runsOf(identity.botId)).toHaveLength(0);
      const after = await system.routine.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it("holds a one-time routine's only run until the bot is resumed", async () => {
      const due = dueAt();
      const row = await routine({ crons: ["@once"], nextRunAt: due });
      await pauseSender();

      await wakeRoutine(deps, row.id, due.toISOString());

      const [held] = await runsOf(identity.botId);
      expect(held).toMatchObject({ trigger: "routine", status: "queued" });
      expect(await claimRun(deps, held!, "worker-1")).toBeUndefined();
    });
  });

  it("queues no daily check-in for a paused bot", async () => {
    const { botId } = identity;
    await system.bot.update({ where: { id: botId }, data: { dailyCheckIns: true } });
    await system.scratchpadItem.create({
      data: {
        botId,
        spaceId: identity.spaceId,
        userId: identity.userId,
        title: "Old work",
        notes: "",
        status: "open",
        updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60_000),
      },
    });
    await system.bot.update({ where: { id: botId }, data: { pausedAt: new Date() } });
    const sweep = () =>
      reconcileStrategicInitiatives({
        prisma: system,
        jobs: deps.jobs as never,
        now: new Date(),
        pageSize: 50,
      });

    expect(await sweep()).toBe(0);
    expect(await runsOf(botId)).toHaveLength(0);

    await system.bot.update({ where: { id: botId }, data: { pausedAt: null } });
    expect(await sweep()).toBe(1);
  });

  it("starts no ticket work for a paused assignee", async () => {
    const { spaceId } = identity;
    const board = await system.board.upsert({
      where: { spaceId },
      create: { spaceId },
      update: {},
    });
    const ticket = await system.ticket.create({
      data: {
        spaceId,
        boardId: board.id,
        number: Date.now() % 1_000_000,
        title: "Fix",
        assigneeBotId: target.id,
      },
    });
    await pauseTarget();
    const wake = () =>
      wakeTicketAssignee(
        { prisma: system, jobs: deps.jobs as never, deploymentLabs: ["board"] },
        { spaceId, ticketId: ticket.id, botId: target.id },
      );

    await wake();
    expect(await runsOf(target.id)).toHaveLength(0);

    await system.bot.update({ where: { id: target.id }, data: { pausedAt: null } });
    await wake();
    expect(await runsOf(target.id)).toHaveLength(1);
    await system.ticket.delete({ where: { id: ticket.id } });
  });

  // One case per origin: the run is created and waits for the resume, it is not refused or lost.
  describe.each([
    "webhook",
    "messaging",
    "reaction",
    "follow_up",
    "call_end",
    "skill",
    "resume",
    "user",
  ])("a %s run for a paused bot", (trigger) => {
    it("is held, then woken by the resume", async () => {
      const run = await createRun({
        botId: target.id,
        threadId: target.threadId,
        trigger,
        status: "queued",
      });
      await pauseTarget();

      expect(await claimRun(deps, run, "worker-1")).toBeUndefined();
      expect((await system.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("queued");

      const actor = { userId: identity.userId, spaceId: identity.spaceId } as Actor;
      await resumeBots({ prisma: system, jobs: deps.jobs as never }, actor, {
        kind: "bot",
        botId: target.id,
      });

      expect(jobs.some((job) => JSON.stringify(job.payload).includes(run.id))).toBe(true);
      expect(await claimRun(deps, run, "worker-1")).toMatchObject({ current: { id: run.id } });
    });
  });
});

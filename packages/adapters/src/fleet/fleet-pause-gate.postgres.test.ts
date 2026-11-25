import { randomUUID } from "node:crypto";
import type {
  BackgroundJob,
  BackgroundJobHandlers,
  NotificationProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createPendingSteeringRun,
  createThreadMessage,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryRealtimeFanout } from "../notifications/realtime.js";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { holdRunForChat, startRunsWaitingOnChat } from "../runs/lifecycle/chat-wait.js";
import { findContinuableRun } from "../runs/lifecycle/run-attempt.js";
import { claimRun } from "../runs/lifecycle/run-lifecycle.js";
import { reconcileStuckWork } from "../runs/lifecycle/stuck-work.js";
import { createJobReconciler } from "../runs/wakeups/job-reconciler.js";
import { RunStarter, RunWorkerHost } from "../runs/wakeups/run-wakeup.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;
const HOUR_MS = 60 * 60_000;

describePostgres("a paused bot's queued runs are held (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  let otherBotId: string;
  let jobs: BackgroundJob[];
  let deps: ExecutorDeps;
  const address = `pause-gate-${randomUUID()}@rakazo.test`;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    identity = await runAsSystem("pause gate fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    otherBotId = (
      await system.bot.create({
        data: { spaceId: identity.spaceId, userId: identity.userId, name: "Other", color: "blue" },
      })
    ).id;
  });
  beforeEach(async () => {
    await system.run.deleteMany({ where: { spaceId: identity.spaceId } });
    await resume();
    jobs = [];
    deps = {
      prisma: system,
      jobs: { enqueue: async (job: BackgroundJob) => void jobs.push(job) },
      events: { notify: async () => undefined },
    } as unknown as ExecutorDeps;
  });
  afterAll(async () => {
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
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

  const pause = () =>
    system.bot.update({ where: { id: identity.botId }, data: { pausedAt: new Date() } });
  const resume = () =>
    system.bot.update({ where: { id: identity.botId }, data: { pausedAt: null } });

  async function createRun(
    data: {
      trigger?: string;
      status?: string;
      botId?: string;
      wakeAt?: Date;
      createdAt?: Date;
      updatedAt?: Date;
    } = {},
  ) {
    const { userId, spaceId, threadId } = identity;
    const botId = data.botId ?? identity.botId;
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
        ...data,
        trigger: data.trigger ?? "user",
        status: data.status ?? "queued",
      },
      include: { routine: { select: { name: true, inChat: true } } },
    });
  }
  const statusOf = async (id: string) =>
    (await system.run.findUniqueOrThrow({ where: { id } })).status;
  const wait = (assertion: () => Promise<void> | void) =>
    vi.waitFor(assertion, { timeout: 5_000, interval: 20 });

  it("refuses to claim the run until the bot is resumed", async () => {
    const run = await createRun();
    await pause();

    expect(await claimRun(deps, run, "worker-1")).toBeUndefined();
    expect(await statusOf(run.id)).toBe("queued");

    await resume();
    expect(await claimRun(deps, run, "worker-1")).toBeDefined();
  });

  it("does not hand the run to a worker in the dispatch scan", async () => {
    const held = await createRun({ createdAt: new Date(Date.now() - 60_000) });
    const control = await createRun({ botId: otherBotId });
    await pause();
    const realtime = new InMemoryRealtimeFanout();
    const host = new RunWorkerHost(db.prisma, realtime, new RunStarter(realtime), {
      intervalMs: 25,
    });
    const entered: string[] = [];
    try {
      await host.start({
        "run.continue": async ({ runId }) => {
          entered.push(runId);
          await system.run.update({ where: { id: runId }, data: { status: "completed" } });
        },
      } as BackgroundJobHandlers);
      // The older run is in the same scan page as the control, so a scan that took it would have.
      await wait(() => expect(entered).toContain(control.id));
      expect(entered).not.toContain(held.id);

      await resume();
      await wait(() => expect(entered).toContain(held.id));
    } finally {
      await host.stop();
    }
  });

  it("leaves a held run out of the queue delay report until it is resumed", async () => {
    const now = Date.now();
    const run = await createRun({
      createdAt: new Date(now - HOUR_MS),
      updatedAt: new Date(now - HOUR_MS),
    });
    await pause();
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const delayed = () => sink.events.some((event) => event.message === "run.queue_delayed");
    // The queue check is the host's only raw query: wait for it to settle, then stop and assert.
    const queryRaw = db.prisma.$queryRaw.bind(db.prisma);
    let settled = 0;
    const spy = vi.spyOn(db.prisma, "$queryRaw").mockImplementation(((
      query: unknown,
      ...values: unknown[]
    ) => {
      const result = queryRaw(query as never, ...(values as never[]));
      const done = () => {
        settled += 1;
      };
      void Promise.resolve(result).then(done, done);
      return result;
    }) as never);
    const realtime = new InMemoryRealtimeFanout();
    const host = () => new RunWorkerHost(db.prisma, realtime, new RunStarter(realtime));
    const whilePaused = host();
    const afterResume = host();
    try {
      await whilePaused.start({} as BackgroundJobHandlers);
      await wait(() => expect(settled).toBeGreaterThan(0));
      await whilePaused.stop();
      expect(delayed()).toBe(false);

      await resume();
      await afterResume.start({} as BackgroundJobHandlers);
      await wait(() => expect(delayed()).toBe(true));
      expect(sink.events.find((event) => event.message === "run.queue_delayed")).toMatchObject({
        "queue.oldest_run_id": run.id,
      });
    } finally {
      spy.mockRestore();
      await whilePaused.stop();
      await afterResume.stop();
    }
  });

  describe("stuck work", () => {
    const send = vi.fn(async () => undefined);
    const notifications = { send } as unknown as NotificationProvider;
    const sweep = (afterMs: number) =>
      reconcileStuckWork({
        prisma: system,
        jobs: deps.jobs,
        notifications,
        now: new Date(Date.now() + afterMs),
        batchSize: 100,
      });
    beforeEach(() => send.mockClear());

    it("sends no reminder for a held run", async () => {
      await createRun();
      await pause();

      await sweep(5 * HOUR_MS);
      expect(send).not.toHaveBeenCalled();

      await resume();
      await sweep(5 * HOUR_MS);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("does not cancel a held run", async () => {
      const run = await createRun();
      await pause();

      await sweep(25 * HOUR_MS);
      expect(await statusOf(run.id)).toBe("queued");

      await resume();
      await sweep(25 * HOUR_MS);
      expect(await statusOf(run.id)).toBe("cancelled");
    });
  });

  describe("runs that wait for their chat", () => {
    it("does not count a held run as the chat being busy", async () => {
      await createRun({ createdAt: new Date(Date.now() - 60_000) });
      const waiting = await createRun({ trigger: "bot_message" });
      await pause();

      await holdRunForChat(deps, waiting);
      expect(jobs).toEqual([]);

      await resume();
      await holdRunForChat(deps, waiting);
      expect(jobs).toHaveLength(1);
    });

    it("wakes no waiting run of a paused bot when a run ends", async () => {
      const ended = await createRun({ status: "completed" });
      await createRun({ trigger: "bot_message", wakeAt: new Date(Date.now() + HOUR_MS) });
      await pause();

      await startRunsWaitingOnChat(deps, ended);
      expect(jobs).toEqual([]);

      await resume();
      await startRunsWaitingOnChat(deps, ended);
      expect(jobs).toHaveLength(1);
    });
  });

  it("queues the follow-up for a message nobody is working on and holds it until the resume", async () => {
    const { id: messageId } = await createThreadMessage(system, {
      threadId: identity.threadId,
      role: "user",
      blocks: [{ kind: "text", text: "Are you there?" }],
      botId: identity.botId,
    });
    await system.steeringMessage.create({
      data: { messageId, botId: identity.botId, userId: identity.userId },
    });
    await pause();

    const runId = await system.$transaction((tx) =>
      createPendingSteeringRun(tx, {
        spaceId: identity.spaceId,
        threadId: identity.threadId,
        botId: identity.botId,
      }),
    );
    const run = await system.run.findUniqueOrThrow({ where: { id: runId! } });
    expect(await claimRun(deps, run, "worker-1")).toBeUndefined();

    await resume();
    expect(await claimRun(deps, run, "worker-1")).toBeDefined();
  });

  it("does not enqueue a held run in the reconciliation pass", async () => {
    const run = await createRun();
    await pause();
    const enqueued = () =>
      jobs.flatMap((job) => (job.name === "run.continue" ? [job.payload.runId] : []));
    const reconcile = () =>
      runAsSystem("reconcile held runs", () =>
        createJobReconciler(
          { prisma: db.prisma, jobs: deps.jobs },
          { batchSize: 5_000, maxPagesPerPass: 1 },
        ).reconcileOnce(),
      );

    await reconcile();
    expect(enqueued()).not.toContain(run.id);

    await resume();
    await reconcile();
    expect(enqueued()).toContain(run.id);
  });

  it("logs and returns no run to continue while the bot is paused", async () => {
    const run = await createRun();
    await pause();
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));

    expect(await findContinuableRun(deps, () => undefined, run.id)).toBeUndefined();
    expect(sink.events.some((event) => event.message === "run.held_paused")).toBe(true);

    await resume();
    expect((await findContinuableRun(deps, () => undefined, run.id))?.id).toBe(run.id);
  });
});

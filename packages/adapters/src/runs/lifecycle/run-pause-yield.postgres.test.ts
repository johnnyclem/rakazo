import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterContext,
  AgentRunRequest,
  BackgroundJobHandlers,
  JobPublisher,
  JobQueueOrder,
} from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  loadRunTurnCheckpoint,
  pauseBots,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resumeBots } from "../../fleet/fleet-resume.js";
import { InMemoryRealtimeFanout } from "../../notifications/realtime.js";
import { FakeSandboxProvider } from "../../providers/computer/fake/fake-sandbox.js";
import { ScriptedAgentRuntime } from "../../runtime/scripted-runtime.js";
import { EncryptedSecretStore } from "../../secrets/secrets.js";
import { LocalAgentHomeStore } from "../../storage/home.js";
import { createRunExecutor } from "../executor/executor.js";
import type { TurnCheckpoint } from "../turn/turn-checkpoint.js";
import { serializeTurnCheckpoint } from "../turn/turn-checkpoint.js";
import { RunJobPublisher, RunStarter, RunWorkerHost } from "../wakeups/run-wakeup.js";
import { wakeRun } from "../wakeups/wake-run.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("a run in flight when its bot is paused (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let dataDir: string;
  const organizations: string[] = [];
  let defaultModelBefore: {
    defaultModelProvider: string | null;
    defaultModelId: string | null;
  } | null;
  /** One step of a turn: a model call held open until the test ends it. */
  type Turn = { runId: string; step: number; yieldSignal?: AbortSignal; finish: Deferred };
  const processes: Array<{ turns: Turn[]; exit: () => Promise<void> }> = [];
  const wait = (assertion: () => Promise<void> | void) =>
    vi.waitFor(assertion, { timeout: 10_000, interval: 20 });

  beforeAll(async () => {
    db = createDb(url!);
    prisma = db.prisma;
    system = asSystem(prisma);
    dataDir = await mkdtemp(join(tmpdir(), "rakazo-run-pause-"));
    defaultModelBefore = await system.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { defaultModelProvider: true, defaultModelId: true },
    });
    await system.deploymentSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        defaultModelProvider: "openrouter",
        defaultModelId: "openai/gpt-4o",
      },
      update: { defaultModelProvider: "openrouter", defaultModelId: "openai/gpt-4o" },
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const { turns } of processes) for (const turn of turns) turn.finish.resolve();
    await Promise.all(processes.splice(0).map(({ exit }) => exit()));
    // Every process scans the whole database, so nothing a test here left may stay runnable.
    const ours = { space: { organizationId: { in: organizations } } };
    await system.run.updateMany({
      where: { ...ours, status: { in: ["queued", "leased", "running"] } },
      data: { status: "cancelled", leaseOwner: null, leaseExpiresAt: null },
    });
    await system.computerExecutionLease.deleteMany({ where: { computer: ours } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.deploymentSettings.update({
      where: { id: "default" },
      data: defaultModelBefore ?? { defaultModelProvider: null, defaultModelId: null },
    });
    await system.organization.deleteMany({ where: { id: { in: organizations } } });
    await system.user.deleteMany({ where: { id: { in: organizations } } });
    await prisma.$disconnect();
    await db.pool.end();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** One person's bot with a computer, and a way to give it runs. */
  async function seedBot() {
    const id = randomUUID();
    organizations.push(id);
    await system.user.create({
      data: { id, name: "Pause fixture", email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({
      data: { id, name: "Pause fixture", slug: id, createdAt: new Date() },
    });
    await system.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    await system.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await system.spaceMember.create({
      data: {
        id,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const computer = await system.computer.create({
      data: { spaceId: id, userId: id, scopeKey: id, homeKey: id, kind: "fake", state: "running" },
    });
    const bot = await system.bot.create({
      data: { spaceId: id, userId: id, name: "Fixture", color: "test", computerId: computer.id },
    });
    const thread = await system.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const createRun = async (status = "queued") => {
      const owner = { spaceId: id, userId: id, botId: bot.id, threadId: thread.id };
      const task = await system.task.create({
        data: { ...owner, prompt: "Say hello.", status: "queued" },
      });
      return system.run.create({
        data: { ...owner, taskId: task.id, trigger: "routine", status },
      });
    };
    const actor: Actor = {
      userId: id,
      spaceId: id,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    return { createRun, botId: bot.id, computerId: computer.id, actor };
  }

  /** The saved turn of a run that finished `steps` steps, in the shape the executor restores. */
  const checkpointAfter = (steps: number) =>
    serializeTurnCheckpoint({
      version: 1,
      provider: "openrouter",
      model: "openai/gpt-4o",
      systemPrompt: "",
      pendingToolCallId: "",
      messages: Array.from({ length: steps }, (_, step) => ({
        role: "toolResult" as const,
        toolCallId: `step-${step}`,
        toolName: "list_files",
        content: [],
        isError: false,
        timestamp: 0,
      })),
    });

  const realtime = new InMemoryRealtimeFanout();
  const sandbox = new FakeSandboxProvider();

  /**
   * A process as the worker composes one. Each turn takes three steps, and each step's model
   * call is held open until the test ends it. A runtime that supports it ends the turn at the
   * next step once its yield signal aborts; one that does not keeps going.
   */
  function startProcess(workerId: string, options: { yields: boolean }) {
    const stopping = new AbortController();
    const starter = new RunStarter(realtime, { signal: stopping.signal });
    const jobs = new RunJobPublisher(
      prisma,
      {
        enqueue: vi.fn(),
        cancel: vi.fn(),
        cancelIn: vi.fn(),
        close: vi.fn(),
      } as unknown as JobPublisher & JobQueueOrder,
      starter,
    );
    const turns: Turn[] = [];
    const steps = 3;
    const runtime = {
      describe: () => ({
        ...new ScriptedAgentRuntime().describe(),
        capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
      }),
      abort: async () => undefined,
      async *run(request: AgentRunRequest, context: AdapterContext) {
        await request.executeTool!("list_files", { path: "pause-fixture" }, "pause-computer-use");
        const resumedAt = request.turnCheckpoint
          ? (JSON.parse(request.turnCheckpoint) as TurnCheckpoint).messages.length
          : 0;
        for (let step = resumedAt; step < steps; step++) {
          if (options.yields && step > resumedAt && request.yieldSignal?.aborted) {
            const answer = deferred<boolean>();
            yield {
              type: "yielded" as const,
              checkpoint: checkpointAfter(step),
              answer: answer.resolve,
            };
            if (await answer.promise) return;
          }
          const turn = {
            runId: context.runId!,
            step,
            yieldSignal: request.yieldSignal,
            finish: deferred(),
          };
          turns.push(turn);
          const aborted = deferred();
          const onAbort = () => aborted.reject(context.signal.reason);
          context.signal.addEventListener("abort", onAbort, { once: true });
          if (context.signal.aborted) onAbort();
          try {
            await Promise.race([turn.finish.promise, aborted.promise]);
          } finally {
            context.signal.removeEventListener("abort", onAbort);
          }
          // The step's model call asked for a tool, which runs before the next step.
          const call = { name: "list_files", executionId: `step-${step}` };
          const args = { path: `step-${step}` };
          yield { type: "tool" as const, ...call, args, response: step };
          const result = await request.executeTool!(call.name, args, call.executionId);
          await request.onToolCompleted?.({ ...call, durationMs: 0, result });
        }
        yield { type: "done" as const, text: `Hello from ${workerId}.` };
      },
    };
    const executor = createRunExecutor({
      prisma,
      events: createThreadEvents(prisma, realtime),
      jobs,
      sandbox,
      runtime,
      home: new LocalAgentHomeStore(dataDir),
      memory: { read: async () => ({ documents: [] }) },
      memoryProviders: { resolve: async () => null },
      secretStore: new EncryptedSecretStore("fake-fixture-encryption-key"),
      secrets: [],
      deploymentModelKey: "fake-fixture-model-key",
      deploymentModelConfigured: true,
      dataDir,
      shutdownSignal: stopping.signal,
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    const continueRun = async (runId: string, onRunStarted?: () => void) => {
      const owner = await system.run.findUniqueOrThrow({
        where: { id: runId },
        select: { spaceId: true, userId: true },
      });
      await runAsTenant(owner, () => executor.continueRun(runId, workerId, onRunStarted));
    };
    const host = new RunWorkerHost(prisma, realtime, starter, { intervalMs: 25 });
    let stopped: Promise<void> | undefined;
    const exit = async () => {
      stopping.abort();
      stopped ??= host.stop();
      await stopped;
    };
    processes.push({ turns, exit });
    return {
      jobs,
      continueRun,
      start: () =>
        host.start({
          "run.continue": ({ runId }, execution) => continueRun(runId, execution?.onRunStarted),
        } as BackgroundJobHandlers),
      turnsOf: (runId: string) => turns.filter((turn) => turn.runId === runId),
    };
  }

  const runRow = (runId: string) => system.run.findUniqueOrThrow({ where: { id: runId } });
  const attemptsOf = async (runId: string) =>
    (await system.attempt.findMany({ where: { runId }, orderBy: { fence: "asc" } })).map(
      ({ fence, status }) => ({ fence, status }),
    );
  const savedTurns = (runId: string) =>
    system.externalEffect.count({ where: { runId, kind: "runtime_checkpoint" } });
  const stepsOf = (on: ReturnType<typeof startProcess>, runId: string) =>
    on.turnsOf(runId).map((turn) => turn.step);
  /** Lets a test say a minute has passed for the lease heartbeats started from here on. */
  function leaseHeartbeats() {
    const beats: Array<() => void> = [];
    const start = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      beat: () => void,
      everyMs?: number,
    ) => {
      if (everyMs === 60_000) beats.push(AsyncResource.bind(beat));
      return start(beat, everyMs);
    }) as typeof setInterval);
    return () => {
      for (const beat of beats.splice(0)) beat();
    };
  }
  const wake = (on: ReturnType<typeof startProcess>, run: { id: string }) =>
    runAsSystem("run pause fixture", () => wakeRun(on.jobs, run.id));
  /** Starts a run on a process and waits until its first model call is open. */
  async function runInFlight(on: ReturnType<typeof startProcess>, run: { id: string }) {
    await wake(on, run);
    await wait(() => expect(on.turnsOf(run.id)).toHaveLength(1));
    return on.turnsOf(run.id)[0]!;
  }
  const pause = (actor: Actor, botId: string) =>
    runAsTenant(actor, () => pauseBots(prisma, actor, { kind: "bot", botId }));
  const resume = (on: ReturnType<typeof startProcess>, actor: Actor, botId: string) =>
    runAsTenant(actor, () => resumeBots({ prisma, jobs: on.jobs }, actor, { kind: "bot", botId }));

  it("yields at the next step, stays queued with its saved turn while paused, and continues from that turn on resume", async () => {
    const aMinutePasses = leaseHeartbeats();
    const { createRun, botId, actor } = await seedBot();
    const run = await createRun();
    const worker = startProcess("worker", { yields: true });
    await worker.start();
    const first = await runInFlight(worker, run);

    await pause(actor, botId);
    aMinutePasses();
    // The turn in flight is not cut off: only its yield signal tells it the bot is paused.
    await wait(() => expect(first.yieldSignal?.aborted).toBe(true));
    expect(await runRow(run.id)).toMatchObject({ status: "running", leaseOwner: "worker" });
    first.finish.resolve();

    await wait(async () => expect((await runRow(run.id)).status).toBe("queued"));
    expect(await runRow(run.id)).toMatchObject({ error: null, leaseOwner: null });
    // The attempt is closed just after the run is queued.
    await wait(async () =>
      expect(await attemptsOf(run.id)).toEqual([{ fence: 1, status: "interrupted" }]),
    );
    expect(await savedTurns(run.id)).toBe(1);
    const saved = await runAsSystem("run pause fixture", () => loadRunTurnCheckpoint(prisma, run));
    expect((JSON.parse(saved!) as TurnCheckpoint).messages).toHaveLength(1);

    // Held: a delivery that reaches the executor claims nothing and starts no model call.
    await worker.continueRun(run.id);
    expect(await runRow(run.id)).toMatchObject({ status: "queued", leaseOwner: null });
    expect(await attemptsOf(run.id)).toEqual([{ fence: 1, status: "interrupted" }]);
    expect(stepsOf(worker, run.id)).toEqual([0]);

    expect(await resume(worker, actor, botId)).toEqual([botId]);
    await wait(() => expect(stepsOf(worker, run.id)).toEqual([0, 1]));
    worker.turnsOf(run.id)[1]!.finish.resolve();
    await wait(() => expect(stepsOf(worker, run.id)).toEqual([0, 1, 2]));
    worker.turnsOf(run.id)[2]!.finish.resolve();
    await wait(async () => expect((await runRow(run.id)).status).toBe("completed"));

    // Step 0 ran once, in the first attempt; the second continued with the next model call.
    expect(stepsOf(worker, run.id)).toEqual([0, 1, 2]);
    expect(await attemptsOf(run.id)).toEqual([
      { fence: 1, status: "interrupted" },
      { fence: 2, status: "completed" },
    ]);
    expect(await system.message.count({ where: { runId: run.id, role: "bot" } })).toBe(1);
    expect(await savedTurns(run.id)).toBe(0);
  });

  it("tells apps to read again once the yield has queued the run", async () => {
    const aMinutePasses = leaseHeartbeats();
    const { createRun, botId, actor } = await seedBot();
    const run = await createRun();
    const worker = startProcess("worker", { yields: true });
    await worker.start();
    const first = await runInFlight(worker, run);
    await pause(actor, botId);
    aMinutePasses();
    await wait(() => expect(first.yieldSignal?.aborted).toBe(true));
    const published = vi.spyOn(realtime, "publish");

    first.finish.resolve();
    await wait(async () => expect((await runRow(run.id)).status).toBe("queued"));

    await wait(() => {
      expect(published).toHaveBeenCalledWith(`space-changes:${actor.spaceId}`, "runs");
      expect(published).toHaveBeenCalledWith(`roster-space:${actor.spaceId}`, "");
    });
  });

  it("lets a runtime that ignores the yield signal finish its turn, and holds the bot's next run", async () => {
    const aMinutePasses = leaseHeartbeats();
    const { createRun, botId, actor } = await seedBot();
    const run = await createRun();
    const worker = startProcess("worker", { yields: false });
    await worker.start();
    await runInFlight(worker, run);

    await pause(actor, botId);
    aMinutePasses();
    await wait(() => expect(worker.turnsOf(run.id)[0]!.yieldSignal?.aborted).toBe(true));
    for (const step of [0, 1, 2]) {
      await wait(() => expect(stepsOf(worker, run.id)).toHaveLength(step + 1));
      worker.turnsOf(run.id)[step]!.finish.resolve();
    }
    await wait(async () => expect((await runRow(run.id)).status).toBe("completed"));
    expect(await attemptsOf(run.id)).toEqual([{ fence: 1, status: "completed" }]);

    const next = await createRun();
    await wake(worker, next);
    await worker.continueRun(next.id);
    expect(await runRow(next.id)).toMatchObject({ status: "queued", leaseOwner: null });
    expect(await attemptsOf(next.id)).toEqual([]);
    expect(worker.turnsOf(next.id)).toHaveLength(0);
  });

  it("leaves runs waiting on a person and the bot's computer as they were", async () => {
    const { createRun, botId, computerId, actor } = await seedBot();
    const asking = await createRun("waiting_input");
    const takeover = await createRun("waiting_takeover");

    await pause(actor, botId);

    expect((await runRow(asking.id)).status).toBe("waiting_input");
    expect((await runRow(takeover.id)).status).toBe("waiting_takeover");
    expect((await system.computer.findUniqueOrThrow({ where: { id: computerId } })).state).toBe(
      "running",
    );
  });
});

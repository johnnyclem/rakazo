import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import type { RunHold } from "./run-attempt.js";
import { holdRun, turnYieldSignal } from "./run-attempt.js";

const HEARTBEAT_MS = 60_000;

/** The one bot a run belongs to, and the run rows the heartbeat renews. */
function fixture() {
  const bot = { pausedAt: null as Date | null, readFails: false };
  const prisma = {
    run: { updateMany: vi.fn(async () => ({ count: 1 })) },
    bot: {
      findUnique: vi.fn(async () => {
        if (bot.readFails) throw new Error("connection reset");
        return { pausedAt: bot.pausedAt };
      }),
    },
  };
  const baseDeps = { prisma, events: {}, secrets: [] } as unknown as ExecutorDeps;
  const claim = {
    run: { botId: "bot-1" },
    runId: "run-1",
    workerId: "worker-1",
    fence: 1,
    computerLease: null,
  } as unknown as Parameters<typeof holdRun>[1];
  return { bot, prisma, hold: holdRun(baseDeps, claim) };
}

/** One heartbeat, with the reads it started allowed to finish. */
async function aMinutePasses() {
  await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
}

describe("a run whose bot is paused while it works", () => {
  let hold: RunHold | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    if (hold) clearInterval(hold.heartbeat);
    hold = undefined;
    vi.useRealTimers();
  });

  it("signals a pause at the first heartbeat after it, and not before", async () => {
    const f = fixture();
    hold = f.hold;
    await aMinutePasses();
    expect(hold.pause.signal.aborted).toBe(false);

    f.bot.pausedAt = new Date();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
    expect(hold.pause.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(hold.pause.signal.aborted).toBe(true);
    // The lease is still the attempt's own: yielding is not a lost lease.
    expect(hold.lease.valid).toBe(true);
  });

  it("keeps working through a failed read of the pause and sees it at the next heartbeat", async () => {
    const f = fixture();
    hold = f.hold;
    f.bot.pausedAt = new Date();
    f.bot.readFails = true;
    await aMinutePasses();
    expect(hold.pause.signal.aborted).toBe(false);
    expect(hold.lease.valid).toBe(true);

    f.bot.readFails = false;
    await aMinutePasses();
    expect(hold.pause.signal.aborted).toBe(true);
  });

  it("stops reading the pause once the attempt completed", async () => {
    const f = fixture();
    hold = f.hold;
    hold.stopHeartbeatAfterCompletion();
    f.bot.pausedAt = new Date();
    await aMinutePasses();

    expect(f.prisma.bot.findUnique).not.toHaveBeenCalled();
    expect(hold.pause.signal.aborted).toBe(false);
  });
});

describe("the signal that ends a turn at its next step", () => {
  it("aborts when either the process is stopping or the bot is paused", () => {
    const stopping = new AbortController();
    const pause = new AbortController();
    const signal = turnYieldSignal(stopping.signal, pause.signal);
    expect(signal.aborted).toBe(false);
    pause.abort();
    expect(signal.aborted).toBe(true);

    const other = new AbortController();
    const stoppingFirst = turnYieldSignal(other.signal, new AbortController().signal);
    other.abort();
    expect(stoppingFirst.aborted).toBe(true);
  });

  it("follows the pause alone on a process that has no stopping signal", () => {
    const pause = new AbortController();
    const signal = turnYieldSignal(undefined, pause.signal);
    expect(signal.aborted).toBe(false);
    pause.abort();
    expect(signal.aborted).toBe(true);
  });
});

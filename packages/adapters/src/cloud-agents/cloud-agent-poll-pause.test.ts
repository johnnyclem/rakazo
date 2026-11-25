import type { CloudAgent } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import type { CloudAgentDeps } from "./cloud-agent-service.js";

const base = {
  id: "agent-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  threadId: "thread-1",
  messageId: "message-1",
  providerKey: "deployment",
  remoteId: null,
  launchRequest: { prompt: "Fix the build" },
  launchDispatched: false,
  followup: null,
  followupDispatchedAt: null,
  cancelRequested: false,
  status: "running",
  nextPollAt: new Date(0),
  errorCount: 0,
  version: 1,
  generation: 1,
  wakeGeneration: 1,
} as unknown as CloudAgent;

/** Polls `agent` while its bot is paused, against a provider that records what reaches it. */
async function pollPaused(agent: CloudAgent) {
  const found = { id: "found" };
  const provider = {
    launch: vi.fn(async () => ({ id: "remote-1", status: "running" })),
    reply: vi.fn(async () => ({ id: "remote-1", status: "running", latestRunId: "run-2" })),
    get: vi.fn(async () => ({ id: "remote-1", status: "running", latestRunId: "run-1" })),
    cancel: vi.fn(async () => ({ id: "remote-1", status: "cancelled", latestRunId: "run-1" })),
  };
  const tx = {
    thread: { updateMany: vi.fn(async () => ({ count: 1 })) },
    message: { findFirst: vi.fn(async () => ({ id: "message-1", blocks: [] })), update: vi.fn() },
    spaceMember: { findUnique: vi.fn(async () => found) },
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1", pausedAt: new Date() })) },
    cloudAgent: {
      findUnique: vi.fn(async () => agent),
      findUniqueOrThrow: vi.fn(async () => agent),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    event: { create: vi.fn(async () => ({ seq: 1 })) },
    $queryRaw: vi.fn(async () => [{ fence: 1n }]),
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const jobs = { enqueue: vi.fn(async () => undefined) };
  await pollCloudAgent(
    {
      prisma,
      jobs,
      events: { notify: vi.fn(async () => undefined) },
      cloudAgent: { key: "deployment", spaceId: "space-1", provider },
    } as unknown as CloudAgentDeps,
    { agentId: agent.id },
  );
  return { provider, tx, jobs };
}

describe("cloud agent work for a paused bot", () => {
  it("holds a launch that was queued before the pause", async () => {
    const { provider, tx } = await pollPaused(base);

    expect(provider.launch).not.toHaveBeenCalled();
    expect(tx.cloudAgent.updateMany).not.toHaveBeenCalled();
  });

  it("holds a follow-up that was queued before the pause", async () => {
    const { provider } = await pollPaused({
      ...base,
      remoteId: "remote-1",
      latestRunId: "run-1",
      followup: { prompt: "Also add a test" },
    } as unknown as CloudAgent);

    expect(provider.reply).not.toHaveBeenCalled();
  });

  it("still cancels a launched agent", async () => {
    const { provider } = await pollPaused({
      ...base,
      remoteId: "remote-1",
      latestRunId: "run-1",
      cancelRequested: true,
    } as unknown as CloudAgent);

    expect(provider.cancel).toHaveBeenCalledOnce();
  });

  it("keeps watching a launched agent", async () => {
    const { provider } = await pollPaused({
      ...base,
      remoteId: "remote-1",
      latestRunId: "run-1",
    } as unknown as CloudAgent);

    expect(provider.get).toHaveBeenCalledOnce();
  });
});

import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};

function client() {
  const prisma = {
    bot: { updateManyAndReturn: vi.fn(async () => [{ id: "bot-1" }]) },
    run: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => [{ id: "run-1" }]),
    },
    $transaction: (run: (tx: unknown) => unknown) => run(prisma),
  };
  const events = {
    publishRosterChange: vi.fn(async () => undefined),
    publishSpaceChange: vi.fn(async () => undefined),
  };
  const jobs = { enqueue: vi.fn(async () => undefined) };
  const router = createRouter({ prisma, events, jobs } as unknown as RouterDeps);
  return { rpc: createRouterClient(router, { context: { actor } }), events, jobs };
}

describe("fleet pause and resume", () => {
  it("pauses and tells the Space's roster and activity", async () => {
    const { rpc, events } = client();

    expect(await rpc.fleet.pause({ scope: { kind: "space" } })).toEqual({ botIds: ["bot-1"] });

    expect(events.publishRosterChange).toHaveBeenCalledWith({ spaceIds: ["space-1"] });
    expect(events.publishSpaceChange).toHaveBeenCalledWith("space-1", "runs");
  });

  it("resumes, starts each held run and tells the Space", async () => {
    const { rpc, events, jobs } = client();

    expect(await rpc.fleet.resume({ scope: { kind: "space" } })).toEqual({ botIds: ["bot-1"] });

    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-1" } }),
    );
    expect(events.publishRosterChange).toHaveBeenCalledWith({ spaceIds: ["space-1"] });
    expect(events.publishSpaceChange).toHaveBeenCalledWith("space-1", "runs");
  });
});

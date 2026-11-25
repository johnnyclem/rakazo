import type { JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { FleetPauseScope, PrismaClient } from "@rakazo/db";
import { unpauseBots } from "@rakazo/db";
import { wakeRun } from "../runs/wakeups/wake-run.js";

/**
 * Lifts the pause of the scope's paused bots, then starts each run they held. A run that is
 * not due yet keeps its own wake time. Returns the ids of the bots that were paused.
 */
export async function resumeBots(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  actor: Actor,
  scope: FleetPauseScope,
): Promise<string[]> {
  const botIds = await unpauseBots(deps.prisma, actor, scope);
  if (botIds.length === 0) return botIds;
  const held = await deps.prisma.run.findMany({
    where: { botId: { in: botIds }, status: "queued" },
    select: { id: true },
  });
  await Promise.all(held.map((run) => wakeRun(deps.jobs, run.id, { keepExisting: true })));
  return botIds;
}

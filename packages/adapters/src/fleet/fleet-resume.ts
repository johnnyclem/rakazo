import type { JobPublisher } from "@rakazo/adapter-kit";
import { teamChatAmbientJob } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { FleetPauseScope, PrismaClient } from "@rakazo/db";
import { runAsSystem, unpauseBots } from "@rakazo/db";
import { wakeRun } from "../runs/wakeups/wake-run.js";

/**
 * Lifts the pause of the scope's paused bots, then starts each run they held. A run that is
 * not due yet keeps its own wake time. Work that only a sweep or a webhook would pick up again
 * is asked for here: the decision on a room's waiting messages, and the calendar syncs that
 * book meetings for these bots. Returns the ids of the bots that were paused.
 */
export async function resumeBots(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  actor: Actor,
  scope: FleetPauseScope,
): Promise<string[]> {
  const botIds = await unpauseBots(deps.prisma, actor, scope);
  if (botIds.length === 0) return botIds;
  const [held, rooms, rules] = await Promise.all([
    deps.prisma.run.findMany({
      where: { botId: { in: botIds }, status: "queued" },
      select: { id: true },
    }),
    deps.prisma.externalConversation.findMany({
      where: { botId: { in: botIds }, messages: { some: { status: "observed" } } },
      select: { id: true },
    }),
    // A calendar belongs to its owner, who need not be the person resuming the bots.
    runAsSystem("find the calendars that book meetings for resumed bots", () =>
      deps.prisma.meetingCalendarRule.findMany({
        where: { botId: { in: botIds } },
        distinct: ["connectionId"],
        select: { connectionId: true },
      }),
    ),
  ]);
  const now = new Date();
  await Promise.all([
    ...held.map((run) => wakeRun(deps.jobs, run.id, { keepExisting: true })),
    ...rooms.map((room) => deps.jobs.enqueue(teamChatAmbientJob(room.id, now))),
    ...rules.map(({ connectionId }) =>
      deps.jobs.enqueue({
        name: "meeting.calendar-sync",
        payload: { connectionId },
        queueName: `meeting-calendar:${connectionId}`,
        replaceKey: `meeting-calendar:resume:${connectionId}`,
        availableAt: now,
      }),
    ),
  ]);
  return botIds;
}

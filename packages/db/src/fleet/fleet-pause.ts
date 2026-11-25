import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "../database/client.js";
import { IsolationError } from "../database/scope.js";

/** Which bots a pause or resume acts on, as `fleet.pause` receives it. */
export type FleetPauseScope =
  | { kind: "bot"; botId: string }
  | { kind: "group"; groupId: string }
  | { kind: "space" };

/** The Space's live bots the scope names; a bot or group that is not the actor's is not found. */
async function scopedBots(
  prisma: Pick<PrismaClient, "chatGroup" | "bot">,
  actor: Actor,
  scope: FleetPauseScope,
): Promise<Prisma.BotWhereInput> {
  const live = { spaceId: actor.spaceId, archivedAt: null };
  if (scope.kind === "space") return live;
  if (scope.kind === "bot") {
    const bot = await prisma.bot.findFirst({ where: { ...live, id: scope.botId } });
    if (!bot) throw new IsolationError();
    return { ...live, id: scope.botId };
  }
  const group = await prisma.chatGroup.findFirst({
    where: { id: scope.groupId, spaceId: actor.spaceId, archivedAt: null },
    select: { id: true },
  });
  if (!group) throw new IsolationError();
  return { ...live, groupMembers: { some: { groupId: scope.groupId } } };
}

/**
 * Pauses the scope's bots that are not paused yet and returns their ids. A bot already paused
 * keeps its first pause time, so repeating the call changes nothing.
 */
export async function pauseBots(
  prisma: PrismaClient,
  actor: Actor,
  scope: FleetPauseScope,
  now = new Date(),
): Promise<string[]> {
  const where = await scopedBots(prisma, actor, scope);
  const paused = await prisma.bot.updateManyAndReturn({
    where: { ...where, pausedAt: null },
    data: { pausedAt: now },
    select: { id: true },
  });
  return paused.map((bot) => bot.id);
}

/**
 * Clears the pause of the scope's paused bots and returns their ids. Their queued runs count as
 * queued from now, so time spent held is not stuck time to the sweep that cancels old runs.
 */
export async function unpauseBots(
  prisma: PrismaClient,
  actor: Actor,
  scope: FleetPauseScope,
  now = new Date(),
): Promise<string[]> {
  const where = await scopedBots(prisma, actor, scope);
  return prisma.$transaction(async (tx) => {
    const resumed = await tx.bot.updateManyAndReturn({
      where: { ...where, pausedAt: { not: null } },
      data: { pausedAt: null },
      select: { id: true },
    });
    const botIds = resumed.map((bot) => bot.id);
    if (botIds.length > 0) {
      await tx.run.updateMany({
        where: { botId: { in: botIds }, status: "queued" },
        data: { updatedAt: now },
      });
    }
    return botIds;
  });
}

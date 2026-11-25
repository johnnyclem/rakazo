import { resumeBots } from "@rakazo/adapters";
import { pauseBots } from "@rakazo/db";
import type { RouterContext } from "./context.js";

/** Commands over several bots at once. Any member of the Space may pause or resume its bots. */
export function fleetRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    fleet: {
      pause: authed.fleet.pause.handler(async ({ context, input }) => ({
        botIds: await pauseBots(deps.prisma, context.actor, input.scope),
      })),
      resume: authed.fleet.resume.handler(async ({ context, input }) => ({
        botIds: await resumeBots(deps, context.actor, input.scope),
      })),
    },
  };
}

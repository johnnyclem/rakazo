import {
  addOwnerKey,
  listOwnerKeys,
  removeOwnerKey,
  requireSpaceOwner,
  shouldOfferOwnerKey,
} from "@rakazo/adapters";
import { runAsSystem } from "@rakazo/db";
import type { RouterContext } from "./context.js";

/** The keys the current Space's record ledger is sealed to, for its owner to hold. */
export function recordLedgerRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const { prisma } = deps;
  // The tables are not the tenant's to read, so each call checks ownership itself and then runs
  // as the system on the owner's own Space.
  const asOwner = <T>(
    actor: { spaceId: string; userId: string },
    run: (spaceId: string) => Promise<T>,
  ) =>
    runAsSystem("manage a Space's record ledger keys for its owner", async () => {
      await requireSpaceOwner(prisma, actor);
      return run(actor.spaceId);
    });
  return {
    recordLedger: {
      keys: authed.recordLedger.keys.handler(({ context }) =>
        asOwner(context.actor, (spaceId) => listOwnerKeys(prisma, spaceId)),
      ),
      // Asked by every new account's onboarding, so it answers no rather than refusing.
      offer: authed.recordLedger.offer.handler(({ context }) =>
        deps.recordLedgerEnabled
          ? runAsSystem(
              "decide whether a new account is offered a record ledger key",
              async () => ({
                offer: await shouldOfferOwnerKey(prisma, context.actor),
              }),
            )
          : { offer: false },
      ),
      addKey: authed.recordLedger.addKey.handler(({ context, input }) =>
        asOwner(context.actor, async (spaceId) => {
          await addOwnerKey(prisma, spaceId, input.recipient);
          return listOwnerKeys(prisma, spaceId);
        }),
      ),
      removeKey: authed.recordLedger.removeKey.handler(({ context, input }) =>
        asOwner(context.actor, async (spaceId) => {
          await removeOwnerKey(prisma, spaceId, input.recipient);
          return listOwnerKeys(prisma, spaceId);
        }),
      ),
    },
  };
}

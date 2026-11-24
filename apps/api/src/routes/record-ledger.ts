import {
  AnchoringUnavailableError,
  addOwnerKey,
  clearSpaceDestination,
  describeSpaceAnchor,
  describeSpaceProvision,
  listOwnerKeys,
  ProvisionUnavailableError,
  removeOwnerKey,
  requireSpaceOwner,
  setSpaceDestination,
  shouldOfferOwnerKey,
  startSpaceProvision,
} from "@rakazo/adapters";
import { runAsSystem, spaceHasPaidPlan } from "@rakazo/db";
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
  // A deployment that charges lets only a paid plan have a place made for it; one that does not
  // is spending its operator's own cycles, which the operator allowed by setting the ledger up.
  const planAllows = (spaceId: string) =>
    deps.billing ? spaceHasPaidPlan(prisma, spaceId) : Promise.resolve(true);
  /** Where the Space's backups are kept, and whether a place can be made for its owner. */
  const anchorView = async (spaceId: string) => {
    const ledger = deps.recordLedger;
    if (!ledger) {
      return {
        label: null,
        writer: null,
        destination: null,
        status: null,
        provision: { offered: false, state: null, payment: null },
      };
    }
    const [anchor, provision] = await Promise.all([
      describeSpaceAnchor(prisma, ledger, spaceId),
      describeSpaceProvision(prisma, ledger, spaceId, await planAllows(spaceId)),
    ]);
    return { ...anchor, provision };
  };
  return {
    recordLedger: {
      keys: authed.recordLedger.keys.handler(({ context }) =>
        asOwner(context.actor, (spaceId) => listOwnerKeys(prisma, spaceId)),
      ),
      // Asked by every new account's onboarding, so it answers no rather than refusing.
      offer: authed.recordLedger.offer.handler(({ context }) =>
        deps.recordLedger
          ? runAsSystem(
              "decide whether a new account is offered a record ledger key",
              async () => ({
                offer: await shouldOfferOwnerKey(prisma, context.actor),
              }),
            )
          : { offer: false },
      ),
      // Where the Space's backups are kept off-site, for the owner to say and to watch.
      anchor: authed.recordLedger.anchor.handler(({ context }) =>
        asOwner(context.actor, anchorView),
      ),
      setAnchor: authed.recordLedger.setAnchor.handler(({ context, input }) =>
        asOwner(context.actor, async (spaceId) => {
          if (!deps.recordLedger) throw new AnchoringUnavailableError();
          await setSpaceDestination(prisma, deps.recordLedger, spaceId, input.destination);
          return anchorView(spaceId);
        }),
      ),
      clearAnchor: authed.recordLedger.clearAnchor.handler(({ context }) =>
        asOwner(context.actor, async (spaceId) => {
          if (!deps.recordLedger) throw new AnchoringUnavailableError();
          await clearSpaceDestination(prisma, deps.recordLedger, spaceId);
          return anchorView(spaceId);
        }),
      ),
      // Has the ledger make a place for the owner and hand it over; it finishes in the background.
      provision: authed.recordLedger.provision.handler(({ context, input }) =>
        asOwner(context.actor, async (spaceId) => {
          if (!deps.recordLedger) throw new ProvisionUnavailableError();
          await startSpaceProvision(prisma, deps.recordLedger, spaceId, input.ownerKey, {
            planAllows: await planAllows(spaceId),
            onChanged: (changed) => void deps.events.publishSpaceChange?.(changed, "recordLedger"),
          });
          return anchorView(spaceId);
        }),
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

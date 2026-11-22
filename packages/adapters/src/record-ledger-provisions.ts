import type { RecordLedgerProvider } from "@rakazo/adapter-kit";
import { RecordLedgerProvisionRefused, RecordLedgerUnavailable } from "@rakazo/adapter-kit";
import type { RecordLedgerProvision } from "@rakazo/contracts";
import { ClientError, deadlineSignal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { DestinationInvalidError, setSpaceDestination } from "./record-ledger-destinations.js";

/** Requests looked at per pass: a deployment with more is brought up to date over a few. */
const BATCH = 50;
const CALL_TIMEOUT_MS = 10_000;
/** A request that failed is asked again after this long, so one that keeps failing does not run every sweep. */
const RETRY_AFTER_MS = 5 * 60_000;
/** Marks a request the ledger refused for good, which no later pass can change. */
const REFUSED = "refused:";

/** The ledger cannot make a place for this owner: it was not set up to. */
export class ProvisionUnavailableError extends ClientError {
  constructor() {
    super("NOT_FOUND", "This deployment cannot make a place for your backups");
    this.name = "ProvisionUnavailableError";
  }
}

/** Making a place is part of a paid plan. */
export class ProvisionPlanRequiredError extends ClientError {
  constructor() {
    super("FORBIDDEN", "Making a place for your backups needs a paid plan", "plan_required");
    this.name = "ProvisionPlanRequiredError";
  }
}

/** The Space already names a place, or already asked for one with another key. */
export class ProvisionExistsError extends ClientError {
  constructor(message: string) {
    super("CONFLICT", message, "provision_exists");
    this.name = "ProvisionExistsError";
  }
}

/** What the ledger knows one Space's request by: the same Space asking twice asks once. */
const requestKey = (spaceId: string) => `space-${spaceId}`;

export interface ProvisionHooks {
  /** Called after a Space's request changes where it has got to, so open screens can read it again. */
  onChanged?: (spaceId: string) => void;
}

/** Whether the ledger can make a place: yes, no, or unknown while it cannot be reached. */
async function probe(provider: RecordLedgerProvider): Promise<"yes" | "no" | "unknown"> {
  // A place is only useful where the ledger can also keep streams at it.
  if (!provider.provisioning || !provider.anchoring) return "no";
  try {
    return (await provider.provisioning.available(deadlineSignal(CALL_TIMEOUT_MS))) ? "yes" : "no";
  } catch (error) {
    if (error instanceof RecordLedgerUnavailable) return "unknown";
    throw error;
  }
}

/** Whether a place can be made now. A ledger that cannot be reached is not offered. */
export async function canProvision(provider: RecordLedgerProvider): Promise<boolean> {
  return (await probe(provider)) === "yes";
}

/**
 * Asks the ledger to make a place for the owner who holds `ownerKey`, and keeps asking until it is
 * ready. Once it is, it becomes the Space's place. Repeating the same request changes nothing.
 */
export async function startSpaceProvision(
  prisma: PrismaClient,
  provider: RecordLedgerProvider,
  spaceId: string,
  ownerKey: string,
  options: ProvisionHooks & { planAllows: boolean },
): Promise<void> {
  if (!options.planAllows) throw new ProvisionPlanRequiredError();
  // Only a definite no refuses: a ledger that is briefly unreachable keeps the request, which a
  // later pass finishes, rather than turn away someone who has just saved their key.
  if ((await probe(provider)) === "no") throw new ProvisionUnavailableError();
  const [named, existing] = await Promise.all([
    prisma.recordLedgerDestination.findUnique({ where: { spaceId }, select: { spaceId: true } }),
    prisma.recordLedgerProvision.findUnique({ where: { spaceId } }),
  ]);
  if (existing && existing.ownerKey !== ownerKey) {
    throw new ProvisionExistsError("This Space already asked for a place with another key");
  }
  if (!existing) {
    if (named) throw new ProvisionExistsError("This Space already names a place");
    await prisma.recordLedgerProvision.create({ data: { spaceId, ownerKey } });
  }
  // The owner is waiting, so try now; a ledger that cannot be reached is for the next pass to find.
  try {
    await syncProvisions(prisma, provider, { spaceId, onChanged: options.onChanged, now: true });
  } catch (error) {
    if (!(error instanceof RecordLedgerUnavailable)) throw error;
  }
}

/**
 * Brings every request that is not ready up to date: asks the ledger, records where it has got to,
 * and makes a ready place the Space's own. Throws what the ledger throws, at the first request it
 * fails for; callers carry on without it and try again next pass.
 */
export async function syncProvisions(
  prisma: PrismaClient,
  provider: RecordLedgerProvider,
  options: ProvisionHooks & { spaceId?: string; now?: boolean } = {},
): Promise<void> {
  const { provisioning } = provider;
  if (!provisioning) return;
  const retryBefore = new Date(Date.now() - RETRY_AFTER_MS);
  const rows = await prisma.recordLedgerProvision.findMany({
    where: {
      ...(options.spaceId ? { spaceId: options.spaceId } : {}),
      OR: [
        { state: "pending" },
        // Asked for directly, a failed request is tried at once; in a sweep it waits its turn.
        {
          state: "failed",
          NOT: { error: { startsWith: REFUSED } },
          ...(options.now ? {} : { updatedAt: { lt: retryBefore } }),
        },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: BATCH,
  });
  for (const row of rows) {
    let snapshot: { state: string; destination: string | null; error: string | null };
    try {
      snapshot = await provisioning.begin(
        requestKey(row.spaceId),
        row.ownerKey,
        deadlineSignal(CALL_TIMEOUT_MS),
      );
    } catch (error) {
      if (!(error instanceof RecordLedgerProvisionRefused)) throw error;
      getLogger().warn("record.ledger.provision_refused", { "record.ledger.reason": error.reason });
      await prisma.recordLedgerProvision.update({
        where: { spaceId: row.spaceId },
        data: { state: "failed", error: `${REFUSED}${error.reason}` },
      });
      options.onChanged?.(row.spaceId);
      continue;
    }
    const ready = snapshot.state === "ready" && snapshot.destination !== null;
    await prisma.recordLedgerProvision.update({
      where: { spaceId: row.spaceId },
      data: {
        state: ready ? "ready" : snapshot.state,
        destination: snapshot.destination,
        error: snapshot.error,
      },
    });
    if (ready) await bindDestination(prisma, provider, row.spaceId, snapshot.destination!);
    if (snapshot.state !== row.state) options.onChanged?.(row.spaceId);
  }
}

/** Makes a ready place the Space's, unless its owner named one of their own in the meantime. */
async function bindDestination(
  prisma: PrismaClient,
  provider: RecordLedgerProvider,
  spaceId: string,
  destination: string,
): Promise<void> {
  const named = await prisma.recordLedgerDestination.findUnique({
    where: { spaceId },
    select: { spaceId: true },
  });
  if (named) return;
  try {
    await setSpaceDestination(prisma, provider, spaceId, destination);
  } catch (error) {
    // The place was made but cannot be used: say so rather than retry what cannot change.
    if (!(error instanceof DestinationInvalidError)) throw error;
    getLogger().warn("record.ledger.provision_destination_invalid", {
      "record.ledger.space": spaceId,
    });
    await prisma.recordLedgerProvision.update({
      where: { spaceId },
      data: { state: "failed", error: `${REFUSED}invalid_destination` },
    });
  }
}

/**
 * Whether a place can be made for the Space's owner now, and how a request for one has got to.
 * `planAllows` is the deployment's own rule for who may have one.
 */
export async function describeSpaceProvision(
  prisma: PrismaClient,
  provider: RecordLedgerProvider,
  spaceId: string,
  planAllows: boolean,
): Promise<RecordLedgerProvision> {
  const [row, named] = await Promise.all([
    prisma.recordLedgerProvision.findUnique({ where: { spaceId }, select: { state: true } }),
    prisma.recordLedgerDestination.findUnique({ where: { spaceId }, select: { spaceId: true } }),
  ]);
  const state = row ? (row.state as NonNullable<RecordLedgerProvision["state"]>) : null;
  // Only ask the ledger when everything else says it would be offered.
  const offered = !row && !named && planAllows && (await canProvision(provider));
  return { offered, state };
}

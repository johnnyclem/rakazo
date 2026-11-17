import type { RecordLedgerAnchoring, RecordLedgerProvider } from "@rakazo/adapter-kit";
import { RecordLedgerDestinationInvalid, RecordLedgerUnavailable } from "@rakazo/adapter-kit";
import type { RecordLedgerAnchor } from "@rakazo/contracts";
import { ClientError, deadlineSignal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";

/** Streams told about their destination per pass: a Space with more is brought up to date over a few. */
const SYNC_BATCH = 100;
/** Streams asked about when saying how a Space's backups are doing, and how many at once. */
const STATUS_STREAMS = 25;
const STATUS_CONCURRENCY = 5;
const CALL_TIMEOUT_MS = 10_000;

/** What an owner named is not a place the ledger can keep their backups. */
export class DestinationInvalidError extends ClientError {
  constructor(label: string) {
    super("BAD_REQUEST", `That is not a valid ${label.toLowerCase()}`);
    this.name = "DestinationInvalidError";
  }
}

/** The ledger does not offer a place of the owner's own. */
export class AnchoringUnavailableError extends ClientError {
  constructor() {
    super("NOT_FOUND", "This deployment cannot keep backups somewhere of your own");
    this.name = "AnchoringUnavailableError";
  }
}

const unavailable: RecordLedgerAnchor = {
  label: null,
  writer: null,
  destination: null,
  status: null,
};

/**
 * Tells the ledger where each stream's off-site copy is kept, for every stream whose Space names a
 * place the ledger was not last told, and puts back with the rest those whose Space no longer does.
 * Streams new to the ledger are told before their first entries are sent. Throws what the ledger
 * throws, at the first stream it fails for: callers carry on without it and try again next pass.
 */
export async function syncDestinations(
  prisma: PrismaClient,
  provider: RecordLedgerProvider,
  options: { spaceId?: string } = {},
): Promise<void> {
  const { anchoring } = provider;
  if (!anchoring) return;
  const rows = await prisma.$queryRaw<Array<{ id: string; destination: string | null }>>(Prisma.sql`
    SELECT s.id, d.destination
    FROM record_ledger_streams s
    LEFT JOIN record_ledger_destinations d ON d."spaceId" = s."spaceId"
    WHERE s."destinationSynced" IS DISTINCT FROM d.destination
      ${options.spaceId ? Prisma.sql`AND s."spaceId" = ${options.spaceId}` : Prisma.empty}
    ORDER BY s.id
    LIMIT ${SYNC_BATCH}`);
  for (const row of rows) {
    await anchoring.setDestination(row.id, row.destination, deadlineSignal(CALL_TIMEOUT_MS));
    await prisma.recordLedgerStream.update({
      where: { id: row.id },
      data: { destinationSynced: row.destination },
    });
  }
}

/** Runs a sync that the owner is waiting on: an unreachable ledger is for the next pass to find. */
async function syncNow(
  prisma: PrismaClient,
  provider: RecordLedgerProvider,
  spaceId: string,
): Promise<void> {
  try {
    await syncDestinations(prisma, provider, { spaceId });
  } catch (error) {
    if (!(error instanceof RecordLedgerUnavailable)) throw error;
  }
}

/** Keeps `destination` as where the Space's backups are kept off-site, and tells the ledger. */
export async function setSpaceDestination(
  prisma: PrismaClient,
  provider: RecordLedgerProvider,
  spaceId: string,
  destination: string,
): Promise<void> {
  const { anchoring } = provider;
  if (!anchoring) throw new AnchoringUnavailableError();
  try {
    anchoring.validate(destination);
  } catch (error) {
    if (error instanceof RecordLedgerDestinationInvalid)
      throw new DestinationInvalidError(anchoring.label);
    throw error;
  }
  const previous = await prisma.recordLedgerDestination.findUnique({
    where: { spaceId },
    select: { destination: true },
  });
  await prisma.recordLedgerDestination.upsert({
    where: { spaceId },
    create: { spaceId, destination },
    update: { destination },
  });
  try {
    await syncNow(prisma, provider, spaceId);
  } catch (error) {
    if (!(error instanceof RecordLedgerDestinationInvalid)) throw error;
    // The ledger knows more about what is a place than this does: put back what was there.
    if (previous) {
      await prisma.recordLedgerDestination.update({ where: { spaceId }, data: previous });
    } else {
      await prisma.recordLedgerDestination.deleteMany({ where: { spaceId } });
    }
    throw new DestinationInvalidError(anchoring.label);
  }
}

/** Puts the Space's backups back where the ledger keeps its own, and tells the ledger. */
export async function clearSpaceDestination(
  prisma: PrismaClient,
  provider: RecordLedgerProvider,
  spaceId: string,
): Promise<void> {
  // A ledger that cannot keep a place of the owner's own leaves what they named as it was.
  if (!provider.anchoring) throw new AnchoringUnavailableError();
  await prisma.recordLedgerDestination.deleteMany({ where: { spaceId } });
  await syncNow(prisma, provider, spaceId);
}

/**
 * Where a Space's backups are kept and how they are doing, for its owner. Nothing is offered where
 * the ledger has no place to give an identity for, unless the Space already names one.
 */
export async function describeSpaceAnchor(
  prisma: PrismaClient,
  provider: RecordLedgerProvider,
  spaceId: string,
): Promise<RecordLedgerAnchor> {
  const { anchoring } = provider;
  if (!anchoring) return unavailable;
  const named = await prisma.recordLedgerDestination.findUnique({
    where: { spaceId },
    select: { destination: true },
  });
  let writer: string | null = null;
  try {
    writer = await anchoring.writer(deadlineSignal(CALL_TIMEOUT_MS));
  } catch (error) {
    if (!(error instanceof RecordLedgerUnavailable)) throw error;
  }
  if (!writer && !named) return unavailable;
  return {
    label: anchoring.label,
    writer,
    destination: named?.destination ?? null,
    status: named ? await anchorStatus(prisma, anchoring, spaceId, named.destination) : null,
  };
}

/** How the first streams of a Space are doing at the place its owner named. */
async function anchorStatus(
  prisma: PrismaClient,
  anchoring: RecordLedgerAnchoring,
  spaceId: string,
  destination: string,
): Promise<NonNullable<RecordLedgerAnchor["status"]>> {
  const streams = await prisma.recordLedgerStream.findMany({
    where: { spaceId },
    orderBy: { id: "asc" },
    take: STATUS_STREAMS,
    select: { id: true, destinationSynced: true },
  });
  const states: Array<{ behind: boolean; error: "not_allowed" | "failed" | null }> = [];
  for (let start = 0; start < streams.length; start += STATUS_CONCURRENCY) {
    states.push(
      ...(await Promise.all(
        streams.slice(start, start + STATUS_CONCURRENCY).map(async (stream) => {
          // Not yet told the place, or not yet sent anything: behind, with nothing to blame.
          if (stream.destinationSynced !== destination) return { behind: true, error: null };
          try {
            const state = await anchoring.status(stream.id, deadlineSignal(CALL_TIMEOUT_MS));
            return {
              behind:
                !state || state.destination !== destination || state.anchoredSeq < state.headSeq,
              error: state?.error ?? null,
            };
          } catch (error) {
            if (!(error instanceof RecordLedgerUnavailable)) throw error;
            return { behind: true, error: "failed" as const };
          }
        }),
      )),
    );
  }
  const errors = states.flatMap((state) => (state.error ? [state.error] : []));
  return {
    streams: streams.length,
    behind: states.filter((state) => state.behind).length,
    error: errors.includes("not_allowed") ? "not_allowed" : (errors[0] ?? null),
  };
}

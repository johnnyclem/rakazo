import type { Prisma } from "../database/client.js";
import { createRowId } from "../database/row-id.js";

/**
 * Seals a new Space's record ledger to the owner keys its owner already holds, so that what the
 * Space records from its first row on is readable with the key they have, and by nothing else.
 * It must run in the transaction that creates the Space: a Space with no key begins under the
 * deployment's master key the moment something is recorded in it, and a ledger cannot be
 * rewritten.
 *
 * The keys come from the Space it was made from when they own it, else from the oldest Space they
 * own, and are copied as they are. Returns how many were copied.
 */
export async function inheritRecordLedgerKeys(
  tx: Prisma.TransactionClient,
  input: { userId: string; spaceId: string; fromSpaceId?: string },
): Promise<number> {
  const owned = await tx.spaceMember.findMany({
    where: { userId: input.userId, role: "owner", spaceId: { not: input.spaceId } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { spaceId: true },
  });
  const source = owned.find((space) => space.spaceId === input.fromSpaceId) ?? owned[0];
  if (!source) return 0;
  const keys = await tx.recordLedgerRecipient.findMany({
    where: { spaceId: source.spaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { recipient: true, label: true },
  });
  if (!keys.length) return 0;
  const { count } = await tx.recordLedgerRecipient.createMany({
    data: keys.map((key) => ({ id: createRowId(), spaceId: input.spaceId, ...key })),
    skipDuplicates: true,
  });
  return count;
}

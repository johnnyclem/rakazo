import type { RecordLedgerKeys } from "@rakazo/contracts";
import { MAX_OWNER_KEYS } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createRowId } from "@rakazo/db";
import { advisoryLock } from "../locks/advisory-lock.js";
import { SPACE_KEY_KIND } from "./record-ledger-format.js";
import { assertRecipient } from "./record-ledger-owner-keys.js";

/** The Space already has as many owner keys as it may. */
export class OwnerKeyLimitError extends ClientError {
  constructor() {
    super(
      "CONFLICT",
      `A Space can be sealed to at most ${MAX_OWNER_KEYS} keys. Remove one to add another.`,
      "owner_key_limit",
    );
    this.name = "OwnerKeyLimitError";
  }
}

export class OwnerKeysForbiddenError extends ClientError {
  constructor() {
    super("FORBIDDEN", "Only the Space's owner can manage its backup keys");
    this.name = "OwnerKeysForbiddenError";
  }
}

/**
 * Throws unless `userId` owns the Space. Owner keys decide who can read a Space's ledger, so the
 * same people who can delete the Space decide them. Reads the membership across tenants, so it
 * must run as the system, with the caller's own ids.
 */
export async function requireSpaceOwner(
  prisma: PrismaClient,
  scope: { spaceId: string; userId: string },
): Promise<void> {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } },
    select: { role: true },
  });
  if (member?.role !== "owner") throw new OwnerKeysForbiddenError();
}

/** The keys a Space's ledger is sealed to, oldest first, and whether the master key also opens it. */
export async function listOwnerKeys(
  prisma: PrismaClient,
  spaceId: string,
): Promise<RecordLedgerKeys> {
  const [rows, announced] = await Promise.all([
    prisma.recordLedgerRecipient.findMany({
      where: { spaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { recipient: true, label: true, createdAt: true },
    }),
    // A key announced under the master key is what a stream that began before any owner key holds.
    prisma.recordLedgerEntry.findFirst({
      where: { kind: SPACE_KEY_KIND, stream: { spaceId } },
      select: { id: true },
    }),
  ]);
  return {
    keys: rows.map((row) => ({
      recipient: row.recipient,
      label: row.label,
      createdAt: row.createdAt.toISOString(),
    })),
    earlier: announced !== null,
  };
}

/**
 * Whether `userId` should be asked for a key for this Space now. That is while a key still seals
 * everything: the Space is the only one they own, has no key, and no stream of it has announced
 * its key to the master key. It is the moment right after signup, before anything is recorded.
 * Anyone who does not own the Space, or owns others, is not asked.
 */
export async function shouldOfferOwnerKey(
  prisma: PrismaClient,
  scope: { spaceId: string; userId: string },
): Promise<boolean> {
  const [owned, held] = await Promise.all([
    prisma.spaceMember.findMany({
      where: { userId: scope.userId, role: "owner" },
      select: { spaceId: true },
      take: 2,
    }),
    listOwnerKeys(prisma, scope.spaceId),
  ]);
  return (
    owned.length === 1 && owned[0]!.spaceId === scope.spaceId && !held.keys.length && !held.earlier
  );
}

/**
 * Seals the Space's ledger to `recipient` as well, from the next sealing pass. Returns false when
 * it already was. Throws for something that is not an age public key, or past the limit.
 */
export async function addOwnerKey(
  prisma: PrismaClient,
  spaceId: string,
  recipient: string,
  label: string | null = null,
): Promise<boolean> {
  await assertRecipient(recipient);
  return prisma.$transaction(async (tx) => {
    await advisoryLock(tx, "record-ledger-owner-keys", spaceId);
    const held = await tx.recordLedgerRecipient.findMany({
      where: { spaceId },
      select: { recipient: true },
    });
    if (held.some((key) => key.recipient === recipient)) return false;
    if (held.length >= MAX_OWNER_KEYS) throw new OwnerKeyLimitError();
    await tx.recordLedgerRecipient.create({
      data: { id: createRowId(), spaceId, recipient, label },
    });
    return true;
  });
}

/** Stops sealing to `recipient`. Returns false when it was not one of the Space's keys. */
export async function removeOwnerKey(
  prisma: PrismaClient,
  spaceId: string,
  recipient: string,
): Promise<boolean> {
  const { count } = await prisma.recordLedgerRecipient.deleteMany({
    where: { spaceId, recipient },
  });
  return count > 0;
}

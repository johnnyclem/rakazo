import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUEST_ROLE } from "./billing.js";
import { createOrganizationWithDefaultSpace } from "./bootstrap-user.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createOrganizationForUser } from "./organizations.js";
import { createRowId } from "./row-id.js";
import { asSystem } from "./row-security.js";
import { createSpaceForMember } from "./spaces.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("a new Space is sealed to its owner's keys (PostgreSQL)", () => {
  let close: () => Promise<void>;
  let prisma: PrismaClient;
  const suffix = `${process.pid}-${Date.now()}`;
  let sequence = 0;

  beforeAll(() => {
    const created = createDb(databaseUrl!);
    prisma = asSystem(created.prisma);
    close = async () => {
      await created.prisma.$disconnect();
    };
  });
  afterAll(async () => close?.());

  /** A person with the personal organization and Space signup gives them. */
  async function person() {
    sequence += 1;
    const userId = `inherit-${suffix}-${sequence}`;
    await prisma.user.create({
      data: { id: userId, name: "Someone", email: `${userId}@rakazo.test` },
    });
    const spaceId = await createOrganizationWithDefaultSpace(prisma, {
      userId,
      orgId: `org-${userId}`,
      name: "Personal",
      slug: `slug-${userId}`,
    });
    return { userId, spaceId };
  }

  const key = (character: string) => `age1${character.repeat(58)}`;
  const hold = (spaceId: string, recipient: string, label: string | null = null) =>
    prisma.recordLedgerRecipient.create({
      data: { id: createRowId(), spaceId, recipient, label },
    });
  const keysOf = async (spaceId: string) =>
    (
      await prisma.recordLedgerRecipient.findMany({
        where: { spaceId },
        orderBy: { recipient: "asc" },
      })
    ).map((row) => [row.recipient, row.label]);
  const makeSpace = (userId: string, currentSpaceId: string, name = "Later") =>
    createSpaceForMember(prisma, { currentSpaceId, userId, name });

  it("holds the keys of the Space it was made from, label included, before anything is recorded", async () => {
    const owner = await person();
    await hold(owner.spaceId, key("q"), "recovery");
    await hold(owner.spaceId, key("p"));

    const later = await makeSpace(owner.userId, owner.spaceId);
    expect(await keysOf(later.id)).toEqual([
      [key("p"), null],
      [key("q"), "recovery"],
    ]);

    // From that one in turn: the key goes wherever its owner makes a Space.
    const evenLater = await makeSpace(owner.userId, later.id, "Even later");
    expect(await keysOf(evenLater.id)).toEqual(await keysOf(later.id));
    // What the source holds is left as it was.
    expect(await keysOf(owner.spaceId)).toHaveLength(2);
  });

  it("takes the keys of the Space it was made from, not those of another Space the owner has", async () => {
    const owner = await person();
    await hold(owner.spaceId, key("q"));
    const second = await makeSpace(owner.userId, owner.spaceId, "Second");
    await prisma.recordLedgerRecipient.deleteMany({ where: { spaceId: second.id } });
    await hold(second.id, key("p"));

    expect(await keysOf((await makeSpace(owner.userId, second.id)).id)).toEqual([[key("p"), null]]);
    expect(await keysOf((await makeSpace(owner.userId, owner.spaceId)).id)).toEqual([
      [key("q"), null],
    ]);
  });

  it("copies nothing where the Space it was made from holds no key", async () => {
    const owner = await person();
    const later = await makeSpace(owner.userId, owner.spaceId);
    expect(await keysOf(later.id)).toEqual([]);
  });

  it("uses the oldest Space the owner has when made from one shared with them, and never another person's keys", async () => {
    const owner = await person();
    const host = await person();
    await hold(owner.spaceId, key("q"));
    await hold(host.spaceId, key("z"));
    // The owner is a guest in the host's Space, so a Space made from there goes in their own.
    await prisma.member.create({
      data: {
        id: createRowId(),
        organizationId: `org-${host.userId}`,
        userId: owner.userId,
        role: GUEST_ROLE,
        createdAt: new Date(),
      },
    });
    // A trigger joins an organization's members to its default Space; make sure they are in it.
    await prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: host.spaceId, userId: owner.userId } },
      update: { role: "member" },
      create: {
        id: createRowId(),
        organizationId: `org-${host.userId}`,
        spaceId: host.spaceId,
        userId: owner.userId,
        role: "member",
        createdAt: new Date(),
      },
    });

    const later = await makeSpace(owner.userId, host.spaceId);

    expect(await keysOf(later.id)).toEqual([[key("q"), null]]);
  });

  it("gives a new organization's first Space the key its owner holds", async () => {
    const owner = await person();
    await hold(owner.spaceId, key("q"));

    const team = await createOrganizationForUser(prisma, { userId: owner.userId, name: "Team" });

    expect(await keysOf(team.defaultSpaceId)).toEqual([[key("q"), null]]);
  });

  it("leaves a Space no key when its creation fails", async () => {
    const owner = await person();
    await hold(owner.spaceId, key("q"));
    const before = await prisma.recordLedgerRecipient.count();

    await expect(makeSpace(owner.userId, owner.spaceId, "   ")).rejects.toThrow();

    expect(await prisma.recordLedgerRecipient.count()).toBe(before);
  });
});

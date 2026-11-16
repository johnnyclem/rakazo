import { MAX_OWNER_KEYS } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LedgerFixture } from "./record-ledger.test-support.js";
import { createLedgerFixture } from "./record-ledger.test-support.js";
import { RecordLedgerEmulator } from "./record-ledger-emulator.js";
import { generateOwnerIdentity } from "./record-ledger-owner-keys.js";
import { addOwnerKey, listOwnerKeys, removeOwnerKey } from "./record-ledger-space-keys.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("a Space's owner keys (PostgreSQL)", () => {
  let fixture: LedgerFixture;
  let ledger: RecordLedgerEmulator;

  const list = () => listOwnerKeys(fixture.prisma, fixture.spaceId);
  const add = (recipient: string, label?: string) =>
    addOwnerKey(fixture.prisma, fixture.spaceId, recipient, label);

  beforeEach(async () => {
    fixture = await createLedgerFixture(databaseUrl!);
    ledger = new RecordLedgerEmulator();
  });

  afterEach(async () => fixture?.close());

  it("adds, lists and removes keys in the order they were added", async () => {
    const [first, second] = [await generateOwnerIdentity(), await generateOwnerIdentity()];

    expect(await list()).toEqual({ keys: [], earlier: false });
    expect(await add(first.recipient, "recovery")).toBe(true);
    expect(await add(second.recipient)).toBe(true);
    expect(await add(first.recipient)).toBe(false);

    const { keys } = await list();
    expect(keys.map((key) => [key.recipient, key.label])).toEqual([
      [first.recipient, "recovery"],
      [second.recipient, null],
    ]);

    expect(await removeOwnerKey(fixture.prisma, fixture.spaceId, first.recipient)).toBe(true);
    expect(await removeOwnerKey(fixture.prisma, fixture.spaceId, first.recipient)).toBe(false);
    expect((await list()).keys.map((key) => key.recipient)).toEqual([second.recipient]);
  });

  it("never holds more than the limit, however many are added at once", async () => {
    const identities = await Promise.all(
      Array.from({ length: MAX_OWNER_KEYS + 3 }, () => generateOwnerIdentity()),
    );

    const results = await Promise.allSettled(identities.map(({ recipient }) => add(recipient)));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(MAX_OWNER_KEYS);
    expect(
      results.flatMap((result) => (result.status === "rejected" ? [result.reason.code] : [])),
    ).toEqual(Array(3).fill("owner_key_limit"));
    expect((await list()).keys).toHaveLength(MAX_OWNER_KEYS);
  });

  it("says whether the deployment's own key was ever given a stream's key", async () => {
    const owner = await generateOwnerIdentity();
    const bot = await fixture.newBot();

    // Keys first: the stream is sealed to them alone, so nothing the master key opens exists.
    await add(owner.recipient);
    await fixture.remember(bot, "sealed to the owner from the start");
    await fixture.reconciler(ledger)();
    expect((await list()).earlier).toBe(false);

    // A Space whose stream began under the master key keeps that, whatever is added afterwards.
    const other = await createLedgerFixture(databaseUrl!);
    try {
      const otherBot = await other.newBot();
      await other.remember(otherBot, "written before any key");
      await other.reconciler(new RecordLedgerEmulator())();
      await addOwnerKey(other.prisma, other.spaceId, owner.recipient);
      await other.reconciler(new RecordLedgerEmulator())();
      expect(await listOwnerKeys(other.prisma, other.spaceId)).toMatchObject({ earlier: true });
    } finally {
      await other.close();
    }
  });
});

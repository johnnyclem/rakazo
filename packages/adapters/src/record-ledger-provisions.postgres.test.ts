import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerFixture } from "./record-ledger.test-support.js";
import { createLedgerFixture } from "./record-ledger.test-support.js";
import { setSpaceDestination } from "./record-ledger-destinations.js";
import { RecordLedgerEmulator } from "./record-ledger-emulator.js";
import {
  describeSpaceProvision,
  ProvisionExistsError,
  ProvisionPlanRequiredError,
  ProvisionUnavailableError,
  startSpaceProvision,
  syncProvisions,
} from "./record-ledger-provisions.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const OWNER_KEY = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";
const OTHER_KEY = "GX9rI-FshTLGq8g4-s1ep4m-DHaykgM0A5v6iz02jWE";

describePostgres("making a place for a Space's owner (PostgreSQL)", () => {
  let fixture: LedgerFixture;
  let ledger: RecordLedgerEmulator;
  let changed: string[];

  const start = (ownerKey = OWNER_KEY, planAllows = true) =>
    startSpaceProvision(fixture.prisma, ledger, fixture.spaceId, ownerKey, {
      planAllows,
      onChanged: (spaceId) => changed.push(spaceId),
    });
  const sweep = (options: { now?: boolean } = {}) =>
    syncProvisions(fixture.prisma, ledger, { onChanged: (id) => changed.push(id), ...options });
  const row = () =>
    fixture.prisma.recordLedgerProvision.findUnique({ where: { spaceId: fixture.spaceId } });
  const named = async () =>
    (
      await fixture.prisma.recordLedgerDestination.findUnique({
        where: { spaceId: fixture.spaceId },
      })
    )?.destination ?? null;
  /** As if the last attempt was long enough ago to be tried again. */
  const aged = () =>
    fixture.prisma.recordLedgerProvision.update({
      where: { spaceId: fixture.spaceId },
      data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
    });

  beforeEach(async () => {
    fixture = await createLedgerFixture(databaseUrl!);
    ledger = new RecordLedgerEmulator();
    changed = [];
  });

  afterEach(async () => fixture?.close());

  it("asks the ledger once under a key of the Space's own, and waits while it is made", async () => {
    await start();

    expect(await row()).toMatchObject({ state: "pending", ownerKey: OWNER_KEY, destination: null });
    expect(ledger.provisionCalls).toEqual([
      { key: `space-${fixture.spaceId}`, ownerKey: OWNER_KEY },
    ]);
    expect(await named()).toBeNull();
  });

  it("makes the place the Space's own once it is ready, and tells the Space's streams", async () => {
    const bot = await fixture.newBot();
    await fixture.remember(bot, "kept before there was a place");
    await start();
    ledger.completeProvisions();

    await fixture.reconciler(ledger)();

    const ready = await row();
    expect(ready).toMatchObject({ state: "ready", error: null });
    expect(ready?.destination).toBeTruthy();
    expect(await named()).toBe(ready?.destination);
    const stream = (await fixture.streamOf(`bot:${bot}`))!;
    expect(ledger.destinations.get(stream.id)).toBe(ready?.destination);
  });

  it("says so once, when it moves on, and not again while nothing changes", async () => {
    await start();
    expect(changed).toEqual([]);
    await sweep();
    expect(changed).toEqual([]);

    ledger.completeProvisions();
    await sweep();
    await sweep();

    expect(changed).toEqual([fixture.spaceId]);
  });

  it("does not make a second place for the same request, however often it is asked", async () => {
    await start();
    await start();
    await sweep();

    expect(await fixture.prisma.recordLedgerProvision.count()).toBe(1);
    expect(ledger.provisions.size).toBe(1);
  });

  it("never replaces a place the owner named themselves while it was being made", async () => {
    await start();
    await setSpaceDestination(fixture.prisma, ledger, fixture.spaceId, "place-mine");
    ledger.completeProvisions();

    await sweep();

    expect(await named()).toBe("place-mine");
    expect(await row()).toMatchObject({ state: "ready" });
  });

  describe("what it refuses", () => {
    it("does nothing where the plan does not allow it, and does not ask the ledger", async () => {
      await expect(start(OWNER_KEY, false)).rejects.toBeInstanceOf(ProvisionPlanRequiredError);

      expect(await row()).toBeNull();
      expect(ledger.provisionCalls).toEqual([]);
    });

    it("does nothing where the ledger cannot make places", async () => {
      ledger.canProvision = false;
      await expect(start()).rejects.toBeInstanceOf(ProvisionUnavailableError);

      const without = new RecordLedgerEmulator();
      Object.defineProperty(without, "provisioning", { value: undefined });
      await expect(
        startSpaceProvision(fixture.prisma, without, fixture.spaceId, OWNER_KEY, {
          planAllows: true,
        }),
      ).rejects.toBeInstanceOf(ProvisionUnavailableError);
      expect(await row()).toBeNull();
    });

    it("does nothing when the Space already names a place", async () => {
      await setSpaceDestination(fixture.prisma, ledger, fixture.spaceId, "place-mine");

      await expect(start()).rejects.toBeInstanceOf(ProvisionExistsError);

      expect(await row()).toBeNull();
    });

    it("keeps the first key: another cannot take over a request already made", async () => {
      await start();

      await expect(start(OTHER_KEY)).rejects.toBeInstanceOf(ProvisionExistsError);

      expect(await row()).toMatchObject({ ownerKey: OWNER_KEY });
      expect(ledger.provisionCalls).toHaveLength(1);
    });
  });

  describe("when it goes wrong", () => {
    it("records a failure without the ledger's words reaching anyone, and waits before trying again", async () => {
      ledger.failProvisions = true;
      await start();
      expect(await row()).toMatchObject({ state: "failed" });
      const asked = ledger.provisionCalls.length;

      const told = changed.length;

      await sweep();

      // Not long enough since the last attempt: a sweep leaves it be.
      expect(ledger.provisionCalls).toHaveLength(asked);
      expect(changed).toHaveLength(told);
    });

    it("tries a failed request again once it has waited, and finishes it", async () => {
      ledger.failProvisions = true;
      await start();
      ledger.failProvisions = false;
      await aged();

      await sweep();
      ledger.completeProvisions();
      await sweep();

      expect(await row()).toMatchObject({ state: "ready", error: null });
      expect(await named()).toBeTruthy();
    });

    it("tries a failed request at once when the owner asks again", async () => {
      ledger.failProvisions = true;
      await start();
      ledger.failProvisions = false;

      await start();

      expect(await row()).toMatchObject({ state: "pending" });
    });

    it("never retries what the ledger refused for good", async () => {
      ledger.provisionLimit = 0;
      await start();
      expect(await row()).toMatchObject({ state: "failed", error: "refused:limit_reached" });
      expect(changed).toEqual([fixture.spaceId]);
      ledger.provisionLimit = Number.POSITIVE_INFINITY;
      await aged();
      const asked = ledger.provisionCalls.length;

      await sweep();

      expect(ledger.provisionCalls).toHaveLength(asked);
      expect(await row()).toMatchObject({ state: "failed" });
    });

    it("keeps the request when the ledger cannot be reached, and finds it on the next pass", async () => {
      ledger.unavailable = true;
      await start();
      expect(await row()).toMatchObject({ state: "pending" });
      ledger.unavailable = false;

      await sweep();
      ledger.completeProvisions();
      await sweep();

      expect(await row()).toMatchObject({ state: "ready" });
    });

    it("lets a sweep say the ledger is unreachable, for its caller to log and go on", async () => {
      await start();
      ledger.unavailable = true;
      const thrown = await sweep().then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(thrown).toMatchObject({ name: "RecordLedgerUnavailable" });
    });
  });

  describe("what the owner is told", () => {
    const view = (planAllows = true) =>
      describeSpaceProvision(fixture.prisma, ledger, fixture.spaceId, planAllows);

    it("offers a place to an owner who has none, where the ledger and the plan allow it", async () => {
      expect(await view()).toEqual({ offered: true, state: null, payment: null });
    });

    it.each([
      ["the plan does not allow it", () => view(false)],
      [
        "the ledger cannot make places",
        () => {
          ledger.canProvision = false;
          return view();
        },
      ],
    ])("offers nothing when %s", async (_label, ask) => {
      expect(await ask()).toEqual({ offered: false, state: null, payment: null });
    });

    it("offers nothing once the Space names a place, or has asked for one, and says how it has got to", async () => {
      await start();
      expect(await view()).toEqual({ offered: false, state: "pending", payment: null });

      ledger.completeProvisions();
      await sweep();
      expect(await view()).toEqual({ offered: false, state: "ready", payment: null });
    });

    it("offers nothing to a Space that already names a place of its own", async () => {
      await setSpaceDestination(fixture.prisma, ledger, fixture.spaceId, "place-mine");

      expect(await view()).toEqual({ offered: false, state: null, payment: null });
    });

    it("does not ask the ledger whether it can when nothing else would offer one", async () => {
      const probe = vi.spyOn(ledger.provisioning, "available");

      await view(false);

      expect(probe).not.toHaveBeenCalled();
    });
  });

  describe("paying for a place", () => {
    const key = () => `space-${fixture.spaceId}`;
    const view = (planAllows = false) =>
      describeSpaceProvision(fixture.prisma, ledger, fixture.spaceId, planAllows);
    const due = (shortfall: string) => ({
      asset: "TEST",
      amount: "1.5",
      shortfall,
      address: `pay-${key()}`,
    });

    beforeEach(() => {
      ledger.canSell = true;
    });

    it("offers a place for sale to a Space whose plan does not cover one, where the ledger sells", async () => {
      expect(await view()).toEqual({ offered: true, state: null, payment: null });

      ledger.canSell = false;
      expect(await view()).toEqual({ offered: false, state: null, payment: null });
    });

    it("opens a request that is paid for, and keeps what is due for the owner to see", async () => {
      await start(OWNER_KEY, false);

      expect(await row()).toMatchObject({ paid: true, state: "pending", payment: due("1.5") });
      expect(ledger.provisions.get(key())).toMatchObject({ paid: true });
      expect(await view()).toEqual({ offered: false, state: "pending", payment: due("1.5") });
      expect(changed).toEqual([fixture.spaceId]);
    });

    it("does not make the place while it is unpaid, however often it is looked at", async () => {
      await start(OWNER_KEY, false);

      ledger.completeProvisions();
      await sweep();
      await sweep();

      expect(await row()).toMatchObject({ state: "pending", destination: null });
      expect(await named()).toBeNull();
    });

    it("follows the payment as it arrives, tells the screen each time, and makes the place once it is in", async () => {
      await start(OWNER_KEY, false);
      changed.length = 0;

      await sweep();
      expect(changed).toEqual([]);

      ledger.pay(key(), 0.5);
      await sweep();
      expect(await row()).toMatchObject({ state: "pending", payment: due("1") });
      expect(changed).toEqual([fixture.spaceId]);

      ledger.pay(key(), 1);
      await sweep();
      expect(await row()).toMatchObject({ state: "pending", payment: null });
      expect(changed).toHaveLength(2);

      ledger.completeProvisions();
      await sweep();
      expect(await row()).toMatchObject({ state: "ready", payment: null });
      expect(await named()).toMatch(/^place-/);
      expect(changed).toHaveLength(3);
    });

    it("makes the place with nothing to pay when the plan covers it, even where the ledger sells", async () => {
      await start(OWNER_KEY, true);

      expect(await row()).toMatchObject({ paid: false, payment: null });
      expect(ledger.provisions.get(key())).toMatchObject({ paid: false });
    });

    it("keeps a place a paid plan's alone where the ledger does not sell", async () => {
      ledger.canSell = false;

      await expect(start(OWNER_KEY, false)).rejects.toBeInstanceOf(ProvisionPlanRequiredError);

      expect(await row()).toBeNull();
      expect(ledger.provisionCalls).toEqual([]);
    });

    it("keeps the request when the ledger cannot be reached, and finds what is due once it can", async () => {
      ledger.unavailable = true;
      await start(OWNER_KEY, false);
      expect(await row()).toMatchObject({ paid: true, state: "pending", payment: null });

      ledger.unavailable = false;
      await sweep();

      expect(await row()).toMatchObject({ payment: due("1.5") });
    });

    it("shows nothing due, rather than failing, when what is stored cannot be read", async () => {
      await start(OWNER_KEY, false);
      await fixture.prisma.recordLedgerProvision.update({
        where: { spaceId: fixture.spaceId },
        data: { payment: { nonsense: true } },
      });

      expect(await view()).toEqual({ offered: false, state: "pending", payment: null });
    });

    it("asks the ledger whether it sells only for a Space the plan does not cover", async () => {
      const sale = vi.spyOn(ledger.provisioning.sale!, "available");

      await view(true);
      expect(sale).not.toHaveBeenCalled();

      await view(false);
      expect(sale).toHaveBeenCalledTimes(1);
    });
  });
});

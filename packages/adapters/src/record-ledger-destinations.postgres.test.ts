import { RecordLedgerDestinationInvalid, RecordLedgerUnavailable } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LedgerFixture } from "./record-ledger.test-support.js";
import { createLedgerFixture } from "./record-ledger.test-support.js";
import {
  AnchoringUnavailableError,
  clearSpaceDestination,
  DestinationInvalidError,
  describeSpaceAnchor,
  setSpaceDestination,
  syncDestinations,
} from "./record-ledger-destinations.js";
import { RecordLedgerEmulator } from "./record-ledger-emulator.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const PLACE_A = "place-aaaa";
const PLACE_B = "place-bbbb";

describePostgres("keeping a Space's backups where its owner says (PostgreSQL)", () => {
  let fixture: LedgerFixture;
  let ledger: RecordLedgerEmulator;
  /** What the ledger was asked, in order, so a destination can be shown to come before an entry. */
  let calls: string[];

  const reconcile = () => fixture.reconciler(ledger)();
  const set = (destination: string) =>
    setSpaceDestination(fixture.prisma, ledger, fixture.spaceId, destination);
  const streamRows = () =>
    fixture.prisma.recordLedgerStream.findMany({
      where: { spaceId: fixture.spaceId },
      orderBy: { subject: "asc" },
    });

  beforeEach(async () => {
    fixture = await createLedgerFixture(databaseUrl!);
    ledger = new RecordLedgerEmulator();
    calls = [];
    const { setDestination } = ledger.anchoring;
    ledger.anchoring.setDestination = async (stream, destination, signal) => {
      calls.push(`destination ${stream} ${destination}`);
      return setDestination(stream, destination, signal);
    };
    const { append } = ledger;
    ledger.append = async (request, signal) => {
      calls.push(`append ${request.stream}`);
      return append.call(ledger, request, signal);
    };
  });

  afterEach(async () => fixture?.close());

  it("tells the ledger before it sends a stream's first entries, for streams made after the owner named a place", async () => {
    await set(PLACE_A);
    const bot = await fixture.newBot();
    await fixture.remember(bot, "written after the owner named a place");

    await reconcile();

    const stream = (await fixture.streamOf(`bot:${bot}`))!;
    expect(ledger.destinations.get(stream.id)).toBe(PLACE_A);
    expect(stream.destinationSynced).toBe(PLACE_A);
    expect(calls.indexOf(`destination ${stream.id} ${PLACE_A}`)).toBeLessThan(
      calls.indexOf(`append ${stream.id}`),
    );
    expect(ledger.streams.get(stream.id)?.length).toBeGreaterThan(0);
  });

  it("tells it about streams that already existed, and a stream made later gets it too", async () => {
    const first = await fixture.newBot("First");
    await fixture.remember(first, "before");
    await reconcile();
    expect(ledger.destinations.size).toBe(0);

    await set(PLACE_A);
    // Named while the ledger was reachable, so the streams are told at once.
    const before = (await fixture.streamOf(`bot:${first}`))!;
    expect(ledger.destinations.get(before.id)).toBe(PLACE_A);

    const second = await fixture.newBot("Second");
    await fixture.remember(second, "after");
    await reconcile();
    const after = (await fixture.streamOf(`bot:${second}`))!;
    expect(ledger.destinations.get(after.id)).toBe(PLACE_A);
    expect((await streamRows()).every((row) => row.destinationSynced === PLACE_A)).toBe(true);
  });

  it("tells a Space that names no place nothing, and every stream stays as it was", async () => {
    const bot = await fixture.newBot();
    await fixture.remember(bot, "no place named");

    await reconcile();

    expect(ledger.destinations.size).toBe(0);
    expect(calls.some((call) => call.startsWith("destination"))).toBe(false);
    expect((await streamRows()).every((row) => row.destinationSynced === null)).toBe(true);
  });

  it("moves the streams when the owner names another place, and puts them back when they name none", async () => {
    const bot = await fixture.newBot();
    await fixture.remember(bot, "kept");
    await set(PLACE_A);
    await reconcile();
    const stream = (await fixture.streamOf(`bot:${bot}`))!;

    await set(PLACE_B);
    expect(ledger.destinations.get(stream.id)).toBe(PLACE_B);
    expect((await streamRows()).map((row) => row.destinationSynced)).toEqual([PLACE_B]);

    await clearSpaceDestination(fixture.prisma, ledger, fixture.spaceId);
    expect(ledger.destinations.has(stream.id)).toBe(false);
    expect((await streamRows()).map((row) => row.destinationSynced)).toEqual([null]);
    expect(
      await fixture.prisma.recordLedgerDestination.count({ where: { spaceId: fixture.spaceId } }),
    ).toBe(0);
  });

  it("does not hold back the backups when the ledger cannot be told, and tells it on a later pass", async () => {
    const bot = await fixture.newBot();
    await fixture.remember(bot, "must still be backed up");
    await set(PLACE_A);
    const { setDestination } = ledger.anchoring;
    ledger.anchoring.setDestination = async () => {
      throw new RecordLedgerUnavailable("unavailable");
    };

    await reconcile();

    const stream = (await fixture.streamOf(`bot:${bot}`))!;
    expect(ledger.streams.get(stream.id)?.length).toBeGreaterThan(0);
    expect(stream.destinationSynced).toBeNull();
    expect(ledger.destinations.size).toBe(0);

    ledger.anchoring.setDestination = setDestination;
    await reconcile();
    expect(ledger.destinations.get(stream.id)).toBe(PLACE_A);
  });

  it("refuses what is not a place, stores nothing for it, and keeps what was there when the ledger refuses", async () => {
    await expect(set("Not A Place")).rejects.toBeInstanceOf(DestinationInvalidError);
    expect(await fixture.prisma.recordLedgerDestination.count()).toBe(0);

    const bot = await fixture.newBot();
    await fixture.remember(bot, "kept");
    await reconcile();
    await set(PLACE_A);
    // A name with the right shape that the ledger knows is not one.
    ledger.anchoring.setDestination = async () => {
      throw new RecordLedgerDestinationInvalid("no such place");
    };
    await expect(set(PLACE_B)).rejects.toThrow("That is not a valid place");
    expect(
      (
        await fixture.prisma.recordLedgerDestination.findUniqueOrThrow({
          where: { spaceId: fixture.spaceId },
        })
      ).destination,
    ).toBe(PLACE_A);
  });

  it("does nothing, and offers nothing, where the ledger has no such thing", async () => {
    const without = Object.create(ledger, {
      anchoring: { value: undefined },
    }) as RecordLedgerEmulator;
    await expect(
      setSpaceDestination(fixture.prisma, without, fixture.spaceId, PLACE_A),
    ).rejects.toBeInstanceOf(AnchoringUnavailableError);
    await expect(syncDestinations(fixture.prisma, without)).resolves.toBeUndefined();
    expect(await describeSpaceAnchor(fixture.prisma, without, fixture.spaceId)).toEqual({
      label: null,
      writer: null,
      destination: null,
      status: null,
    });
  });

  describe("describing it for the owner", () => {
    const describeNow = () => describeSpaceAnchor(fixture.prisma, ledger, fixture.spaceId);

    it("offers the ledger's own word for a place and the identity to allow, before any is named", async () => {
      expect(await describeNow()).toEqual({
        label: "Place",
        writer: "emulator-writer",
        destination: null,
        status: null,
      });
    });

    it("says how far behind the streams are, until the ledger has caught up", async () => {
      const [one, two] = [await fixture.newBot("One"), await fixture.newBot("Two")];
      await fixture.remember(one, "a");
      await fixture.remember(two, "b");
      await set(PLACE_A);
      await reconcile();

      const behind = await describeNow();
      expect(behind.destination).toBe(PLACE_A);
      expect(behind.status).toEqual({ streams: 2, behind: 2, error: null });

      ledger.anchorNow();
      expect((await describeNow()).status).toEqual({ streams: 2, behind: 0, error: null });
    });

    it("says when the owner has not yet allowed the ledger to write there, and when the ledger cannot be reached", async () => {
      const bot = await fixture.newBot();
      await fixture.remember(bot, "kept");
      await set(PLACE_A);
      await reconcile();

      ledger.notAllowed.add(PLACE_A);
      expect((await describeNow()).status).toMatchObject({ behind: 1, error: "not_allowed" });

      ledger.notAllowed.clear();
      ledger.unavailable = true;
      expect((await describeNow()).status).toMatchObject({ behind: 1, error: "failed" });
    });

    it("keeps showing a place that is named while the ledger is unreachable, and hides one that is not", async () => {
      ledger.anchoring.writer = async () => {
        throw new RecordLedgerUnavailable("unavailable");
      };
      expect((await describeNow()).label).toBeNull();

      await fixture.prisma.recordLedgerDestination.create({
        data: { spaceId: fixture.spaceId, destination: PLACE_A },
      });
      expect(await describeNow()).toMatchObject({
        label: "Place",
        writer: null,
        destination: PLACE_A,
      });
    });
  });
});

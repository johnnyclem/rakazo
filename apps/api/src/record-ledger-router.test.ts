import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { RecordLedgerAnchoring, RecordLedgerProvider } from "@rakazo/adapter-kit";
import { RecordLedgerDestinationInvalid } from "@rakazo/adapter-kit";
import { generateOwnerIdentity } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { MAX_OWNER_KEYS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";
import { procedureSecurityEvent } from "./security-audit.js";

// Offline boundary: a fake Prisma holds the Space's members, owner keys and ledger entries, and
// drives the real router handlers and the real owner-key service.

const owner = { spaceId: "space-1", userId: "owner-1", email: "o@rakazo.test" } as Actor;
const member = { spaceId: "space-1", userId: "member-1", email: "m@rakazo.test" } as Actor;
const outsider = { spaceId: "space-1", userId: "outsider-1", email: "x@rakazo.test" } as Actor;

type KeyRow = { id: string; spaceId: string; recipient: string; label: string | null };

/** A ledger that can keep a stream's copy at a place of the owner's own, and does nothing else. */
function fakeProvider({
  anchoring = true,
  provisioning = false,
  sells = false,
}: {
  anchoring?: boolean;
  provisioning?: boolean;
  sells?: boolean;
} = {}): RecordLedgerProvider {
  const unused = async () => {
    throw new Error("The routes under test never read or write the ledger");
  };
  const place: RecordLedgerAnchoring = {
    label: "Place",
    writer: async () => "fake-writer",
    validate: (destination) => {
      if (!/^[a-z0-9-]{5,63}$/.test(destination)) {
        throw new RecordLedgerDestinationInvalid("Not a place");
      }
    },
    setDestination: async () => {},
    status: async () => null,
  };
  return {
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        offline: true,
        maxEntryBytes: 256 * 1024,
        maxBatchEntries: 100,
        maxBatchBytes: 2 * 1024 * 1024,
      },
    }),
    ...(anchoring ? { anchoring: place } : {}),
    ...(provisioning
      ? {
          provisioning: {
            ownerKey: "ed25519" as const,
            available: async () => true,
            // A request that is paid for waits for its payment, as a ledger that sells would say.
            begin: vi.fn(
              async (
                _key: string,
                _ownerKey: string,
                _signal: AbortSignal,
                options?: { paid?: boolean },
              ) => ({
                state: "pending" as const,
                destination: null,
                error: null,
                payment: options?.paid
                  ? { asset: "TEST", amount: "1.5", shortfall: "1.5", address: "pay-here" }
                  : null,
              }),
            ),
            ...(sells ? { sale: { available: async () => true } } : {}),
          },
        }
      : {}),
    append: unused,
    read: unused,
    list: unused,
  };
}

function ledgerDeps(
  options: {
    announcedUnderMasterKey?: boolean;
    recordLedgerEnabled?: boolean;
    provider?: RecordLedgerProvider;
    /** A deployment that charges, and what the Space's organization pays; absent means it does not charge. */
    billing?: { status: string | null; paidAt: Date | null } | null;
  } = {},
) {
  const keys: Array<KeyRow & { createdAt: Date }> = [];
  const destinations = new Map<string, string>();
  const provisions = new Map<
    string,
    {
      spaceId: string;
      ownerKey: string;
      state: string;
      destination: string | null;
      error: string | null;
      paid: boolean;
      payment: unknown;
    }
  >();
  const roles = new Map([
    ["space-1:owner-1", "owner"],
    ["space-1:member-1", "member"],
  ]);
  const prisma = {
    spaceMember: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; role: string } }) =>
        [...roles]
          .filter(([key, role]) => key.endsWith(`:${where.userId}`) && role === where.role)
          .map(([key]) => ({ spaceId: key.split(":")[0] })),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { spaceId_userId: Record<string, string> } }) => {
          const { spaceId, userId } = where.spaceId_userId;
          const role = roles.get(`${spaceId}:${userId}`);
          return role ? { role } : null;
        },
      ),
    },
    recordLedgerRecipient: {
      findMany: vi.fn(async ({ where }: { where: { spaceId: string } }) =>
        keys.filter((key) => key.spaceId === where.spaceId),
      ),
      create: vi.fn(async ({ data }: { data: KeyRow }) => {
        keys.push({ ...data, createdAt: new Date(2026, 0, keys.length + 1) });
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { spaceId: string; recipient: string } }) => {
        const before = keys.length;
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const key = keys[index]!;
          if (key.spaceId === where.spaceId && key.recipient === where.recipient)
            keys.splice(index, 1);
        }
        return { count: before - keys.length };
      }),
    },
    recordLedgerEntry: {
      findFirst: vi.fn(async () => (options.announcedUnderMasterKey ? { id: "entry-1" } : null)),
    },
    recordLedgerDestination: {
      findUnique: vi.fn(async ({ where }: { where: { spaceId: string } }) => {
        const destination = destinations.get(where.spaceId);
        return destination ? { destination } : null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { spaceId: string };
          create: { destination: string };
        }) => {
          destinations.set(where.spaceId, create.destination);
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { spaceId: string } }) => {
        destinations.delete(where.spaceId);
      }),
    },
    recordLedgerProvision: {
      findUnique: vi.fn(
        async ({ where }: { where: { spaceId: string } }) => provisions.get(where.spaceId) ?? null,
      ),
      create: vi.fn(
        async ({ data }: { data: { spaceId: string; ownerKey: string; paid?: boolean } }) => {
          provisions.set(data.spaceId, {
            ...data,
            paid: data.paid ?? false,
            payment: null,
            state: "pending",
            destination: null,
            error: null,
          });
        },
      ),
      findMany: vi.fn(async () =>
        [...provisions.values()].filter((row) => row.state === "pending"),
      ),
      update: vi.fn(
        async ({ where, data }: { where: { spaceId: string }; data: Record<string, unknown> }) => {
          // As the database stores it: the marker for no JSON is null.
          const stored = data.payment === Prisma.DbNull ? { ...data, payment: null } : data;
          Object.assign(provisions.get(where.spaceId)!, stored);
        },
      ),
    },
    space: {
      findUnique: vi.fn(async () => ({ organization: { billing: options.billing ?? null } })),
    },
    // The Space has no streams here; what happens to streams is tested against a real database.
    recordLedgerStream: { findMany: vi.fn(async () => []), update: vi.fn() },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    env: { defaultProvider: "fake", defaultModel: "fake-model" },
    dataDir: "/tmp/rakazo-router-test",
    recordLedger:
      options.recordLedgerEnabled === false ? undefined : (options.provider ?? fakeProvider()),
    ...(options.billing === undefined ? {} : { billing: {} }),
    events: { publishSpaceChange: vi.fn(async () => undefined) },
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps), {
    clientInterceptors: [onError((error, { path, signal }) => handleRpcError(error, path, signal))],
  });
  async function call(
    actor: Actor,
    path:
      | "keys"
      | "offer"
      | "addKey"
      | "removeKey"
      | "anchor"
      | "setAnchor"
      | "clearAnchor"
      | "provision",
    input: Record<string, unknown> = {},
  ) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/recordLedger/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    if (!response) throw new Error("Procedure did not match");
    return {
      status: response.status,
      body: (await response.json()) as {
        json: { keys?: Array<{ recipient: string }>; earlier?: boolean; code?: string };
      },
    };
  }
  return { keys, roles, destinations, provisions, deps, call };
}

describe("recordLedger routes", () => {
  it("lets the Space's owner add, list and remove the keys its backups are sealed to", async () => {
    const { call, keys } = ledgerDeps();
    const first = await generateOwnerIdentity();
    const second = await generateOwnerIdentity();

    expect((await call(owner, "keys")).body.json).toEqual({ keys: [], earlier: false });

    const added = await call(owner, "addKey", { recipient: first.recipient });
    expect(added.status).toBe(200);
    expect(added.body.json.keys?.map((key) => key.recipient)).toEqual([first.recipient]);

    await call(owner, "addKey", { recipient: second.recipient });
    // A key already held is not stored twice.
    await call(owner, "addKey", { recipient: second.recipient });
    expect(keys.map((key) => key.recipient)).toEqual([first.recipient, second.recipient]);

    const removed = await call(owner, "removeKey", { recipient: first.recipient });
    expect(removed.body.json.keys?.map((key) => key.recipient)).toEqual([second.recipient]);
    // Removing one that is not held leaves the rest.
    const again = await call(owner, "removeKey", { recipient: first.recipient });
    expect(again.body.json.keys?.map((key) => key.recipient)).toEqual([second.recipient]);
  });

  it("refuses everyone but the Space's owner, and stores nothing for them", async () => {
    const { call, keys } = ledgerDeps();
    const { recipient } = await generateOwnerIdentity();

    for (const actor of [member, outsider]) {
      expect((await call(actor, "keys")).status).toBe(403);
      expect((await call(actor, "addKey", { recipient })).status).toBe(403);
      expect((await call(actor, "removeKey", { recipient })).status).toBe(403);
    }
    expect(keys).toHaveLength(0);

    await call(owner, "addKey", { recipient });
    expect((await call(member, "removeKey", { recipient })).status).toBe(403);
    expect(keys).toHaveLength(1);
  });

  it("refuses what is not an age public key", async () => {
    const { call, keys } = ledgerDeps();
    const { recipient } = await generateOwnerIdentity();
    // The right shape with a character changed fails the checksum, which the shape cannot see.
    const corrupted = `${recipient.slice(0, -1)}${recipient.endsWith("q") ? "p" : "q"}`;

    for (const bad of ["", "not a key", "AGE-SECRET-KEY-1QQQ", corrupted]) {
      expect((await call(owner, "addKey", { recipient: bad })).status).toBe(400);
    }
    expect(keys).toHaveLength(0);
  });

  it("stops at the most keys a Space may be sealed to, but still lets one be replaced", async () => {
    const { call, keys } = ledgerDeps();
    const held: string[] = [];
    for (let index = 0; index < MAX_OWNER_KEYS; index += 1) {
      const { recipient } = await generateOwnerIdentity();
      held.push(recipient);
      expect((await call(owner, "addKey", { recipient })).status).toBe(200);
    }

    const extra = await generateOwnerIdentity();
    const refused = await call(owner, "addKey", { recipient: extra.recipient });
    expect(refused.status).toBe(409);
    expect(refused.body.json.code).toBe("owner_key_limit");
    expect(keys).toHaveLength(MAX_OWNER_KEYS);

    await call(owner, "removeKey", { recipient: held[0] });
    expect((await call(owner, "addKey", { recipient: extra.recipient })).status).toBe(200);
  });

  it("says when a stream of the Space was already announced under the deployment's key", async () => {
    const { call } = ledgerDeps({ announcedUnderMasterKey: true });
    expect((await call(owner, "keys")).body.json.earlier).toBe(true);
  });

  it("asks a new account for a key only while one would seal everything", async () => {
    const { call, roles } = ledgerDeps();
    const asked = async (actor: Actor) => (await call(actor, "offer")).body.json;
    expect(await asked(owner)).toEqual({ offer: true });
    // Not the person who owns the Space, and not someone it is only shared with.
    expect(await asked(member)).toEqual({ offer: false });
    expect(await asked(outsider)).toEqual({ offer: false });

    // Someone who owns another Space already has had their chance.
    roles.set("space-2:owner-1", "owner");
    expect(await asked(owner)).toEqual({ offer: false });
    roles.delete("space-2:owner-1");

    const { recipient } = await generateOwnerIdentity();
    await call(owner, "addKey", { recipient });
    expect(await asked(owner)).toEqual({ offer: false });
  });

  it("asks nobody for a key where no ledger is kept", async () => {
    const { call } = ledgerDeps({ recordLedgerEnabled: false });
    expect((await call(owner, "offer")).body.json).toEqual({ offer: false });
  });

  it("asks nobody once a stream was announced under the deployment's key", async () => {
    const { call } = ledgerDeps({ announcedUnderMasterKey: true });
    expect((await call(owner, "offer")).body.json).toEqual({ offer: false });
  });

  it("keeps where the owner's backups are kept, and reports it", async () => {
    const { call, destinations } = ledgerDeps();
    const none = {
      label: "Place",
      writer: "fake-writer",
      destination: null,
      status: null,
      provision: { offered: false, state: null, payment: null },
    };
    expect((await call(owner, "anchor")).body.json).toEqual(none);

    const set = await call(owner, "setAnchor", { destination: "place-aaaa" });
    expect(set.status).toBe(200);
    expect(set.body.json).toEqual({
      ...none,
      destination: "place-aaaa",
      status: { streams: 0, behind: 0, error: null },
    });
    expect(destinations.get("space-1")).toBe("place-aaaa");

    expect((await call(owner, "clearAnchor")).body.json).toEqual(none);
    expect(destinations.size).toBe(0);
  });

  it("lets only the Space's owner see or change where its backups are kept", async () => {
    const { call, destinations } = ledgerDeps();
    for (const actor of [member, outsider]) {
      expect((await call(actor, "anchor")).status).toBe(403);
      expect((await call(actor, "setAnchor", { destination: "place-aaaa" })).status).toBe(403);
      expect((await call(actor, "clearAnchor")).status).toBe(403);
    }
    expect(destinations.size).toBe(0);
    await call(owner, "setAnchor", { destination: "place-aaaa" });
    expect((await call(member, "clearAnchor")).status).toBe(403);
    expect(destinations.get("space-1")).toBe("place-aaaa");
  });

  it("refuses what is not a place, in the ledger's own word for one", async () => {
    const { call, destinations } = ledgerDeps();
    for (const destination of ["", "   ", "x".repeat(129)]) {
      expect((await call(owner, "setAnchor", { destination })).status, destination).toBe(400);
    }
    const refused = await call(owner, "setAnchor", { destination: "Not A Place" });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("That is not a valid place");
    expect(destinations.size).toBe(0);
  });

  it("offers nothing where the ledger cannot keep a copy somewhere of the owner's own", async () => {
    const without = ledgerDeps({ provider: fakeProvider({ anchoring: false }) });
    expect((await without.call(owner, "anchor")).body.json).toEqual({
      label: null,
      writer: null,
      destination: null,
      status: null,
      provision: { offered: false, state: null, payment: null },
    });
    expect((await without.call(owner, "setAnchor", { destination: "place-aaaa" })).status).toBe(
      404,
    );
    expect((await without.call(owner, "clearAnchor")).status).toBe(404);

    const off = ledgerDeps({ recordLedgerEnabled: false });
    expect((await off.call(owner, "anchor")).body.json).toMatchObject({ label: null });
    expect((await off.call(owner, "setAnchor", { destination: "place-aaaa" })).status).toBe(404);
  });

  it("is audited as a credential change, without where the backups go", () => {
    for (const [path, type] of [
      ["setAnchor", "credential.changed"],
      ["clearAnchor", "credential.deleted"],
    ] as const) {
      const event = procedureSecurityEvent(
        ["recordLedger", path],
        { destination: "place-aaaa" },
        owner,
      );
      expect(event).toMatchObject({
        type,
        userId: owner.userId,
        metadata: { procedure: `recordLedger.${path}`, kind: "record_ledger_anchor" },
      });
      expect(JSON.stringify(event)).not.toContain("place-aaaa");
    }
    expect(procedureSecurityEvent(["recordLedger", "anchor"], {}, owner)).toBeUndefined();
  });

  it("is audited as a credential change, without the key", () => {
    const { recipient } = { recipient: "age1example" };
    for (const [path, type] of [
      ["addKey", "credential.created"],
      ["removeKey", "credential.deleted"],
    ] as const) {
      const event = procedureSecurityEvent(["recordLedger", path], { recipient }, owner);
      expect(event).toMatchObject({
        type,
        userId: owner.userId,
        spaceId: owner.spaceId,
        metadata: { procedure: `recordLedger.${path}`, kind: "record_ledger_key" },
      });
      expect(JSON.stringify(event)).not.toContain(recipient);
    }
    expect(procedureSecurityEvent(["recordLedger", "keys"], {}, owner)).toBeUndefined();
  });
});

describe("recordLedger.provision", () => {
  const OWNER_KEY = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";
  const PAID = { status: "active", paidAt: new Date("2026-11-01T00:00:00Z") };
  const begun = (provider: RecordLedgerProvider) => vi.mocked(provider.provisioning!.begin);
  const make = (options: Parameters<typeof ledgerDeps>[0] = {}) => {
    const provider = fakeProvider({ provisioning: true });
    return { provider, ...ledgerDeps({ provider, ...options }) };
  };

  it("offers a place to the owner, and has the ledger make one when asked", async () => {
    const { call, provider, provisions } = make();
    expect((await call(owner, "anchor")).body.json).toMatchObject({
      provision: { offered: true, state: null, payment: null },
    });

    const asked = await call(owner, "provision", { ownerKey: OWNER_KEY });

    expect(asked.status).toBe(200);
    expect(asked.body.json).toMatchObject({
      provision: { offered: false, state: "pending", payment: null },
    });
    expect(begun(provider)).toHaveBeenCalledExactlyOnceWith(
      "space-space-1",
      OWNER_KEY,
      expect.any(AbortSignal),
    );
    expect([...provisions.values()]).toMatchObject([{ spaceId: "space-1", ownerKey: OWNER_KEY }]);
  });

  it("asking again changes nothing", async () => {
    const { call, provisions } = make();

    await call(owner, "provision", { ownerKey: OWNER_KEY });
    const again = await call(owner, "provision", { ownerKey: OWNER_KEY });

    expect(again.status).toBe(200);
    expect(provisions.size).toBe(1);
  });

  describe("on a deployment that charges", () => {
    it("offers a place only to a paid plan", async () => {
      const { call, provider, provisions } = make({ billing: null });
      expect((await call(owner, "anchor")).body.json).toMatchObject({
        provision: { offered: false, state: null, payment: null },
      });

      const refused = await call(owner, "provision", { ownerKey: OWNER_KEY });

      expect(refused.status).toBe(403);
      expect(refused.body.json.code).toBe("plan_required");
      expect(provisions.size).toBe(0);
      expect(begun(provider)).not.toHaveBeenCalled();
    });

    it.each([
      ["a subscription that was never paid", { status: "trialing", paidAt: null }],
      ["one that has ended", { status: "canceled", paidAt: new Date("2026-10-01T00:00:00Z") }],
    ])("does not count %s as a paid plan", async (_label, billing) => {
      const { call } = make({ billing });

      expect((await call(owner, "anchor")).body.json).toMatchObject({
        provision: { offered: false },
      });
      expect((await call(owner, "provision", { ownerKey: OWNER_KEY })).status).toBe(403);
    });

    it("lets a paid plan have one", async () => {
      const { call } = make({ billing: PAID });

      expect((await call(owner, "anchor")).body.json).toMatchObject({
        provision: { offered: true },
      });
      expect((await call(owner, "provision", { ownerKey: OWNER_KEY })).status).toBe(200);
    });
  });

  describe("where the ledger sells places", () => {
    const sells = (options: Parameters<typeof ledgerDeps>[0] = {}) => {
      const provider = fakeProvider({ provisioning: true, sells: true });
      return { provider, ...ledgerDeps({ provider, ...options }) };
    };
    const DUE = { asset: "TEST", amount: "1.5", shortfall: "1.5", address: "pay-here" };

    it("lets a Space without a paid plan buy its place, and says what to pay", async () => {
      const { call, provider, provisions } = sells({ billing: null });
      expect((await call(owner, "anchor")).body.json).toMatchObject({
        provision: { offered: true, state: null, payment: null },
      });

      const asked = await call(owner, "provision", { ownerKey: OWNER_KEY });

      expect(asked.status).toBe(200);
      expect(asked.body.json).toMatchObject({
        provision: { offered: false, state: "pending", payment: DUE },
      });
      expect(begun(provider)).toHaveBeenCalledExactlyOnceWith(
        "space-space-1",
        OWNER_KEY,
        expect.any(AbortSignal),
        { paid: true },
      );
      expect([...provisions.values()]).toMatchObject([{ spaceId: "space-1", paid: true }]);
    });

    it("shows what is due on every read without asking the ledger again", async () => {
      const { call, provider } = sells({ billing: null });
      await call(owner, "provision", { ownerKey: OWNER_KEY });
      const asks = begun(provider).mock.calls.length;

      const first = await call(owner, "anchor");
      const second = await call(owner, "anchor");

      expect(first.body.json).toMatchObject({ provision: { state: "pending", payment: DUE } });
      expect(second.body.json).toEqual(first.body.json);
      expect(begun(provider).mock.calls.length).toBe(asks);
    });

    it("does not ask a Space with a paid plan to pay: the ledger makes its place as before", async () => {
      const { call, provider, provisions } = sells({ billing: PAID });

      const asked = await call(owner, "provision", { ownerKey: OWNER_KEY });

      expect(asked.body.json).toMatchObject({ provision: { state: "pending", payment: null } });
      expect(begun(provider)).toHaveBeenCalledExactlyOnceWith(
        "space-space-1",
        OWNER_KEY,
        expect.any(AbortSignal),
      );
      expect([...provisions.values()]).toMatchObject([{ paid: false }]);
    });

    it("asks no payment of a deployment that does not charge", async () => {
      const { call, provider } = sells();

      await call(owner, "provision", { ownerKey: OWNER_KEY });

      expect(begun(provider)).toHaveBeenCalledExactlyOnceWith(
        "space-space-1",
        OWNER_KEY,
        expect.any(AbortSignal),
      );
    });

    it("keeps a place a paid plan's alone while the ledger says it is not selling", async () => {
      const { call, provider, provisions } = sells({ billing: null });
      Object.assign(provider.provisioning!, { sale: { available: async () => false } });

      expect((await call(owner, "anchor")).body.json).toMatchObject({
        provision: { offered: false },
      });
      const refused = await call(owner, "provision", { ownerKey: OWNER_KEY });

      expect(refused.status).toBe(403);
      expect(refused.body.json.code).toBe("plan_required");
      expect(provisions.size).toBe(0);
    });
  });

  it("is for the Space's owner alone, and stores nothing for anyone else", async () => {
    const { call, provider, provisions } = make();

    for (const actor of [member, outsider]) {
      expect((await call(actor, "provision", { ownerKey: OWNER_KEY })).status).toBe(403);
    }

    expect(provisions.size).toBe(0);
    expect(begun(provider)).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing", {}],
    ["an empty key", { ownerKey: "" }],
    ["a key that is too short", { ownerKey: "abc" }],
    ["a key that is too long", { ownerKey: "A".repeat(44) }],
    ["characters outside base64url", { ownerKey: `${"A".repeat(42)}+` }],
    ["a private key", { ownerKey: "-----BEGIN PRIVATE KEY-----" }],
    ["anything more", { ownerKey: OWNER_KEY, controllers: ["x"] }],
  ])("refuses %s before asking the ledger", async (_label, input) => {
    const { call, provider, provisions } = make();

    expect((await call(owner, "provision", input)).status).toBe(400);

    expect(provisions.size).toBe(0);
    expect(begun(provider)).not.toHaveBeenCalled();
  });

  it("is not there where the ledger cannot make a place, or none is kept", async () => {
    const without = ledgerDeps({ provider: fakeProvider() });
    expect((await without.call(owner, "provision", { ownerKey: OWNER_KEY })).status).toBe(404);
    expect((await without.call(owner, "anchor")).body.json).toMatchObject({
      provision: { offered: false },
    });

    const off = ledgerDeps({ recordLedgerEnabled: false });
    expect((await off.call(owner, "provision", { ownerKey: OWNER_KEY })).status).toBe(404);
  });

  it("will not make one for a Space that already names a place, or asked with another key", async () => {
    const named = make();
    await named.call(owner, "setAnchor", { destination: "place-aaaa" });
    expect((await named.call(owner, "anchor")).body.json).toMatchObject({
      provision: { offered: false },
    });
    const refused = await named.call(owner, "provision", { ownerKey: OWNER_KEY });
    expect(refused.status).toBe(409);
    expect(refused.body.json.code).toBe("provision_exists");

    const asked = make();
    await asked.call(owner, "provision", { ownerKey: OWNER_KEY });
    const other = await asked.call(owner, "provision", {
      ownerKey: "GX9rI-FshTLGq8g4-s1ep4m-DHaykgM0A5v6iz02jWE",
    });
    expect(other.status).toBe(409);
    expect([...asked.provisions.values()]).toMatchObject([{ ownerKey: OWNER_KEY }]);
  });

  it("is audited as a credential created, without the key", () => {
    const event = procedureSecurityEvent(
      ["recordLedger", "provision"],
      { ownerKey: OWNER_KEY },
      owner,
    );

    expect(event).toMatchObject({
      type: "credential.created",
      userId: owner.userId,
      metadata: { procedure: "recordLedger.provision", kind: "record_ledger_provision" },
    });
    expect(JSON.stringify(event)).not.toContain(OWNER_KEY);
  });
});

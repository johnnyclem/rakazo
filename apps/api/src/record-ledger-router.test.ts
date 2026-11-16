import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { generateOwnerIdentity } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { MAX_OWNER_KEYS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
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

function ledgerDeps(options: { announcedUnderMasterKey?: boolean } = {}) {
  const keys: Array<KeyRow & { createdAt: Date }> = [];
  const roles = new Map([
    ["space-1:owner-1", "owner"],
    ["space-1:member-1", "member"],
  ]);
  const prisma = {
    spaceMember: {
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
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    env: { defaultProvider: "fake", defaultModel: "fake-model" },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps), {
    clientInterceptors: [onError((error, { path, signal }) => handleRpcError(error, path, signal))],
  });
  async function call(
    actor: Actor,
    path: "keys" | "addKey" | "removeKey",
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
  return { keys, call };
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

import {
  RecordLedgerDestinationInvalid,
  RecordLedgerProvisionRefused,
  RecordLedgerUnavailable,
} from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { AgentVaultRecordLedger } from "./agentvault-record-ledger.js";
import { createRecordLedgerProvider } from "./record-ledger-factory.js";

const signal = new AbortController().signal;
const HASH = "a".repeat(64);
const entries = [
  {
    seq: 1,
    kind: "memory.revision",
    occurredAt: new Date("2026-01-02T03:04:05.678Z"),
    payload: new Uint8Array([0xfb, 0xff, 0x00]),
  },
];

function ledger(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return new AgentVaultRecordLedger({
    baseUrl: "https://ledger.example.test/ignored/path",
    token: "fake-token",
    fetch: (async (input: string | URL | Request, init?: RequestInit) =>
      answer(String(input), init ?? {})) as typeof fetch,
  });
}

async function unavailable(attempt: Promise<unknown>): Promise<RecordLedgerUnavailable> {
  const error = await attempt.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(RecordLedgerUnavailable);
  return error as RecordLedgerUnavailable;
}

describe("AgentVaultRecordLedger", () => {
  it("posts sealed entries to the stream with the token, and never follows a redirect", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const head = await ledger((url, init) => {
      seen.push({ url, init });
      return Response.json({ head: { seq: 1, hash: HASH }, appended: 1 });
    }).append({ stream: "stream1", entries }, signal);

    expect(head).toEqual({ seq: 1, digest: HASH });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://ledger.example.test/v1/streams/stream1/entries");
    expect(seen[0]!.init).toMatchObject({ method: "POST", redirect: "error", signal });
    expect(seen[0]!.init.headers).toMatchObject({ authorization: "Bearer fake-token" });
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      entries: [
        { seq: 1, kind: "memory.revision", at: "2026-01-02T03:04:05.678Z", payload: "-_8A" },
      ],
    });
  });

  it("reports a refused token, a rejected request and an outage apart", async () => {
    const answers: Array<[Response | Error, RecordLedgerUnavailable["reason"]]> = [
      [Response.json({ error: "unauthorized" }, { status: 401 }), "credential"],
      [Response.json({ error: "invalid" }, { status: 400 }), "rejected"],
      [Response.json({ error: "too_large" }, { status: 413 }), "rejected"],
      [Response.json({ error: "internal" }, { status: 500 }), "unavailable"],
      [new Response("<html>bad gateway</html>", { status: 502 }), "unavailable"],
      [new TypeError("fetch failed"), "unavailable"],
    ];
    for (const [answer, reason] of answers) {
      const attempt = ledger(() => {
        if (answer instanceof Error) throw answer;
        return answer;
      }).append({ stream: "stream1", entries }, signal);
      expect((await unavailable(attempt)).reason).toBe(reason);
    }
  });

  it("does not take an answer it cannot read as an acknowledgement", async () => {
    for (const body of ["not json", "{}", JSON.stringify({ head: { seq: 1, hash: "short" } })]) {
      await unavailable(
        ledger(() => new Response(body)).append({ stream: "stream1", entries }, signal),
      );
    }
    // A 409 that names no known refusal is an outage, not a conflict.
    await unavailable(
      ledger(() => Response.json({ error: "busy" }, { status: 409 })).append(
        { stream: "stream1", entries },
        signal,
      ),
    );
  });

  it("reads a page of entries with the token, and turns each into what was sent", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const read = await ledger((url, init) => {
      seen.push({ url, init });
      return Response.json({
        entries: [
          { seq: 3, kind: "memory.revision", at: "2026-01-02T03:04:05.678Z", payload: "-_8A" },
        ],
        head: { seq: 3, hash: HASH },
      });
    }).read({ stream: "stream1", after: 2, limit: 50 }, signal);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(
      "https://ledger.example.test/v1/streams/stream1/entries?after=2&limit=50",
    );
    expect(seen[0]!.init).toMatchObject({ method: "GET", redirect: "error", signal });
    expect(seen[0]!.init.headers).toMatchObject({ authorization: "Bearer fake-token" });
    expect(read.head).toEqual({ seq: 3, digest: HASH });
    expect(read.entries).toEqual([
      {
        seq: 3,
        kind: "memory.revision",
        occurredAt: new Date("2026-01-02T03:04:05.678Z"),
        payload: Buffer.from([0xfb, 0xff, 0x00]),
      },
    ]);
  });

  it("lists streams, marking a damaged one unreadable", async () => {
    const seen: string[] = [];
    const listed = await ledger((url) => {
      seen.push(url);
      return Response.json({
        streams: [
          { stream: "a", head: { seq: 2, hash: HASH } },
          { stream: "b", head: null, corrupt: true },
        ],
        next: "b",
      });
    }).list({ after: "0", limit: 2 }, signal);

    expect(seen).toEqual(["https://ledger.example.test/v1/streams?limit=2&after=0"]);
    expect(listed).toEqual({
      streams: [
        { stream: "a", head: { seq: 2, digest: HASH }, unreadable: false },
        { stream: "b", head: null, unreadable: true },
      ],
      next: "b",
    });
  });

  it("reports a failed read or list as the ledger being unavailable, never as an empty stream", async () => {
    const attempts: Array<(wire: AgentVaultRecordLedger) => Promise<unknown>> = [
      (wire) => wire.read({ stream: "stream1", after: 0, limit: 10 }, signal),
      (wire) => wire.list({ limit: 10 }, signal),
    ];
    const answers: Array<[() => Response, RecordLedgerUnavailable["reason"]]> = [
      [() => Response.json({ error: "unauthorized" }, { status: 401 }), "credential"],
      [() => Response.json({ error: "invalid" }, { status: 400 }), "rejected"],
      [() => Response.json({ error: "internal" }, { status: 500 }), "unavailable"],
      [() => new Response("not json"), "unavailable"],
      [() => Response.json({ entries: "nope", streams: "nope" }), "unavailable"],
    ];
    for (const attempt of attempts) {
      for (const [answer, reason] of answers) {
        expect((await unavailable(attempt(ledger(answer)))).reason).toBe(reason);
      }
    }
  });

  it("refuses a URL that would send the token in the clear", () => {
    const create = (baseUrl: string) =>
      new AgentVaultRecordLedger({ baseUrl, token: "fake-token" });
    expect(() => create("http://ledger.example.test")).toThrow(/https/);
    expect(() => create("not a url")).toThrow(/https/);
    expect(() => create("http://127.0.0.1:8787")).not.toThrow();
    expect(() => create("http://localhost:8787")).not.toThrow();
    expect(
      () => new AgentVaultRecordLedger({ baseUrl: "https://ledger.example.test", token: "" }),
    ).toThrow(/token/);
  });
});

describe("createRecordLedgerProvider", () => {
  it("is off unless a provider is named", () => {
    expect(createRecordLedgerProvider({})).toBeUndefined();
    expect(createRecordLedgerProvider({ RECORD_LEDGER_PROVIDER: "disabled" })).toBeUndefined();
    // Connection settings alone do not turn it on.
    expect(
      createRecordLedgerProvider({
        RECORD_LEDGER_URL: "https://ledger.example.test",
        RECORD_LEDGER_TOKEN: "fake-token",
      }),
    ).toBeUndefined();
  });

  it("builds the named provider from the connection settings", () => {
    const provider = createRecordLedgerProvider({
      RECORD_LEDGER_PROVIDER: " AgentVault ",
      RECORD_LEDGER_URL: "https://ledger.example.test",
      RECORD_LEDGER_TOKEN: "fake-token",
    });
    expect(provider?.describe()).toMatchObject({ id: "agentvault", contractVersion: "1" });
  });

  it("fails at startup on a half-configured or unknown provider", () => {
    expect(() => createRecordLedgerProvider({ RECORD_LEDGER_PROVIDER: "agentvault" })).toThrow(
      /RECORD_LEDGER_URL and RECORD_LEDGER_TOKEN/,
    );
    expect(() => createRecordLedgerProvider({ RECORD_LEDGER_PROVIDER: "nope" })).toThrow(
      /Unknown record ledger provider/,
    );
  });
});

describe("AgentVaultRecordLedger anchoring", () => {
  const CANISTER = "uxrrr-q7777-77774-qaaaq-cai";
  const WRITER = "yzoj6-sgrt2-fa25n-xcseg-7gr7y-7nciu-cuqts-edigf-s5vts-cwigu-jae";

  it("asks the gateway which identity it writes as, which is what an owner has to allow", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const principal = await ledger((url, init) => {
      seen.push({ url, init });
      return Response.json({ principal: WRITER });
    }).anchoring.writer(signal);

    expect(principal).toBe(WRITER);
    expect(seen[0]!.url).toBe("https://ledger.example.test/v1/identity");
    expect(seen[0]!.init.headers).toMatchObject({ authorization: "Bearer fake-token" });
  });

  it("says it has nothing to offer when the gateway has no identity to give", async () => {
    const error = await unavailable(
      ledger(() =>
        Response.json({ error: "anchoring_not_configured" }, { status: 404 }),
      ).anchoring.writer(signal),
    );
    expect(error.reason).toBe("unavailable");
  });

  it("names a canister for a stream, and puts it back with the rest", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const gateway = ledger((url, init) => {
      seen.push({ url, init });
      return Response.json({ destination: null, anchoredSeq: 0, headSeq: 0, error: null });
    });

    await gateway.anchoring.setDestination("stream1", CANISTER, signal);
    await gateway.anchoring.setDestination("stream1", null, signal);

    expect(seen.map(({ url, init }) => [init.method, url])).toEqual([
      ["PUT", "https://ledger.example.test/v1/streams/stream1/anchor"],
      ["DELETE", "https://ledger.example.test/v1/streams/stream1/anchor"],
    ]);
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ destination: CANISTER });
    expect(seen[0]!.init).toMatchObject({ redirect: "error", signal });
  });

  it("refuses what is not a canister id before asking anything, and again if the gateway does", async () => {
    let asked = 0;
    const gateway = ledger(() => {
      asked += 1;
      return Response.json({ error: "invalid" }, { status: 400 });
    });
    for (const bad of ["", "not a canister", `${CANISTER}x`, CANISTER.toUpperCase(), "aaaaa-aa"]) {
      expect(() => gateway.anchoring.validate(bad), bad).toThrow(RecordLedgerDestinationInvalid);
    }
    expect(() => gateway.anchoring.validate(CANISTER)).not.toThrow();
    expect(asked).toBe(0);

    // A name that has the right shape but is not one is the gateway's to refuse.
    await expect(
      gateway.anchoring.setDestination("stream1", CANISTER, signal),
    ).rejects.toBeInstanceOf(RecordLedgerDestinationInvalid);
  });

  it("tells a gateway that cannot anchor apart from one that is down, and does not fail putting a stream back", async () => {
    const unconfigured = ledger(() =>
      Response.json({ error: "anchoring_not_configured" }, { status: 409 }),
    );
    expect(
      (await unavailable(unconfigured.anchoring.setDestination("stream1", CANISTER, signal)))
        .reason,
    ).toBe("unavailable");
    await expect(
      unconfigured.anchoring.setDestination("stream1", null, signal),
    ).resolves.toBeUndefined();

    const refusedToken = ledger(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    expect(
      (await unavailable(refusedToken.anchoring.setDestination("stream1", CANISTER, signal)))
        .reason,
    ).toBe("credential");
    const down = ledger(() => new Response("bad gateway", { status: 502 }));
    expect(
      (await unavailable(down.anchoring.setDestination("stream1", CANISTER, signal))).reason,
    ).toBe("unavailable");
  });

  it("reports how far a stream is kept, and turns the canister's refusal into a code of its own", async () => {
    const state = (error: string | null, extra: object = {}) => ({
      destination: CANISTER,
      anchoredSeq: 2,
      headSeq: 5,
      error,
      ...extra,
    });
    const status = (body: object) =>
      ledger(() => Response.json(body)).anchoring.status("stream1", signal);

    expect(await status(state(null))).toEqual({
      destination: CANISTER,
      anchoredSeq: 2,
      headSeq: 5,
      error: null,
    });
    expect(
      (
        await status(
          state(
            `memory_repo refused the write: yzoj6 is ${NOT_ALLOWED_TEXT}. The owner can allow it.`,
          ),
        )
      )?.error,
    ).toBe("not_allowed");
    expect((await status(state("canister unreachable")))?.error).toBe("failed");
    // A stream that is kept nowhere and holds nothing is not one the ledger knows.
    expect(await status({ destination: null, anchoredSeq: 0, headSeq: 0, error: null })).toBeNull();
    expect(
      (await status({ destination: null, anchoredSeq: 0, headSeq: 3, error: null }))?.headSeq,
    ).toBe(3);
  });

  it("never passes the canister's own words on", async () => {
    const answer = await ledger(() =>
      Response.json({
        destination: CANISTER,
        anchoredSeq: 0,
        headSeq: 1,
        error: "refused: run `agentvault memory authorize yzoj6`",
      }),
    ).anchoring.status("stream1", signal);
    expect(JSON.stringify(answer)).not.toMatch(/agentvault|memory_repo|authorize/);
  });

  it("is a gateway-level problem, not a stream's, when the answer is not one it understands", async () => {
    const error = await unavailable(
      ledger(() => Response.json({ nonsense: true })).anchoring.status("stream1", signal),
    );
    expect(error.reason).toBe("unavailable");
  });
});

const NOT_ALLOWED_TEXT = "neither the repo owner nor an authorized principal";

describe("AgentVaultRecordLedger provisioning", () => {
  const OWNER_KEY = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";
  const OWNER_ADDRESS = "tek7g-2zmny-nzjwg-ansf7-rkxv6-z32x6-3flbb-ous5d-pygjx-wkhlc-jae";
  const CANISTER = "uzt4z-lp777-77774-qaabq-cai";
  const record = (state: string, extra: object = {}) => ({
    key: "k",
    owner: OWNER_ADDRESS,
    state,
    canisterId: null,
    moduleHash: null,
    error: null,
    ...extra,
  });

  it("asks the gateway to make a place for the address its owner key holds, nothing else", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const gateway = ledger((url, init) => {
      seen.push({ url, init });
      return Response.json(record("pending"), { status: 202 });
    });

    const snapshot = await gateway.provisioning.begin("space-1", OWNER_KEY, signal);

    expect(snapshot).toEqual({ state: "pending", destination: null, error: null, payment: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://ledger.example.test/v1/canisters");
    expect(seen[0]!.init).toMatchObject({ method: "POST", redirect: "error", signal });
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      key: "space-1",
      owner: OWNER_ADDRESS,
    });
  });

  it("gives back the place once it is ready", async () => {
    const gateway = ledger(() => Response.json(record("ready", { canisterId: CANISTER })));

    await expect(gateway.provisioning.begin("space-1", OWNER_KEY, signal)).resolves.toEqual({
      state: "ready",
      destination: CANISTER,
      error: null,
      payment: null,
    });
  });

  it("passes on why a request failed, for operators", async () => {
    const gateway = ledger(() =>
      Response.json(record("failed", { error: "install was cut short" })),
    );

    await expect(gateway.provisioning.begin("space-1", OWNER_KEY, signal)).resolves.toMatchObject({
      state: "failed",
      error: "install was cut short",
    });
  });

  it("refuses a key that is not an Ed25519 public key without calling the gateway", async () => {
    let called = false;
    const gateway = ledger(() => {
      called = true;
      return Response.json(record("pending"));
    });

    await expect(gateway.provisioning.begin("space-1", "not-a-key", signal)).rejects.toMatchObject({
      reason: "invalid_owner",
    });
    expect(called).toBe(false);
  });

  it.each([
    ["invalid_owner", 400, "invalid_owner"],
    ["invalid_key", 400, "invalid_owner"],
    ["key_conflict", 409, "key_conflict"],
    ["limit_reached", 429, "limit_reached"],
  ])(
    "turns the gateway's %s into a refusal the product can switch on",
    async (error, status, reason) => {
      const gateway = ledger(() =>
        Response.json({ error, message: `because ${error}` }, { status }),
      );

      const refused = await gateway.provisioning
        .begin("space-1", OWNER_KEY, signal)
        .catch((e: unknown) => e);

      expect(refused).toBeInstanceOf(RecordLedgerProvisionRefused);
      expect(refused).toMatchObject({ reason, message: `because ${error}` });
    },
  );

  it("treats a refused token, an outage and an unreadable answer as the ledger being unavailable", async () => {
    const refusedToken = ledger(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    expect(
      (await unavailable(refusedToken.provisioning.begin("k", OWNER_KEY, signal))).reason,
    ).toBe("credential");
    const down = ledger(() => Response.json({}, { status: 503 }));
    expect((await unavailable(down.provisioning.begin("k", OWNER_KEY, signal))).reason).toBe(
      "unavailable",
    );
    const nonsense = ledger(() => Response.json({ nonsense: true }, { status: 202 }));
    expect((await unavailable(nonsense.provisioning.begin("k", OWNER_KEY, signal))).reason).toBe(
      "unavailable",
    );
    const unreachable = ledger(() => {
      throw new Error("connection reset");
    });
    await unavailable(unreachable.provisioning.begin("k", OWNER_KEY, signal));
  });

  it("is available only where the gateway says it was started to make places", async () => {
    const identity = (extra: object) =>
      ledger(() => Response.json({ principal: "yzoj6-sgrt2", ...extra }));

    await expect(identity({ provisioning: true }).provisioning.available(signal)).resolves.toBe(
      true,
    );
    await expect(identity({ provisioning: false }).provisioning.available(signal)).resolves.toBe(
      false,
    );
    // A gateway from before it could make places says nothing either way.
    await expect(identity({}).provisioning.available(signal)).resolves.toBe(false);
    // One with nothing to anchor with has no identity at all.
    const none = ledger(() =>
      Response.json({ error: "anchoring_not_configured" }, { status: 404 }),
    );
    await expect(none.provisioning.available(signal)).resolves.toBe(false);
    expect(identity({}).provisioning.ownerKey).toBe("ed25519");
  });

  it("asks only for the gateway's identity, and says so when the token is refused", async () => {
    const seen: Array<{ url: string; method: unknown }> = [];
    const gateway = ledger((url, init) => {
      seen.push({ url, method: init.method });
      return Response.json({ error: "unauthorized" }, { status: 401 });
    });

    expect((await unavailable(gateway.provisioning.available(signal))).reason).toBe("credential");
    expect(seen).toEqual([{ url: "https://ledger.example.test/v1/identity", method: "GET" }]);
  });
});

describe("AgentVaultRecordLedger sales", () => {
  const OWNER_KEY = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";
  const OWNER_ADDRESS = "tek7g-2zmny-nzjwg-ansf7-rkxv6-z32x6-3flbb-ous5d-pygjx-wkhlc-jae";
  const CANISTER = "uzt4z-lp777-77774-qaabq-cai";
  const ACCOUNT = "ab".repeat(32);
  /** An order as the gateway states it, with more fields than are read. */
  const order = (state: string, extra: object = {}) => ({
    key: "space-1",
    owner: OWNER_ADDRESS,
    state,
    deposit: { owner: "yzoj6-sgrt2", subaccount: "cd".repeat(32), accountId: ACCOUNT },
    price: { e8s: "135851881", expiresAt: "2026-11-23T04:06:28.545Z" },
    paidE8s: "0",
    shortfallE8s: "135851881",
    canisterId: null,
    error: null,
    ...extra,
  });
  const paid = { paid: true };

  it("sells only where the gateway says it was started with a price", async () => {
    const identity = (extra: object) =>
      ledger(() => Response.json({ principal: "yzoj6-sgrt2", ...extra }));

    await expect(identity({ orders: true }).provisioning.sale!.available(signal)).resolves.toBe(
      true,
    );
    await expect(identity({ orders: false }).provisioning.sale!.available(signal)).resolves.toBe(
      false,
    );
    // A gateway from before it sold says nothing either way.
    await expect(
      identity({ provisioning: true }).provisioning.sale!.available(signal),
    ).resolves.toBe(false);
    const none = ledger(() =>
      Response.json({ error: "anchoring_not_configured" }, { status: 404 }),
    );
    await expect(none.provisioning.sale!.available(signal)).resolves.toBe(false);
    const refused = ledger(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    expect((await unavailable(refused.provisioning.sale!.available(signal))).reason).toBe(
      "credential",
    );
  });

  it("opens an order, not a canister, for a place that is paid for", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const gateway = ledger((url, init) => {
      seen.push({ url, init });
      return Response.json(order("awaiting_payment"));
    });

    await gateway.provisioning.begin("space-1", OWNER_KEY, signal, paid);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://ledger.example.test/v1/orders");
    expect(seen[0]!.init).toMatchObject({ method: "POST", redirect: "error", signal });
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      key: "space-1",
      owner: OWNER_ADDRESS,
    });
  });

  it("still asks for a canister, as before, when nothing is paid", async () => {
    const urls: string[] = [];
    const gateway = ledger((url) => {
      urls.push(url);
      return Response.json(
        {
          key: "k",
          owner: OWNER_ADDRESS,
          state: "pending",
          canisterId: null,
          moduleHash: null,
          error: null,
        },
        { status: 202 },
      );
    });

    await gateway.provisioning.begin("space-1", OWNER_KEY, signal);
    await gateway.provisioning.begin("space-1", OWNER_KEY, signal, {});
    await gateway.provisioning.begin("space-1", OWNER_KEY, signal, { paid: false });

    expect(urls).toEqual(Array(3).fill("https://ledger.example.test/v1/canisters"));
  });

  it("says what to send, how much, and where, in the numbers a person reads", async () => {
    const gateway = ledger(() => Response.json(order("awaiting_payment")));

    await expect(gateway.provisioning.begin("space-1", OWNER_KEY, signal, paid)).resolves.toEqual({
      state: "pending",
      destination: null,
      error: null,
      payment: { asset: "ICP", amount: "1.35851881", shortfall: "1.35851881", address: ACCOUNT },
    });
  });

  it.each([
    ["one that is part paid", "135851881", "35851881", "1.35851881", "0.35851881"],
    ["a whole number", "200000000", "200000000", "2", "2"],
    ["the smallest amount", "5", "5", "0.00000005", "0.00000005"],
    ["a large one", "12345678901234567890", "1", "123456789012.3456789", "0.00000001"],
    ["nothing still to pay", "135851881", "0", "1.35851881", "0"],
  ])("counts %s without rounding", async (_label, price, shortfall, amount, missing) => {
    const gateway = ledger(() =>
      Response.json(order("awaiting_payment", { price: { e8s: price }, shortfallE8s: shortfall })),
    );

    const { payment } = await gateway.provisioning.begin("space-1", OWNER_KEY, signal, paid);

    expect(payment).toMatchObject({ amount, shortfall: missing });
  });

  it.each(["converting", "provisioning"])(
    "is being made once the payment is in (%s), and owes nothing",
    async (state) => {
      const gateway = ledger(() =>
        Response.json(order(state, { paidE8s: "135851881", shortfallE8s: "0" })),
      );

      await expect(gateway.provisioning.begin("space-1", OWNER_KEY, signal, paid)).resolves.toEqual(
        {
          state: "pending",
          destination: null,
          error: null,
          payment: null,
        },
      );
    },
  );

  it("gives back the place once it is ready", async () => {
    const gateway = ledger(() =>
      Response.json(order("ready", { canisterId: CANISTER, shortfallE8s: "0" })),
    );

    await expect(gateway.provisioning.begin("space-1", OWNER_KEY, signal, paid)).resolves.toEqual({
      state: "ready",
      destination: CANISTER,
      error: null,
      payment: null,
    });
  });

  it("does not hand over a ready order that names no canister", async () => {
    const gateway = ledger(() => Response.json(order("ready", { canisterId: null })));

    await unavailable(gateway.provisioning.begin("space-1", OWNER_KEY, signal, paid));
  });

  it("fails an order the gateway failed, with its reason for operators, and one that expired", async () => {
    const failed = ledger(() =>
      Response.json(order("failed", { error: "The minting canister refunded the payment" })),
    );
    await expect(
      failed.provisioning.begin("space-1", OWNER_KEY, signal, paid),
    ).resolves.toMatchObject({
      state: "failed",
      error: "The minting canister refunded the payment",
      payment: null,
    });

    const expired = ledger(() => Response.json(order("expired")));
    await expect(
      expired.provisioning.begin("space-1", OWNER_KEY, signal, paid),
    ).resolves.toMatchObject({
      state: "failed",
      payment: null,
    });
  });

  it.each([
    ["key_conflict", 409, "key_conflict"],
    ["limit_reached", 429, "limit_reached"],
    ["invalid_owner", 400, "invalid_owner"],
    ["invalid_key", 400, "invalid_owner"],
  ])("turns the gateway's %s into a refusal of its own", async (error, status, reason) => {
    const gateway = ledger(() => Response.json({ error, message: "no" }, { status }));

    await expect(
      gateway.provisioning.begin("space-1", OWNER_KEY, signal, paid),
    ).rejects.toMatchObject({
      name: "RecordLedgerProvisionRefused",
      reason,
    });
  });

  it("takes a gateway that does not sell, a refused token and an answer it cannot read as the ledger being unavailable", async () => {
    const notSelling = ledger(() =>
      Response.json({ error: "orders_not_configured" }, { status: 404 }),
    );
    await unavailable(notSelling.provisioning.begin("space-1", OWNER_KEY, signal, paid));

    const refusedToken = ledger(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    expect(
      (await unavailable(refusedToken.provisioning.begin("k", OWNER_KEY, signal, paid))).reason,
    ).toBe("credential");

    for (const unreadable of [
      order("awaiting_payment", { deposit: { accountId: "not-an-account" } }),
      order("awaiting_payment", { price: { e8s: "1.5" } }),
      order("awaiting_payment", { shortfallE8s: "-1" }),
      order("on_fire"),
      { state: "awaiting_payment" },
    ]) {
      await unavailable(
        ledger(() => Response.json(unreadable)).provisioning.begin("k", OWNER_KEY, signal, paid),
      );
    }
  });

  it("refuses a key that is not an Ed25519 public key before calling the gateway, paid or not", async () => {
    let called = 0;
    const gateway = ledger(() => {
      called += 1;
      return Response.json(order("awaiting_payment"));
    });

    await expect(
      gateway.provisioning.begin("space-1", "not-a-key", signal, paid),
    ).rejects.toMatchObject({ reason: "invalid_owner" });
    expect(called).toBe(0);
  });
});

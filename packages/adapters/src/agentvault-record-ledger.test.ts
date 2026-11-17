import { RecordLedgerDestinationInvalid, RecordLedgerUnavailable } from "@rakazo/adapter-kit";
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

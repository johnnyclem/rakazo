import type {
  RecordLedgerAnchoring,
  RecordLedgerAnchorStatus,
  RecordLedgerAppendRequest,
  RecordLedgerHead,
  RecordLedgerListRequest,
  RecordLedgerListResult,
  RecordLedgerProvider,
  RecordLedgerProvisioning,
  RecordLedgerProvisionSnapshot,
  RecordLedgerReadRequest,
  RecordLedgerReadResult,
} from "@rakazo/adapter-kit";
import {
  RecordLedgerConflict,
  RecordLedgerDestinationInvalid,
  RecordLedgerProvisionRefused,
  RecordLedgerUnavailable,
} from "@rakazo/adapter-kit";
import { secureHttpOrigin } from "@rakazo/contracts";
import { z } from "zod";
import { isEd25519PublicKey, ownerAddress } from "./agentvault-owner-address.js";
import { readBoundedText } from "./connector-http.js";

/** The gateway's own limits: 256 KiB a payload, and an 8 MiB body that base64 must fit in. */
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_BATCH_ENTRIES = 100;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
/** An append answers with a head; a read answers with up to a batch of entries. */
const RESPONSE_MAX_BYTES = 12 * 1024 * 1024;

const head = z.object({ seq: z.number().int().min(1), hash: z.string().regex(/^[0-9a-f]{64}$/) });
const appended = z.object({ head });
const refused = z.object({ error: z.string(), head: head.nullish() });
const entries = z.object({
  entries: z.array(
    z.object({
      seq: z.number().int().min(1),
      kind: z.string(),
      at: z.string().datetime(),
      payload: z.string().regex(/^[A-Za-z0-9_-]*$/),
    }),
  ),
  head: head.nullable(),
});
const streamList = z.object({
  streams: z.array(
    z.object({ stream: z.string(), head: head.nullable(), corrupt: z.boolean().optional() }),
  ),
  next: z.string().nullable(),
});

const writerIdentity = z.object({ principal: z.string().min(1) });
const anchorState = z.object({
  destination: z.string().nullable(),
  anchoredSeq: z.number().int().min(0),
  headSeq: z.number().int().min(0),
  error: z.string().nullable(),
});

/** A canister id: five groups of five characters ending in `cai`, as the network writes them. */
const provisionState = z.object({
  state: z.enum(["pending", "ready", "failed"]),
  canisterId: z.string().nullable(),
  error: z.string().nullable(),
});
const REFUSALS = {
  invalid_owner: "invalid_owner",
  invalid_key: "invalid_owner",
  key_conflict: "key_conflict",
  limit_reached: "limit_reached",
} as const;
const CANISTER_ID = /^[a-z0-9]{5}(-[a-z0-9]{5}){3}-cai$/;
/** What the canister says when the owner has not allowed the gateway to write to it. */
const NOT_ALLOWED = "neither the repo owner nor an authorized principal";

export interface AgentVaultRecordLedgerOptions {
  /** The ledger gateway's origin, such as `https://ledger.example.test`. */
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

/** Appends to an AgentVault ledger gateway, which chains the entries and anchors them on a canister. */
export class AgentVaultRecordLedger implements RecordLedgerProvider {
  private readonly origin: string;
  private readonly token: string;
  private readonly send: typeof fetch;

  constructor(options: AgentVaultRecordLedgerOptions) {
    const origin = secureHttpOrigin(options.baseUrl);
    if (!origin) throw new Error("The record ledger URL must be https, or http on this machine");
    if (!options.token) throw new Error("The record ledger needs a token");
    this.origin = origin;
    this.token = options.token;
    this.send = options.fetch ?? fetch;
  }

  /** A stream's copy can be kept on a canister its owner holds; the gateway says if it cannot. */
  readonly anchoring: RecordLedgerAnchoring = {
    label: "Canister ID",
    writer: async (signal) => {
      const { response, body } = await this.call("/v1/identity", { method: "GET" }, signal);
      const parsed = writerIdentity.safeParse(body);
      // A gateway with no replica to anchor on has no identity to give, and nothing to offer.
      if (!response.ok || !parsed.success) throw refusal(response.ok ? 502 : response.status);
      return parsed.data.principal;
    },
    validate: (destination) => {
      if (!CANISTER_ID.test(destination)) {
        throw new RecordLedgerDestinationInvalid("Not a canister ID");
      }
    },
    setDestination: async (stream, destination, signal) => {
      const path = `/v1/streams/${encodeURIComponent(stream)}/anchor`;
      const { response } =
        destination === null
          ? await this.call(path, { method: "DELETE" }, signal)
          : await this.call(
              path,
              {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ destination }),
              },
              signal,
            );
      if (response.ok) return;
      // Naming nowhere is already true of a gateway that has no places to name.
      if (destination === null && response.status === 409) return;
      if (destination !== null && response.status === 400) {
        throw new RecordLedgerDestinationInvalid("Not a canister ID");
      }
      throw refusal(response.status);
    },
    status: async (stream, signal): Promise<RecordLedgerAnchorStatus | null> => {
      const { response, body } = await this.call(
        `/v1/streams/${encodeURIComponent(stream)}/anchor`,
        { method: "GET" },
        signal,
      );
      if (!response.ok) throw refusal(response.status);
      const parsed = anchorState.safeParse(body);
      if (!parsed.success) throw new RecordLedgerUnavailable("unavailable");
      const { destination, anchoredSeq, headSeq, error } = parsed.data;
      if (!destination && headSeq === 0) return null;
      return {
        destination,
        anchoredSeq,
        headSeq,
        // The gateway passes on the canister's own words; only this adapter reads them.
        error: error === null ? null : error.includes(NOT_ALLOWED) ? "not_allowed" : "failed",
      };
    },
  };

  /** The gateway can also make the canister, and hand it over, when it was started to. */
  readonly provisioning: RecordLedgerProvisioning = {
    ownerKey: "ed25519",
    available: async (signal) => {
      // The gateway says whether it was started to make canisters; an older one says nothing.
      const { response, body } = await this.call("/v1/identity", { method: "GET" }, signal);
      if (response.status === 404) return false;
      if (!response.ok) throw refusal(response.status);
      return (body as { provisioning?: unknown } | undefined)?.provisioning === true;
    },
    begin: async (key, ownerKey, signal): Promise<RecordLedgerProvisionSnapshot> => {
      if (!isEd25519PublicKey(ownerKey)) {
        throw new RecordLedgerProvisionRefused(
          "invalid_owner",
          "The owner key is not an Ed25519 public key",
        );
      }
      const { response, body } = await this.call(
        "/v1/canisters",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key, owner: ownerAddress(ownerKey) }),
        },
        signal,
      );
      if (response.ok) {
        const parsed = provisionState.safeParse(body);
        if (!parsed.success) throw new RecordLedgerUnavailable("unavailable");
        return {
          state: parsed.data.state,
          destination: parsed.data.canisterId,
          error: parsed.data.error,
        };
      }
      const named = (body as { error?: unknown; message?: unknown } | undefined) ?? {};
      const reason =
        typeof named.error === "string"
          ? REFUSALS[named.error as keyof typeof REFUSALS]
          : undefined;
      if (reason) {
        throw new RecordLedgerProvisionRefused(
          reason,
          typeof named.message === "string" ? named.message : "The ledger turned the request down",
        );
      }
      throw refusal(response.status);
    },
  };

  describe() {
    return {
      id: "agentvault",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        offline: false,
        maxEntryBytes: MAX_ENTRY_BYTES,
        maxBatchEntries: MAX_BATCH_ENTRIES,
        maxBatchBytes: MAX_BATCH_BYTES,
      },
    };
  }

  async append(request: RecordLedgerAppendRequest, signal: AbortSignal): Promise<RecordLedgerHead> {
    const { response, body } = await this.call(
      `/v1/streams/${encodeURIComponent(request.stream)}/entries`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entries: request.entries.map((entry) => ({
            seq: entry.seq,
            kind: entry.kind,
            at: entry.occurredAt.toISOString(),
            payload: Buffer.from(entry.payload).toString("base64url"),
          })),
        }),
      },
      signal,
    );
    if (response.ok) {
      const parsed = appended.safeParse(body);
      if (!parsed.success) throw new RecordLedgerUnavailable("unavailable");
      return toHead(parsed.data.head);
    }
    if (response.status === 409) {
      const parsed = refused.safeParse(body);
      if (parsed.success && (parsed.data.error === "gap" || parsed.data.error === "conflict")) {
        const at = parsed.data.head;
        throw new RecordLedgerConflict(parsed.data.error, at ? toHead(at) : null);
      }
    }
    throw refusal(response.status);
  }

  async read(
    request: RecordLedgerReadRequest,
    signal: AbortSignal,
  ): Promise<RecordLedgerReadResult> {
    const query = new URLSearchParams({
      after: String(request.after),
      limit: String(request.limit),
    });
    const { response, body } = await this.call(
      `/v1/streams/${encodeURIComponent(request.stream)}/entries?${query}`,
      { method: "GET" },
      signal,
    );
    if (!response.ok) throw refusal(response.status);
    const parsed = entries.safeParse(body);
    if (!parsed.success) throw new RecordLedgerUnavailable("unavailable");
    return {
      entries: parsed.data.entries.map((entry) => ({
        seq: entry.seq,
        kind: entry.kind,
        occurredAt: new Date(entry.at),
        payload: Buffer.from(entry.payload, "base64url"),
      })),
      head: parsed.data.head ? toHead(parsed.data.head) : null,
    };
  }

  async list(
    request: RecordLedgerListRequest,
    signal: AbortSignal,
  ): Promise<RecordLedgerListResult> {
    const query = new URLSearchParams({ limit: String(request.limit) });
    if (request.after) query.set("after", request.after);
    const { response, body } = await this.call(`/v1/streams?${query}`, { method: "GET" }, signal);
    if (!response.ok) throw refusal(response.status);
    const parsed = streamList.safeParse(body);
    if (!parsed.success) throw new RecordLedgerUnavailable("unavailable");
    return {
      streams: parsed.data.streams.map((item) => ({
        stream: item.stream,
        head: item.head ? toHead(item.head) : null,
        unreadable: item.corrupt === true,
      })),
      next: parsed.data.next,
    };
  }

  /** One request, with the token, answered by its status and whatever JSON came back. */
  private async call(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    signal: AbortSignal,
  ): Promise<{ response: Response; body: unknown }> {
    try {
      const response = await this.send(`${this.origin}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.token}`, ...init.headers },
        // A redirect would resend the entries, and the token, somewhere unconfigured.
        redirect: "error",
        signal,
      });
      const { text } = await readBoundedText(response, RESPONSE_MAX_BYTES);
      return { response, body: parseJson(text) };
    } catch (error) {
      throw new RecordLedgerUnavailable("unavailable", { cause: error });
    }
  }
}

/** Why a request that was not accepted failed: a refused token, a bad request, or an outage. */
function refusal(status: number): RecordLedgerUnavailable {
  if (status === 401 || status === 403) return new RecordLedgerUnavailable("credential");
  return new RecordLedgerUnavailable(status === 400 || status === 413 ? "rejected" : "unavailable");
}

function toHead(value: z.infer<typeof head>): RecordLedgerHead {
  return { seq: value.seq, digest: value.hash };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

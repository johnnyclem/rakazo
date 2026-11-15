import type {
  RecordLedgerAppendRequest,
  RecordLedgerHead,
  RecordLedgerListRequest,
  RecordLedgerListResult,
  RecordLedgerProvider,
  RecordLedgerReadRequest,
  RecordLedgerReadResult,
} from "@rakazo/adapter-kit";
import { RecordLedgerConflict, RecordLedgerUnavailable } from "@rakazo/adapter-kit";
import { secureHttpOrigin } from "@rakazo/contracts";
import { z } from "zod";
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

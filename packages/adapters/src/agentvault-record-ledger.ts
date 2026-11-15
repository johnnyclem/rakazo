import type {
  RecordLedgerAppendRequest,
  RecordLedgerHead,
  RecordLedgerProvider,
} from "@rakazo/adapter-kit";
import { RecordLedgerConflict, RecordLedgerUnavailable } from "@rakazo/adapter-kit";
import { secureHttpOrigin } from "@rakazo/contracts";
import { z } from "zod";
import { readBoundedText } from "./connector-http.js";

/** The gateway's own limits: 256 KiB a payload, and an 8 MiB body that base64 must fit in. */
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_BATCH_ENTRIES = 100;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const RESPONSE_MAX_BYTES = 64 * 1024;

const head = z.object({ seq: z.number().int().min(1), hash: z.string().regex(/^[0-9a-f]{64}$/) });
const appended = z.object({ head });
const refused = z.object({ error: z.string(), head: head.nullish() });

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
    let response: Response;
    let text: string;
    try {
      response = await this.send(
        `${this.origin}/v1/streams/${encodeURIComponent(request.stream)}/entries`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            entries: request.entries.map((entry) => ({
              seq: entry.seq,
              kind: entry.kind,
              at: entry.occurredAt.toISOString(),
              payload: Buffer.from(entry.payload).toString("base64url"),
            })),
          }),
          // A redirect would resend the entries, and the token, somewhere unconfigured.
          redirect: "error",
          signal,
        },
      );
      ({ text } = await readBoundedText(response, RESPONSE_MAX_BYTES));
    } catch (error) {
      throw new RecordLedgerUnavailable("unavailable", { cause: error });
    }

    const body = parseJson(text);
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
    if (response.status === 401 || response.status === 403) {
      throw new RecordLedgerUnavailable("credential");
    }
    throw new RecordLedgerUnavailable(
      response.status === 400 || response.status === 413 ? "rejected" : "unavailable",
    );
  }
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

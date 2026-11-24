import type { RecordLedgerProvider } from "@rakazo/adapter-kit";
import { AgentVaultRecordLedger } from "./agentvault-record-ledger.js";

/** The deployment's record ledger, or undefined when none is configured. */
export function createRecordLedgerProvider(
  env: NodeJS.ProcessEnv = process.env,
): RecordLedgerProvider | undefined {
  const kind = env.RECORD_LEDGER_PROVIDER?.trim().toLowerCase();
  if (!kind || kind === "disabled") return undefined;
  if (kind !== "agentvault") throw new Error("Unknown record ledger provider");
  const baseUrl = env.RECORD_LEDGER_URL?.trim();
  const token = env.RECORD_LEDGER_TOKEN?.trim();
  if (!baseUrl || !token) {
    throw new Error("A record ledger needs RECORD_LEDGER_URL and RECORD_LEDGER_TOKEN");
  }
  return new AgentVaultRecordLedger({ baseUrl, token });
}

import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import type { ReadEntry, RestoreReport } from "@rakazo/adapters";
import {
  contentKeyProviderFromEnv,
  createRecordLedgerProvider,
  LedgerStreamReader,
  listLedgerStreams,
  restoreLedgerStream,
  unwrapEnvFromKeyManager,
} from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createDb, LocalKeyProvider, masterKeysFromEnv } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

loadRootEnv();
await unwrapEnvFromKeyManager();

const USAGE = `Usage: record-ledger <command>
  list                 The streams the ledger holds, and who each is for
  export <stream> [--output <file>]
                       Write a stream's records, decrypted, as JSON lines
  restore <stream> [--into-bot <id>] [--skip-unreadable] [--dry-run] [--json]
                       Bring the database up to what the ledger holds for the stream.
                       Run it with the API and worker stopped.

Reading the ledger needs only RECORD_LEDGER_* and the master keys that sealed it
(ENCRYPTION_MASTER_KEYS or ENCRYPTION_KEY, or the key manager); restore also needs DATABASE_URL.`;

function parseCommand() {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        output: { type: "string" },
        "into-bot": { type: "string" },
        "skip-unreadable": { type: "boolean" },
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
      },
    });
    const [command, stream, ...rest] = positionals;
    const restoring = command === "restore";
    if (
      !command ||
      rest.length ||
      (command === "list" ? stream !== undefined : !["export", "restore"].includes(command)) ||
      (command !== "list" && !stream) ||
      (command !== "export" && values.output !== undefined) ||
      (!restoring &&
        (values["into-bot"] !== undefined ||
          values["skip-unreadable"] ||
          values["dry-run"] ||
          values.json)) ||
      values.output === "" ||
      values["into-bot"] === ""
    )
      return undefined;
    return { command, stream, values };
  } catch {
    return undefined;
  }
}

const parsed = parseCommand();
if (!parsed) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}
const { command, stream, values: flags } = parsed;

const provider = createRecordLedgerProvider();
if (!provider) {
  process.stderr.write(
    "record-ledger: set RECORD_LEDGER_PROVIDER, RECORD_LEDGER_URL and RECORD_LEDGER_TOKEN\n",
  );
  process.exit(2);
}
// The key manager when one is configured, else the local master keys: both open what sealed it.
const keyProvider = contentKeyProviderFromEnv() ?? new LocalKeyProvider(masterKeysFromEnv());
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const write = (line: string) => process.stdout.write(`${line}\n`);

async function list() {
  let streams = 0;
  for await (const info of listLedgerStreams(provider!, keyProvider, controller.signal)) {
    streams += 1;
    const entries = `${info.head?.seq ?? 0} entries`;
    if (info.header) {
      const { header } = info;
      const who = header.botName
        ? `bot "${header.botName}" in Space "${header.spaceName}"`
        : `Space "${header.spaceName}" (shared)`;
      write(`${info.stream}  ${entries}  ${who}`);
    } else {
      const why = info.unreadable
        ? "the ledger cannot read it back"
        : (info.problems[0]?.message ?? "no header");
      write(`${info.stream}  ${entries}  not opened: ${why}`);
    }
  }
  if (!streams) write("The ledger holds no streams.");
}

function exportLine(entry: ReadEntry): Record<string, unknown> {
  const line = { seq: entry.seq, kind: entry.kind, at: entry.occurredAt.toISOString() };
  const { decoded, problem } = entry;
  if (problem) return { ...line, problem: { code: problem.code, message: problem.message } };
  switch (decoded?.kind) {
    case "space.key": {
      const { id, spaceId, version, masterKeyId } = decoded.envelope;
      return { ...line, key: { id, spaceId, version, masterKeyId } };
    }
    case "stream.opened":
      return { ...line, record: decoded.header };
    case "memory.revision":
    case "audit.event":
    case "omitted":
      return { ...line, record: decoded.record };
    default:
      return { ...line, unknown: true };
  }
}

/** JSON lines to stdout, or to a new owner-only file; the export holds plaintext. */
async function exportRecords(streamId: string) {
  const reader = new LedgerStreamReader(provider!, keyProvider, streamId, controller.signal);
  let records = 0;
  async function* lines() {
    for await (const entry of reader.entries()) {
      records += 1;
      yield `${JSON.stringify(exportLine(entry))}\n`;
    }
  }
  if (flags.output) {
    await pipeline(
      Readable.from(lines()),
      createWriteStream(flags.output, { flags: "wx", mode: 0o600 }),
    );
    write(`export: ${records} entries written to ${flags.output}`);
  } else {
    await pipeline(Readable.from(lines()), process.stdout, { end: false });
    process.stderr.write(`export: ${records} entries\n`);
  }
  for (const problem of reader.problems) {
    process.stderr.write(`entry ${problem.seq}: ${problem.message}\n`);
  }
  if (reader.problems.length) process.exitCode = 1;
}

function printReport(report: RestoreReport, dryRun: boolean) {
  const would = dryRun ? "would be " : "";
  write(
    `${report.subject ?? "unopened stream"} (stream ${report.stream}): ${report.entries} entries, ledger holds ${report.head?.seq ?? 0}`,
  );
  const { memory, audit } = report;
  write(
    `  memory: ${memory.added} ${would}added, ${memory.existing} already there, ${memory.omitted} left out by the ledger (too large), ${memory.conflicts.length} conflicts`,
  );
  for (const conflict of memory.conflicts) {
    write(`    kept the database's own revision ${conflict.revision} of ${conflict.path}`);
  }
  write(
    `  audit: ${audit.added} ${would}added, ${audit.existing} already there, ${audit.foreign} for another organization`,
  );
  if (report.misplaced)
    write(`  ${report.misplaced} records named another Space or bot and were left out`);
  if (!dryRun) {
    write(
      report.linked
        ? `  sealing continues after entry ${report.head?.seq}`
        : "  the stream was not re-linked to the ledger",
    );
  }
  for (const problem of report.problems) write(`  entry ${problem.seq}: ${problem.message}`);
  for (const warning of report.warnings) write(`  ${warning}`);
  if (report.skipped) write(`  ${report.skipped}`);
}

async function restore(streamId: string) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const { prisma, pool } = createDb(process.env.DATABASE_URL, {
    applicationName: "rakazo-record-ledger",
    keyProvider: contentKeyProviderFromEnv(),
  });
  try {
    const dryRun = flags["dry-run"] === true;
    const report = await restoreLedgerStream({
      prisma,
      provider: provider!,
      keyProvider,
      stream: streamId,
      signal: controller.signal,
      intoBot: flags["into-bot"],
      skipUnreadable: flags["skip-unreadable"],
      dryRun,
    });
    if (flags.json) write(JSON.stringify(report, null, 2));
    else printReport(report, dryRun);
    if (report.skipped || report.problems.length || report.memory.conflicts.length) {
      process.exitCode = 1;
    }
  } finally {
    await bestEffort("disconnect database client", prisma.$disconnect());
    await bestEffort("close database pool", pool.end());
  }
}

try {
  if (command === "list") await list();
  else if (command === "export") await exportRecords(stream!);
  else await restore(stream!);
} catch (error) {
  process.stderr.write(
    `record-ledger ${command} failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}

import { createWriteStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import type { LedgerKeys, ReadEntry, RestoreReport } from "@rakazo/adapters";
import {
  assertRecipient,
  contentKeyProviderFromEnv,
  createRecordLedgerProvider,
  generateOwnerIdentity,
  LedgerStreamReader,
  listLedgerStreams,
  parseIdentityFile,
  restoreLedgerStream,
  unwrapEnvFromKeyManager,
} from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import {
  createDb,
  createRowId,
  LocalKeyProvider,
  masterKeysFromEnv,
  runAsSystem,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

loadRootEnv();
await unwrapEnvFromKeyManager();

const USAGE = `Usage: record-ledger <command>
  list [--identity-file <file>]
                       The streams the ledger holds, and who each is for
  export <stream> [--output <file>] [--identity-file <file>]
                       Write a stream's records, decrypted, as JSON lines
  restore <stream> [--into-bot <id>] [--skip-unreadable] [--dry-run] [--json]
          [--identity-file <file>]
                       Bring the database up to what the ledger holds for the stream.
                       Run it with the API and worker stopped.
  keygen --output <file>
                       Make an owner key: the file holds the private identity, and the
                       public key it prints is what a Space is sealed to
  recipient add <age1…> --space <id> [--label <text>]
  recipient list --space <id>
  recipient remove <age1…> --space <id>
                       The owner keys a Space's ledger is sealed to

Reading the ledger needs RECORD_LEDGER_* and a key that opens it: the master keys that sealed it
(ENCRYPTION_MASTER_KEYS or ENCRYPTION_KEY, or the key manager), or an owner's --identity-file for
a ledger sealed to its owner. restore and recipient also need DATABASE_URL.`;

const FLAGS = {
  output: { type: "string" },
  "identity-file": { type: "string" },
  "into-bot": { type: "string" },
  space: { type: "string" },
  label: { type: "string" },
  "skip-unreadable": { type: "boolean" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
} as const;

/** For each command: how many arguments it takes, the flags it allows, and those it requires. */
const COMMANDS: Record<string, { args: number; flags: string[]; required?: string[] }> = {
  list: { args: 0, flags: ["identity-file"] },
  export: { args: 1, flags: ["output", "identity-file"] },
  restore: {
    args: 1,
    flags: ["into-bot", "skip-unreadable", "dry-run", "json", "identity-file"],
  },
  keygen: { args: 0, flags: ["output"], required: ["output"] },
  "recipient add": { args: 1, flags: ["space", "label"], required: ["space"] },
  "recipient list": { args: 0, flags: ["space"], required: ["space"] },
  "recipient remove": { args: 1, flags: ["space"], required: ["space"] },
};

function parseCommand() {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: FLAGS,
    });
    const [first, ...rest] = positionals;
    const command = first === "recipient" ? `recipient ${rest.shift()}` : first;
    const spec = command ? COMMANDS[command] : undefined;
    const given = Object.entries(values).filter(([, value]) => value !== undefined);
    if (
      !command ||
      !spec ||
      rest.length !== spec.args ||
      given.some(([name, value]) => !spec.flags.includes(name) || value === "") ||
      (spec.required ?? []).some((name) => !values[name as keyof typeof values])
    )
      return undefined;
    return { command, args: rest, values };
  } catch {
    return undefined;
  }
}

const parsed = parseCommand();
if (!parsed) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}
const { command, args, values: flags } = parsed;
const write = (line: string) => process.stdout.write(`${line}\n`);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

/** The identities in `--identity-file`; a file others can read is used, with a warning. */
function identitiesFromFile(): string[] {
  const file = flags["identity-file"];
  if (!file) return [];
  if (statSync(file).mode & 0o077) {
    process.stderr.write(`warning: ${file} can be read by other users; it holds a private key\n`);
  }
  return parseIdentityFile(readFileSync(file, "utf8"));
}

/**
 * What opens a ledger here: the key manager or local master keys when any are configured, and
 * the owner's identities when a file is given. An owner restoring without the host's master keys
 * needs only the identity.
 */
function ledgerKeys(): LedgerKeys {
  const identities = identitiesFromFile();
  const hasMasterKeys = Boolean(
    process.env.ENCRYPTION_MASTER_KEYS?.trim() || process.env.ENCRYPTION_KEY?.trim(),
  );
  const keyProvider =
    contentKeyProviderFromEnv() ??
    (hasMasterKeys || !identities.length ? new LocalKeyProvider(masterKeysFromEnv()) : undefined);
  return { keyProvider, identities };
}

function provider() {
  const ledger = createRecordLedgerProvider();
  if (!ledger) {
    process.stderr.write(
      "record-ledger: set RECORD_LEDGER_PROVIDER, RECORD_LEDGER_URL and RECORD_LEDGER_TOKEN\n",
    );
    process.exit(2);
  }
  return ledger;
}

async function list() {
  let streams = 0;
  for await (const info of listLedgerStreams(provider(), ledgerKeys(), controller.signal)) {
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
    case "key.recipients":
      return { ...line, key: { id: decoded.envelope.keyId, sealedToOwner: true } };
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
  const reader = new LedgerStreamReader(provider(), ledgerKeys(), streamId, controller.signal);
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

/** The database, closed afterwards; `work` runs as the system, as every ledger step does. */
async function withDatabase<T>(
  reason: string,
  work: (db: ReturnType<typeof createDb>) => Promise<T>,
): Promise<T> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const db = createDb(process.env.DATABASE_URL, {
    applicationName: "rakazo-record-ledger",
    keyProvider: contentKeyProviderFromEnv(),
  });
  try {
    return await runAsSystem(reason, () => work(db));
  } finally {
    await bestEffort("disconnect database client", db.prisma.$disconnect());
    await bestEffort("close database pool", db.pool.end());
  }
}

async function restore(streamId: string) {
  const ledger = provider();
  const keys = ledgerKeys();
  await withDatabase("restore the record ledger", async ({ prisma, contentKeys }) => {
    const dryRun = flags["dry-run"] === true;
    const report = await restoreLedgerStream({
      prisma,
      provider: ledger,
      // A key the database holds opens a stream sealed to its owner without asking the owner.
      keys: { ...keys, known: (id) => contentKeys.find(id) },
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
  });
}

/** A new owner key: the private identity to a new owner-only file, the public key to the screen. */
async function keygen() {
  const { identity, recipient } = await generateOwnerIdentity();
  writeFileSync(
    flags.output!,
    `# created: ${new Date().toISOString()}\n# public key: ${recipient}\n${identity}\n`,
    { flag: "wx", mode: 0o600 },
  );
  write(
    `Identity written to ${flags.output}. Keep it: it is the only way to open what is sealed to it.`,
  );
  write(`Public key: ${recipient}`);
}

async function recipient() {
  const spaceId = flags.space!;
  await withDatabase("manage record ledger owner keys", async ({ prisma }) => {
    if (!(await prisma.space.findUnique({ where: { id: spaceId }, select: { id: true } }))) {
      throw new Error("No such Space");
    }
    if (command === "recipient list") {
      const rows = await prisma.recordLedgerRecipient.findMany({
        where: { spaceId },
        orderBy: { createdAt: "asc" },
      });
      for (const row of rows) {
        write(
          `${row.recipient}  ${row.label ?? ""}  added ${row.createdAt.toISOString()}`.trimEnd(),
        );
      }
      if (!rows.length) write("No owner keys: the ledger is sealed under the master key.");
      return;
    }
    const [key] = args;
    if (command === "recipient add") {
      await assertRecipient(key!);
      const { count } = await prisma.recordLedgerRecipient.createMany({
        data: [{ id: createRowId(), spaceId, recipient: key!, label: flags.label ?? null }],
        skipDuplicates: true,
      });
      write(
        count
          ? "Added. Streams announce their keys to it on the next pass, history included."
          : "That key is already set.",
      );
      return;
    }
    const { count } = await prisma.recordLedgerRecipient.deleteMany({
      where: { spaceId, recipient: key! },
    });
    write(
      count
        ? "Removed. It is given no more keys, but keeps any it already opened: rotate the Space key to cut it off from new entries."
        : "That key was not set.",
    );
  });
}

try {
  if (command === "list") await list();
  else if (command === "export") await exportRecords(args[0]!);
  else if (command === "restore") await restore(args[0]!);
  else if (command === "keygen") await keygen();
  else await recipient();
} catch (error) {
  process.stderr.write(
    `record-ledger ${command} failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}

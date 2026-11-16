# Record ledger

Keep a second copy of what each bot remembered and did, outside this deployment, in a store that
makes rewriting it detectable. If the deployment is lost, the ledger and your master keys are
enough to get a bot's memory back. It is off until you configure a ledger.

The copy is sealed before it leaves: the ledger holds ciphertext it cannot read.

## What is recorded

Each bot has a stream, and each [Space](./spaces.md) has one for what no single bot owns.

| Record            | Stream                                          | Holds                                                    |
| ----------------- | ----------------------------------------------- | -------------------------------------------------------- |
| `memory.revision` | The bot's, or the Space's for shared memory     | Every saved version of a [memory](./memory.md) document  |
| `audit.event`     | The bot's for its own actions, else the Space's | The Space's [audit log](./self-host-audit-log.md) events |

Audit events carry what the audit log carries: who did what, to what, with which outcome. They
never include message content, tool arguments or secret values. Events with no Space (sign-ins,
account security) are not recorded, and neither is another organization's copy of an event.

Turning the ledger on records what already exists, oldest first, then keeps up. On a deployment
with a long history that is a large first send, so size the ledger for it. A new row reaches the
ledger within about a minute and a half of being written: sealing and shipping run on the
reconciler's pass, not inside the write that produced the row.

## Configure

```env
RECORD_LEDGER_PROVIDER=agentvault
RECORD_LEDGER_URL=https://ledger.example.test
RECORD_LEDGER_TOKEN=<the gateway's token>
```

Set these on the API and the worker. The URL must be `https`, or `http` on the same machine, so
the token never crosses a network in the clear. A provider named without a URL and token stops
startup.

`agentvault` is an [AgentVault](https://github.com/johnnyclem/agentvault) ledger gateway, which
chains each stream's entries and anchors them on an Internet Computer canister. Run it with
`agentvault ledger serve`, using the same token; its guide covers the canister, the anchor
interval and how to verify a stream.

## How it works

- **A stream opens itself.** Its first entries are the Space key, announced to whoever may open
  it, and a sealed header saying whether the stream is for a bot or a Space, and its name as it was
  then. The key is wrapped by a master key, as stored in `space_keys`, or, when the Space has
  [owner keys](#owner-keys), sealed to them instead. A new key is announced the same way when the
  Space's key rotates. That is what lets a stream be read with the ledger and a key that opens it,
  and nothing else.
- **Sealing.** Each record is encrypted with its Space's
  [content key](./content-encryption.md#how-it-works) (AES-256-GCM), whatever `CONTENT_ENCRYPTION`
  says, and bound to its stream and position, so an entry moved or copied elsewhere does not open.
  Only the record's kind, its time and its position in the stream are sent in the clear. Stream
  names are random ids, not bot or Space ids.
- **Order.** Entries are numbered from 1 within a stream. One sealer runs at a time across all
  instances, so a position is never handed out twice, and a row already in a stream is never
  sealed again.
- **Shipping.** Sealed entries stay in Postgres (`record_ledger_entries`) and are sent in
  order. Sends are idempotent: an entry the ledger already holds is accepted again, so a lost
  answer is safe to retry. While the ledger is unreachable, sealing continues and shipping
  catches up when it returns.
- **A ledger that lost entries** is sent them again from where it ends, such as after pointing
  at a new, empty one.
- **A record too large for the ledger** (256 KiB sealed, for the gateway) is recorded without
  its content, with the content's size and SHA-256 instead. One that still does not fit keeps
  its place in the stream as a stub holding only its id, time, size and SHA-256, so a single
  large row never holds up the ones after it. Restoring cannot bring back content a stub left out.

## Restore

`record-ledger` reads a stream back from the ledger and puts a bot's memory into the database. It
needs the ledger and a key that opens the stream: the master keys that sealed it
(`ENCRYPTION_MASTER_KEYS` or `ENCRYPTION_KEY`, or your key manager), or, for a ledger sealed to its
owner, the owner's `--identity-file`. `restore` also needs the database. **Keep the master keys
somewhere that survives losing the server**: without them a ledger sealed under them cannot be
opened, and with them anyone holding the ledger can read it.

```sh
docker compose -f docker-compose.images.yml exec api pnpm --filter @rakazo/api record-ledger list
```

- `list [--identity-file <file>]` shows each stream the ledger holds, the bot or Space it is for,
  and its length. It needs no database. A stream your keys do not open is listed with the reason.
- `export <stream> [--output <file>] [--identity-file <file>]` writes a stream's records, decrypted, as JSON lines: every
  saved version of every memory, and every audit event, with their original times. It needs no
  database. Read it as plaintext: the file is created owner-only, and an existing file is not
  overwritten.
- `restore <stream> [--into-bot <id>] [--skip-unreadable] [--dry-run] [--json]
  [--identity-file <file>]` puts the stream's records back in the database. Run `--dry-run` first.
  Stop the API and worker while it runs, as for any restore. Restoring in place also tries the
  Space keys the database already holds, so a stream sealed to its owner can be restored without
  asking the owner while those keys are still there.

**After losing the deployment.** Set up a new one with the same master keys (or, for a ledger
sealed to its owner, give the owner's identity file instead: no master key is needed), sign in,
create a bot, and run `restore <stream> --into-bot <bot id>`. The old bot's memory comes back in the new bot, with
its history, as new revisions: the new bot's own stream then records them, under its Space's key,
and they carry the time of the restore (the original times stay in the old stream; `export` shows
them). Audit events are not copied, since they are the old organization's record. Accounts, Spaces
and bots are not recreated.

**After restoring Postgres from an older backup.** Restore the backup, then run `restore <stream>`
for each stream `list` shows, before starting the API and worker. Memory and audit events the
backup lacks come back under their own ids, and the database's record of the stream is re-linked to
the ledger, so sealing carries on after the last entry. Shared memory and a Space's audit trail
(`space:` streams) restore only in place. Owner keys are kept in the database too, so a backup older
than they are does not have them: restore warns when a stream is sealed to owner keys the database
lacks, and they should be added again (`recipient add`) before the services start, or the next pass
announces the stream's key under the master key instead.

Restore adds what is missing and never changes what is there. A revision the database holds
differently is kept as it is and reported, with its document left alone, and the command exits
non-zero. A stream with an entry that does not open (altered, moved, or sealed under a key you no
longer have) restores nothing, and says which entry; `--skip-unreadable` restores the rest, but
cannot re-link the stream. Running it again changes nothing.

## Owner keys

By default a Space's ledger is sealed under the deployment's master key, so whoever runs the
deployment, or leaks that key, can read it. A Space can instead be sealed to keys its owner holds,
and the host never sees the private half. The format is [age](https://age-encryption.org), so the
stock `age` tool opens a stream's key without any rakazo code: an owner is not tied to this
software to get their data back.

```sh
record-ledger keygen --output owner.key        # the owner: the file is the private key; keep it
record-ledger recipient add age1… --space <Space id> --label "owner"   # the host: the public key
record-ledger recipient list --space <Space id>
```

From the next pass, each of the Space's streams announces its Space key to the owner keys,
including every earlier key version, so the owner can open the history as well as what comes next.
New streams are sealed to them alone, with nothing a master key could open. Restoring then needs
only the owner's identity (`--identity-file owner.key`): not the host's master key, not the database.

Space owners can do this themselves in the app, without the command line: **Settings → Space →
Backup key**, shown only on a deployment that keeps a ledger. The key is made in the browser, so the
private half never reaches the server, and is offered as a file to save. The Space gets the public
half only once the owner has downloaded or copied it. The same page lists the Space's keys and
removes them; it is the same list as `recipient list`, up to 5 keys per Space.

A new account is also offered a key as the first step of onboarding, before anything is recorded, so
a key made then seals everything the Space records from the start. It can be skipped, and then waits
in Settings.

A Space its owner makes later is sealed to the same keys from its first record, so the one file
opens all of them and nobody is asked again. It starts with a copy of the keys of the Space it was
made from, or, when that one is shared with them, of the oldest Space they own. This holds for a
Space made in the app, by a bot, or by importing an account, and for a new organization's first
Space. The keys are copied as they are, label included, so a recovery key an operator added to the
source Space reaches the new one as well; remove it there with `recipient remove`. A Space whose
source holds no key starts with none, and its owner adds one in Settings, after which what its
streams already recorded stays openable by the master key.

The list of owner keys is the whole policy. One key is self-custody: lose the file and nobody can
open that ledger. Adding a second key the owner trusts, or a recovery key the operator keeps
offline, makes it recoverable. No keys keeps the master-key behaviour above.

What this protects, and what it does not:

- It protects the **ledger copy**: the ledger's operator, anyone reading a public chain it anchors
  to, and anyone who obtains the master key but not the owner's identity cannot read it.
- It does **not** hide anything from the host that runs the agent: the live memory is in the host's
  database, and the host seals what it writes. An owner key makes the backup the owner's; it does
  not make the host blind.
- What was sealed before owner keys were added stays readable with the master key as well: a ledger
  cannot be rewritten. That includes what a stream that began under the master key gets
  afterwards, since it still uses the key it announced then. Only streams that begin after the
  Space has owner keys, such as every stream of a Space whose owner made a key first, are sealed to
  them alone. The app says so when it applies, and `recipient list` does not.
- Removing an owner key stops it being given new keys, but it keeps any it already opened. To cut
  it off from new entries, rotate the Space key to a new version (`content-encryption rotate
  --reencrypt`).
- An owner who holds a Space key can decrypt that Space's database content if they ever get a copy
  of it. Keep identities as you would any private key.

## When a stream stops

A stream stops shipping when the ledger already holds a different entry at one of its positions,
or rejects its entries as malformed. `record.ledger.stopped` is logged with the stream, the
position and the reason. Other streams continue, and the stopped stream keeps sealing.

The usual cause is restoring Postgres from a backup older than the ledger and starting services
before restoring the ledger: the ledger then holds entries the database no longer has, and new
activity takes the same positions. Restore the stream as above: it brings back what the ledger
holds. If the database sealed entries of its own in the meantime they differ from the ledger's, so
the stream is not re-linked, and a warning says from which entry.

To retry a stream after resolving the cause:

```sql
UPDATE record_ledger_streams SET "stoppedAt" = NULL WHERE id = '<stream id>';
```

## Privacy and deleting

A ledger is append-only, so nothing sent to it is removed. The ledger, and anyone who can read it,
holds ciphertext and your Space keys, wrapped. **A key that opens a wrapped Space key opens the
stream**: for a ledger sealed under the master key, that is the master key, so choose a random one
(`openssl rand -hex 32` in `ENCRYPTION_MASTER_KEYS`), not a passphrase, and treat it as the key to
the history; for one sealed to [owner keys](#owner-keys), it is the owner's identity. Where a ledger
publishes what it holds (a canister anchored with its entries is readable by anyone, permanently),
a key that later leaks opens that history for good.

- Deleting a Space destroys its key in Postgres, but **not** in the ledger: the stream carries it,
  wrapped. Its entries stay readable to anyone with the master key, or with an owner key it is
  sealed to. Only destroying those keys makes a ledger unreadable.
- Deleting a bot removes its stream and sealed entries from Postgres. Its entries in the ledger
  stay.
- Deleting one memory note, or the audit log's retention pruning, does not reach entries already
  sealed.

Consider this before turning the ledger on where people expect a deleted note to be gone.

## Not yet

Nothing in the apps shows a bot's ledger status, and restoring is an operator command. An owner
makes and removes keys on web and desktop; the mobile app does not, because holding a private key
there needs its own place to keep it, so an account made there is not offered a key at signup. There
is no key derived from a wallet, and adding a key does not rotate the Space key, so a Space that
already has streams stays readable by the master key. Restore trusts the ledger to return everything it was sent; a ledger that drops its newest entries
is noticed only when the database survives to compare (it warns), or by verifying the anchor.

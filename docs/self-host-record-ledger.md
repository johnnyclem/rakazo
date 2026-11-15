# Record ledger

Keep a second copy of what each bot remembered and did, outside this deployment, in a store that
makes rewriting it detectable. It is off until you configure a ledger.

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

- **Sealing.** Each record is encrypted with its Space's
  [content key](./content-encryption.md#how-it-works) (AES-256-GCM), bound to its entry and
  stream, whatever `CONTENT_ENCRYPTION` says. Only the record's kind, its time and its position
  in the stream are sent in the clear. Stream names are random ids, not bot or Space ids.
- **Order.** Entries are numbered from 1 within a stream. One sealer runs at a time across all
  instances, so a position is never handed out twice.
- **Shipping.** Sealed entries stay in Postgres (`record_ledger_entries`) and are sent in
  order. Sends are idempotent: an entry the ledger already holds is accepted again, so a lost
  answer is safe to retry. While the ledger is unreachable, sealing continues and shipping
  catches up when it returns.
- **A ledger that lost entries** is sent them again from where it ends, such as after pointing
  at a new, empty one.
- **A record too large for the ledger** (256 KiB sealed, for the gateway) is recorded without
  its content, with the content's size and SHA-256 instead. One that still does not fit keeps
  its place in the stream as a stub holding only its id, time, size and SHA-256, so a single
  large row never holds up the ones after it.

## When a stream stops

A stream stops shipping when the ledger already holds a different entry at one of its positions,
or rejects its entries as malformed. `record.ledger.stopped` is logged with the stream, the
position and the reason. Other streams continue, and the stopped stream keeps sealing.

The usual cause is restoring Postgres from a backup older than the ledger: the ledger then holds
entries the database no longer has, and new activity takes the same positions. Those entries in
the ledger are the only remaining copy of what the restore lost. Reading them back into the
database is not automated yet.

To retry a stream after resolving the cause:

```sql
UPDATE record_ledger_streams SET "stoppedAt" = NULL WHERE id = '<stream id>';
```

## Deleting

A ledger is append-only, so nothing sent to it is removed.

- Deleting a Space destroys its content key. Its entries in the ledger stay, permanently
  unreadable.
- Deleting a bot removes its stream and sealed entries from Postgres. Its entries in the ledger
  stay readable with the Space's key for as long as the Space exists.
- Deleting one memory note, or the audit log's retention pruning, does not reach entries already
  sealed.

Consider this before turning the ledger on where people expect a deleted note to be gone.

## Not yet

Nothing in the apps shows a bot's ledger status, and a bot cannot be restored from its ledger.
The Space's key stays with the deployment: there is no export to a key the Space's owner holds.

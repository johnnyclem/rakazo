import { z } from "zod";

/**
 * Owner keys: the keys a Space's record ledger is sealed to, in the `age` format. The server
 * keeps only the public half (`age1…`); the private half (`AGE-SECRET-KEY-1…`) stays with its
 * owner, in a file of the format below.
 */

/** Most keys a Space may be sealed to; each one adds a stanza to every announced key. */
export const MAX_OWNER_KEYS = 5;

/** An age public key (X25519): `age1` and 58 characters of the bech32 alphabet. */
export const OWNER_KEY_RECIPIENT_PATTERN = /^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/;

export const OwnerKeyRecipientSchema = z.string().regex(OWNER_KEY_RECIPIENT_PATTERN);

export const RecordLedgerKeySchema = z.object({
  recipient: OwnerKeyRecipientSchema,
  /** Set by an operator adding the key by hand; keys made in the app have none. */
  label: z.string().nullable(),
  createdAt: z.string(),
});
export type RecordLedgerKey = z.infer<typeof RecordLedgerKeySchema>;

export const RecordLedgerKeysSchema = z.object({
  keys: z.array(RecordLedgerKeySchema),
  /**
   * Whether a stream of this Space already announced its key to the deployment's own master key.
   * What was sealed that way stays openable by it, whatever keys are added later.
   */
  earlier: z.boolean(),
});
export type RecordLedgerKeys = z.infer<typeof RecordLedgerKeysSchema>;

/** The name a saved key file is offered under. */
export const OWNER_KEY_FILE_NAME = "rakazo-backup-key.txt";

/**
 * The text of an owner's key file: what `age-keygen` writes, so the stock `age` tool and
 * `record-ledger --identity-file` both read it.
 */
export function ownerKeyFile(key: {
  identity: string;
  recipient: string;
  createdAt: Date;
}): string {
  return `# created: ${key.createdAt.toISOString()}\n# public key: ${key.recipient}\n${key.identity}\n`;
}

/** How far a Space's streams are kept where its owner named. Counted over the first streams only. */
export const RecordLedgerAnchorStatusSchema = z.object({
  /** Streams looked at. */
  streams: z.number().int().min(0),
  /** Of those, how many are not yet fully kept there. */
  behind: z.number().int().min(0),
  /** Why, when the ledger can say: it is not allowed to write there yet, or something failed. */
  error: z.enum(["not_allowed", "failed"]).nullable(),
});

/**
 * Where a Space's backups are kept off-site when its owner holds the place. `label` is null where
 * the ledger cannot offer that; otherwise it is the ledger's own word for such a place.
 */
export const RecordLedgerAnchorSchema = z.object({
  label: z.string().nullable(),
  /** The identity the ledger writes as, which the owner has to allow at their place. */
  writer: z.string().nullable(),
  destination: z.string().nullable(),
  status: RecordLedgerAnchorStatusSchema.nullable(),
});
export type RecordLedgerAnchor = z.infer<typeof RecordLedgerAnchorSchema>;

/** The longest destination accepted; what it is, is for the ledger to say. */
export const MAX_ANCHOR_DESTINATION_LENGTH = 128;
export const RecordLedgerDestinationSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ANCHOR_DESTINATION_LENGTH);

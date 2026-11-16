import { createHash } from "node:crypto";
import type { DataKey } from "@rakazo/db";
import { z } from "zod";

/**
 * Sealing a ledger to keys its owner holds, in the `age` format: the server keeps only public
 * recipients (`age1…`), and the owner's private identity (`AGE-SECRET-KEY-1…`) is what opens a
 * stream. A Space key announced this way can be opened by the stock `age` tool, so the owner is
 * not tied to this code to get their data back.
 *
 * `age-encryption` is loaded on first use, so a deployment that never seals to owners never
 * loads it.
 */
const loadAge = () => import("age-encryption");

/** What an age file wraps: the key, with the id, Space and version it belongs to. */
const wrappedKeySchema = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  version: z.number().int().min(1),
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/** Identifies a set of recipients, so a stream notices when its Space's set changes. */
export function recipientSetDigest(recipients: readonly string[]): string {
  const sorted = [...recipients].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 32);
}

/** Throws unless `recipient` is an age public key. */
export async function assertRecipient(recipient: string): Promise<void> {
  const age = await loadAge();
  try {
    new age.Encrypter().addRecipient(recipient);
  } catch {
    throw new Error("Not an age public key: expected a value that starts with age1");
  }
}

/** A new owner identity and the public recipient that goes with it. */
export async function generateOwnerIdentity(): Promise<{ identity: string; recipient: string }> {
  const age = await loadAge();
  const identity = await age.generateIdentity();
  return { identity, recipient: await age.identityToRecipient(identity) };
}

/**
 * The identities in an age identity file: `AGE-SECRET-KEY-1…` lines, with comments and blank
 * lines ignored. Throws when there is none, or a line that is not one.
 */
export function parseIdentityFile(text: string): string[] {
  const identities = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!identities.length) throw new Error("The identity file holds no age identity");
  if (identities.some((line) => !/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(line))) {
    throw new Error("The identity file holds a line that is not an age identity");
  }
  return identities;
}

/** `key`, wrapped to every recipient as one age file (base64url). Any one recipient opens it. */
export async function wrapKeyToRecipients(
  key: DataKey,
  recipients: readonly string[],
): Promise<string> {
  const age = await loadAge();
  const encrypter = new age.Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient);
  const wrapped = await encrypter.encrypt(
    JSON.stringify({
      id: key.id,
      spaceId: key.spaceId,
      version: key.version,
      key: Buffer.from(key.key).toString("base64url"),
    }),
  );
  return Buffer.from(wrapped).toString("base64url");
}

/**
 * The key an age file wraps, opened with one of `identities`; null when none of them opens it or
 * what it wraps is not a key. What the file says about the key is taken from inside it, where it
 * is protected, never from anything around it.
 */
export async function unwrapKeyWithIdentities(
  wrapped: string,
  identities: readonly string[],
): Promise<DataKey | null> {
  if (!identities.length) return null;
  const age = await loadAge();
  const decrypter = new age.Decrypter();
  for (const identity of identities) decrypter.addIdentity(identity);
  let plain: string;
  try {
    plain = await decrypter.decrypt(Buffer.from(wrapped, "base64url"), "text");
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(plain);
  } catch {
    return null;
  }
  const parsed = wrappedKeySchema.safeParse(value);
  if (!parsed.success) return null;
  const { id, spaceId, version, key } = parsed.data;
  return { id, spaceId, version, key: Buffer.from(key, "base64url") };
}

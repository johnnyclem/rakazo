import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";

/** The fixed start of an Ed25519 public key in DER (SubjectPublicKeyInfo), before its 32 bytes. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** The marker that says an address was made from a public key, rather than assigned. */
const SELF_AUTHENTICATING = 0x02;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Whether `ownerKey` is a raw Ed25519 public key in base64url: 32 bytes. */
export function isEd25519PublicKey(ownerKey: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(ownerKey) && Buffer.from(ownerKey, "base64url").length === 32;
}

/**
 * The address a public key holds on the Internet Computer: the key's DER form hashed with
 * SHA-224, marked as self-authenticating, then written with a checksum in lowercase base32 in
 * groups of five. The same key always gives the same address, so the owner's key file and the
 * canister agree on who the owner is without anyone being told.
 */
export function ownerAddress(ownerKey: string): string {
  if (!isEd25519PublicKey(ownerKey)) throw new Error("The owner key is not an Ed25519 public key");
  const publicKey = Buffer.from(ownerKey, "base64url");
  const hash = createHash("sha224")
    .update(Buffer.concat([ED25519_SPKI_PREFIX, publicKey]))
    .digest();
  const bytes = Buffer.concat([hash, Buffer.from([SELF_AUTHENTICATING])]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(bytes));
  return (
    base32(Buffer.concat([checksum, bytes]))
      .match(/.{1,5}/g)
      ?.join("-") ?? ""
  );
}

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

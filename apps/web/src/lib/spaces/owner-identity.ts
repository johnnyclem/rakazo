import { OWNER_IDENTITY_FILE_NAME } from "@rakazo/contracts";
import { downloadArtifactBytes } from "../pages/artifact-open";

/** An owner's key as made here: the public half the server is given, and the file its owner keeps. */
export interface OwnerIdentityDraft {
  /** The Ed25519 public key, 32 raw bytes in base64url. */
  ownerKey: string;
  /** The private half as a PKCS#8 PEM, which stock tools read as an Ed25519 key. */
  file: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Makes an Ed25519 key on this device. The private half is only in `file`, which goes nowhere
 * until its owner saves it; the server is given `ownerKey` alone. A browser without Ed25519 in
 * WebCrypto rejects, which the caller shows.
 */
export async function createOwnerIdentity(): Promise<OwnerIdentityDraft> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", pair.privateKey),
    crypto.subtle.exportKey("raw", pair.publicKey),
  ]);
  const body =
    toBase64(new Uint8Array(privateKey))
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return {
    ownerKey: toBase64(new Uint8Array(publicKey))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", ""),
    file: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
  };
}

export function downloadOwnerIdentity(draft: OwnerIdentityDraft): void {
  downloadArtifactBytes(
    OWNER_IDENTITY_FILE_NAME,
    "application/x-pem-file",
    new TextEncoder().encode(draft.file),
  );
}

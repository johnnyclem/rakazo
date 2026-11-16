import { OWNER_KEY_FILE_NAME, ownerKeyFile } from "@rakazo/contracts";
import { downloadArtifactBytes } from "./artifact-open";

/** A backup key as made here: the public half the server is given, and the file its owner keeps. */
export interface OwnerKeyDraft {
  recipient: string;
  file: string;
}

/**
 * Makes a new key pair on this device. The private half is only in `file`, which goes nowhere
 * until its owner saves it; the server is given `recipient` alone. The `age` library loads here,
 * the first time a key is made, so it is not part of the app for anyone who never makes one.
 */
export async function createOwnerKey(): Promise<OwnerKeyDraft> {
  const age = await import("age-encryption");
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  return { recipient, file: ownerKeyFile({ identity, recipient, createdAt: new Date() }) };
}

export function downloadOwnerKey(draft: OwnerKeyDraft): void {
  downloadArtifactBytes(OWNER_KEY_FILE_NAME, "text/plain", new TextEncoder().encode(draft.file));
}

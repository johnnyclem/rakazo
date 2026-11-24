// @vitest-environment jsdom

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { OWNER_IDENTITY_FILE_NAME, OwnerIdentityPublicKeySchema } from "@rakazo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createOwnerIdentity, downloadOwnerIdentity } from "./owner-identity";

afterEach(() => vi.restoreAllMocks());

it("makes a key whose public half is what the server is given, and whose file is the private half", async () => {
  const draft = await createOwnerIdentity();

  expect(OwnerIdentityPublicKeySchema.safeParse(draft.ownerKey).success).toBe(true);
  expect(draft.file.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
  expect(draft.file.endsWith("\n-----END PRIVATE KEY-----\n")).toBe(true);
  // Stock tools read it as the Ed25519 key it is, and it is the key the server was given.
  const privateKey = createPrivateKey(draft.file);
  expect(privateKey.asymmetricKeyType).toBe("ed25519");
  const publicKey = createPublicKey(privateKey);
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  expect(Buffer.from(raw).toString("base64url")).toBe(draft.ownerKey);
  const signature = sign(null, Buffer.from("owner"), privateKey);
  expect(verify(null, Buffer.from("owner"), publicKey, signature)).toBe(true);
});

it("keeps the private half out of everything the server is given", async () => {
  const draft = await createOwnerIdentity();
  const secret = createPrivateKey(draft.file)
    .export({ format: "der", type: "pkcs8" })
    .subarray(-32);

  expect(draft.ownerKey).not.toContain(Buffer.from(secret).toString("base64url"));
  expect(draft.ownerKey).toHaveLength(43);
});

it("makes a different key each time", async () => {
  const [first, second] = [await createOwnerIdentity(), await createOwnerIdentity()];

  expect(first.ownerKey).not.toBe(second.ownerKey);
  expect(first.file).not.toBe(second.file);
});

it("offers the file under its name, as text a tool can read", async () => {
  const draft = await createOwnerIdentity();
  const anchor = { href: "", download: "", click: vi.fn() };
  vi.spyOn(document, "createElement").mockReturnValue(anchor as never);
  const blobs: Blob[] = [];
  vi.stubGlobal("URL", {
    createObjectURL: (blob: Blob) => {
      blobs.push(blob);
      return "blob:owner";
    },
    revokeObjectURL: vi.fn(),
  });

  downloadOwnerIdentity(draft);

  expect(anchor.download).toBe(OWNER_IDENTITY_FILE_NAME);
  expect(anchor.click).toHaveBeenCalledTimes(1);
  expect(await blobs[0]!.text()).toBe(draft.file);
});

// @vitest-environment jsdom

import { OWNER_KEY_FILE_NAME, OWNER_KEY_RECIPIENT_PATTERN } from "@rakazo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createOwnerKey, downloadOwnerKey } from "./owner-key";

afterEach(() => vi.restoreAllMocks());

it("makes a key whose file opens what is sealed to its public half", async () => {
  const draft = await createOwnerKey();
  expect(draft.recipient).toMatch(OWNER_KEY_RECIPIENT_PATTERN);
  // `age-keygen`'s layout, which the stock tool and the operator's `--identity-file` both read.
  const [created, publicKey, identity, ...rest] = draft.file.split("\n");
  expect(created).toMatch(/^# created: \d{4}-\d\d-\d\dT[\d:.]+Z$/);
  expect(publicKey).toBe(`# public key: ${draft.recipient}`);
  expect(identity).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]+$/);
  expect(rest).toEqual([""]);

  const age = await import("age-encryption");
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(draft.recipient);
  const sealed = await encrypter.encrypt("backup key");
  const decrypter = new age.Decrypter();
  decrypter.addIdentity(identity!);
  const opened = await decrypter.decrypt(sealed, "text");
  expect(opened).toBe("backup key");
});

it("makes a different key each time, and the file is the only place the private half is", async () => {
  const [first, second] = [await createOwnerKey(), await createOwnerKey()];
  expect(first.recipient).not.toBe(second.recipient);
  expect(Object.keys(first).sort()).toEqual(["file", "recipient"]);
  expect(first.recipient).not.toContain("SECRET");
});

it("offers the file for download under its own name", async () => {
  const draft = { recipient: "age1x", file: "# created\nAGE-SECRET-KEY-1TEST\n" };
  let blob: Blob | undefined;
  URL.createObjectURL = vi.fn((made: Blob) => {
    blob = made;
    return "blob:key";
  });
  URL.revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  vi.useFakeTimers();
  try {
    downloadOwnerKey(draft);
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.contexts[0]).toMatchObject({
      download: OWNER_KEY_FILE_NAME,
      href: "blob:key",
    });
    expect(await blob!.text()).toBe(draft.file);
  } finally {
    vi.useRealTimers();
  }
});

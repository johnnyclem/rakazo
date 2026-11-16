import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DataKey } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import {
  assertRecipient,
  generateOwnerIdentity,
  parseIdentityFile,
  recipientSetDigest,
  unwrapKeyWithIdentities,
  wrapKeyToRecipients,
} from "./record-ledger-owner-keys.js";

const key = (): DataKey => ({
  id: "key-1",
  spaceId: "space-1",
  version: 2,
  key: randomBytes(32),
});

describe("owner keys", () => {
  it("generates an identity and the recipient that goes with it", async () => {
    const { identity, recipient } = await generateOwnerIdentity();
    expect(identity).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]+$/);
    expect(recipient).toMatch(/^age1[a-z0-9]+$/);
    expect(await generateOwnerIdentity()).not.toEqual({ identity, recipient });
  });

  it("accepts a public key and refuses anything else", async () => {
    const { recipient, identity } = await generateOwnerIdentity();
    await expect(assertRecipient(recipient)).resolves.toBeUndefined();
    for (const bad of ["", "age1notakey", identity, "ssh-ed25519 AAAA", recipient.slice(0, -2)]) {
      await expect(assertRecipient(bad), bad).rejects.toThrow(/Not an age public key/);
    }
  });

  it("wraps a key to a recipient, and only their identity opens it", async () => {
    const owner = await generateOwnerIdentity();
    const stranger = await generateOwnerIdentity();
    const wrapped = await wrapKeyToRecipients(key(), [owner.recipient]);
    expect(wrapped).toMatch(/^[A-Za-z0-9_-]+$/);

    const opened = await unwrapKeyWithIdentities(wrapped, [owner.identity]);
    expect(opened).toMatchObject({ id: "key-1", spaceId: "space-1", version: 2 });
    expect(await unwrapKeyWithIdentities(wrapped, [stranger.identity])).toBeNull();
    expect(await unwrapKeyWithIdentities(wrapped, [])).toBeNull();
    // Any identity in the list will do.
    expect(
      await unwrapKeyWithIdentities(wrapped, [stranger.identity, owner.identity]),
    ).not.toBeNull();
  });

  it("returns exactly the key that was wrapped", async () => {
    const owner = await generateOwnerIdentity();
    const original = key();
    const opened = await unwrapKeyWithIdentities(
      await wrapKeyToRecipients(original, [owner.recipient]),
      [owner.identity],
    );
    expect(Buffer.from(opened!.key).equals(Buffer.from(original.key))).toBe(true);
  });

  it("lets each of several recipients open it", async () => {
    const [first, second] = [await generateOwnerIdentity(), await generateOwnerIdentity()];
    const wrapped = await wrapKeyToRecipients(key(), [first.recipient, second.recipient]);
    expect(await unwrapKeyWithIdentities(wrapped, [first.identity])).not.toBeNull();
    expect(await unwrapKeyWithIdentities(wrapped, [second.identity])).not.toBeNull();
  });

  it("does not open something that is not a wrapped key, or a wrapped key that is damaged", async () => {
    const owner = await generateOwnerIdentity();
    const wrapped = Buffer.from(await wrapKeyToRecipients(key(), [owner.recipient]), "base64url");
    wrapped[wrapped.length - 5] = wrapped[wrapped.length - 5]! ^ 0x01;
    expect(
      await unwrapKeyWithIdentities(wrapped.toString("base64url"), [owner.identity]),
    ).toBeNull();
    expect(await unwrapKeyWithIdentities("not-an-age-file", [owner.identity])).toBeNull();
  });

  it("identifies a set of recipients the same however it is ordered", () => {
    expect(recipientSetDigest(["age1b", "age1a"])).toBe(recipientSetDigest(["age1a", "age1b"]));
    expect(recipientSetDigest(["age1a"])).not.toBe(recipientSetDigest(["age1a", "age1b"]));
    expect(recipientSetDigest(["age1a"])).toMatch(/^[0-9a-f]{32}$/);
  });

  it("reads the identities in an identity file, ignoring comments", async () => {
    const [first, second] = [await generateOwnerIdentity(), await generateOwnerIdentity()];
    const text = `# created: today\n# public key: ${first.recipient}\n${first.identity}\n\n${second.identity}\r\n`;
    expect(parseIdentityFile(text)).toEqual([first.identity, second.identity]);
    expect(() => parseIdentityFile("# only a comment\n")).toThrow(/holds no age identity/);
    expect(() => parseIdentityFile(`${first.identity}\nnot a key\n`)).toThrow(
      /not an age identity/,
    );
    expect(() => parseIdentityFile(first.recipient)).toThrow(/not an age identity/);
  });
});

// The point of using the age format: the stock tool opens a wrapped key, so an owner is not tied to
// this code to get their data back. Skipped where the tool is not installed.
const ageTool = spawnSync("age", ["--version"]).status === 0;

describe.skipIf(!ageTool)("owner keys and the stock age tool", () => {
  it("opens a wrapped key with `age -d`", async () => {
    const owner = await generateOwnerIdentity();
    const original = key();
    const wrapped = await wrapKeyToRecipients(original, [owner.recipient]);
    const directory = mkdtempSync(path.join(tmpdir(), "owner-keys-"));
    try {
      writeFileSync(path.join(directory, "identity.txt"), `${owner.identity}\n`, { mode: 0o600 });
      writeFileSync(path.join(directory, "wrapped.age"), Buffer.from(wrapped, "base64url"));
      const opened = spawnSync("age", ["-d", "-i", "identity.txt", "wrapped.age"], {
        cwd: directory,
      });
      expect(opened.status).toBe(0);
      expect(JSON.parse(opened.stdout.toString())).toEqual({
        id: "key-1",
        spaceId: "space-1",
        version: 2,
        key: Buffer.from(original.key).toString("base64url"),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

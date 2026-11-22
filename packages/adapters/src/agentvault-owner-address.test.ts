import { describe, expect, it } from "vitest";
import { isEd25519PublicKey, ownerAddress } from "./agentvault-owner-address.js";

// Made with the official Internet Computer identity library, from fixed seeds.
const VECTORS = [
  [
    "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw",
    "tek7g-2zmny-nzjwg-ansf7-rkxv6-z32x6-3flbb-ous5d-pygjx-wkhlc-jae",
  ],
  [
    "GX9rI-FshTLGq8g4-s1ep4m-DHaykgM0A5v6iz02jWE",
    "2ltju-loorm-ztq3h-u32q2-h75yh-ptk3i-rix6u-l7wwi-5imci-z2rpz-pqe",
  ],
  [
    "dqFZIESm5PURJlvKc6YE2QsFKdHfYCvjChmpJXZg0fU",
    "2vra2-ziytq-a4u7g-rrm2s-7ewua-e73rq-y6lmx-udixd-r7bkt-ujbhp-nae",
  ],
] as const;

describe("the address a public key holds", () => {
  it.each(VECTORS)("derives the address the official library does for %s", (key, address) => {
    expect(ownerAddress(key)).toBe(address);
  });

  it("is the same every time, and different for another key", () => {
    expect(ownerAddress(VECTORS[0][0])).toBe(ownerAddress(VECTORS[0][0]));
    expect(ownerAddress(VECTORS[0][0])).not.toBe(ownerAddress(VECTORS[1][0]));
  });

  it.each(["", "short", `${"A".repeat(42)}`, `${"A".repeat(44)}`, `${"!".repeat(43)}`])(
    "refuses %j as a public key",
    (key) => {
      expect(isEd25519PublicKey(key)).toBe(false);
      expect(() => ownerAddress(key)).toThrow(/not an Ed25519 public key/);
    },
  );

  it("accepts 32 bytes written as base64url", () => {
    expect(isEd25519PublicKey(VECTORS[2][0])).toBe(true);
  });
});

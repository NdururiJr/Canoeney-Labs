import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { base32Decode, base32Encode, otpauthUrl, stepOf, totpAt } from "./totp";

const RFC_SEED = Buffer.from("12345678901234567890", "ascii");

test("totp matches the RFC 6238 SHA-1 vectors", () => {
  // The RFC lists eight-digit codes; a six-digit code is their last six digits.
  const vectors: [number, string][] = [
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ];
  for (const [seconds, code] of vectors) assert.equal(totpAt(RFC_SEED, stepOf(new Date(seconds * 1000))), code);
});

test("base32 round-trips", () => {
  const b = randomBytes(20);
  const s = base32Encode(b);
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.deepEqual(base32Decode(s), b);
  assert.deepEqual(base32Decode(s.toLowerCase().replace(/(.{4})/g, "$1 ")), b);
});

test("otpauthUrl names the account and the issuer HQ, with the base32 secret", () => {
  const seed = randomBytes(20);
  const u = new URL(otpauthUrl(seed, "owner"));
  assert.equal(u.protocol, "otpauth:");
  assert.equal(u.searchParams.get("secret"), base32Encode(seed));
  assert.equal(u.searchParams.get("issuer"), "HQ");
  assert.equal(u.searchParams.get("digits"), "6");
  assert.equal(u.searchParams.get("period"), "30");
});

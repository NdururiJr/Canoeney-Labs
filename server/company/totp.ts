// Time-based one-time codes (RFC 6238 over RFC 4226): HMAC-SHA-1, 6 digits,
// 30-second steps. Authenticator apps take the seed as base32 or as an
// otpauth:// link (docs/adr/0007-owner-login-and-dashboard.md).
import { createHmac } from "node:crypto";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const ISSUER = "HQ";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(b: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Accepts lower case, spaces and padding, as people type a key from a screen. */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function stepOf(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

export function totpAt(seed: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", seed).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(n).padStart(TOTP_DIGITS, "0");
}

export function otpauthUrl(seed: Buffer, account: string): string {
  const q = new URLSearchParams({ secret: base32Encode(seed), issuer: ISSUER, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${encodeURIComponent(`${ISSUER}:${account}`)}?${q}`;
}

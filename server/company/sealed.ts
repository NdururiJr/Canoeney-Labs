// Values sealed with the owner key: AES-256-GCM, its key in a file next to the
// store, never in it, so a copy of company.db alone opens nothing (M0-C for the
// TOTP seed; M0-E for each agent GitHub App's private key).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const KEY_BYTES = 32;

/** The key in `keyFile`, created 0600 when `create` and missing. Null when missing or damaged. */
export function ownerKey(keyFile: string, create: boolean): Buffer | null {
  if (!existsSync(keyFile)) {
    if (!create) return null;
    try {
      writeFileSync(keyFile, randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  const key = readFileSync(keyFile);
  return key.length === KEY_BYTES ? key : null;
}

/** `v1:<iv>:<tag>:<ciphertext>`, base64url. */
export function seal(keyFile: string, plain: Buffer): string {
  const key = ownerKey(keyFile, true);
  if (!key) throw new Error(`The key file ${keyFile} is damaged. Run reset-owner on the host.`);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return ["v1", iv, c.getAuthTag(), ct].map((x) => (typeof x === "string" ? x : x.toString("base64url"))).join(":");
}

/** The sealed value, or null when the key is missing, another key sealed it, or it was changed. */
export function open(keyFile: string, sealed: string): Buffer | null {
  const key = ownerKey(keyFile, false);
  if (!key) return null;
  const [v, iv, tag, ct] = sealed.split(":");
  if (v !== "v1" || !iv || !tag || !ct) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]);
  } catch {
    return null;
  }
}

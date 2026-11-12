// The humans who log in to the dashboard and their credentials (spec M0.7;
// owner decision SR-C-19, 2026-11-12; docs/adr/0007-owner-login-and-dashboard.md).
//
// - The password and PIN are stored as scrypt hashes with their own salts.
// - The TOTP seed is encrypted with AES-256-GCM. Its key is a file next to the
//   store, never in it, so a copy of company.db alone opens no seed.
// - A TOTP step is used once: the last one is stored and only moves forward.
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Clock } from "./clock";
import type { CompanyDb } from "./db";
import type { AuditSink } from "./slots/types";
import { stepOf, totpAt } from "./totp";
import type { HumanRole } from "./types";

const SCRYPT = { logN: 15, r: 8, p: 1, keyLen: 32, saltLen: 16 } as const;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SEED_BYTES = 20;
const KEY_BYTES = 32;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
const PIN_RULE = /^\d{6,12}$/;

export interface HumanToEnroll {
  id: string;
  displayName: string;
  role: HumanRole;
}

export type LoginResult = { ok: true; humanId: string; role: HumanRole } | { ok: false; reason: "password" | "code" | "replay" | "no-key" };

function scrypt(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(secret.normalize("NFKC"), salt, SCRYPT.keyLen, { N: 2 ** SCRYPT.logN, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT_MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltLen);
  const key = await scrypt(secret, salt);
  return `scrypt$${SCRYPT.logN}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

async function matches(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || parts[1] !== String(SCRYPT.logN) || parts[2] !== String(SCRYPT.r) || parts[3] !== String(SCRYPT.p)) return false;
  const expected = Buffer.from(parts[5], "base64url");
  const key = await scrypt(secret, Buffer.from(parts[4], "base64url"));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Spent on an unknown or disabled account, so its answer takes as long as a real one.
let dummyHash: Promise<string> | null = null;
const dummy = () => (dummyHash ??= hashSecret(randomBytes(16).toString("hex")));

interface Pending {
  human: HumanToEnroll;
  passwordHash: string;
  pinHash: string;
  seed: Buffer;
}

interface CredentialRow {
  human_id: string;
  role: HumanRole;
  disabled_at: string | null;
  password_hash: string;
  pin_hash: string;
  totp_seed_enc: string;
  totp_last_step: number;
}

export class HumanAccounts {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly db: CompanyDb,
    private readonly clock: Clock,
    private readonly audit: AuditSink,
    /** `<company home>/owner.key`: the key that seals TOTP seeds. Never inside the store. */
    private readonly keyFile: string,
  ) {}

  hasOwner(): boolean {
    return !!this.db
      .prepare("SELECT 1 AS x FROM human_credentials c JOIN humans h ON h.id = c.human_id WHERE h.role = 'owner'")
      .get();
  }

  /** Checks the rules, hashes the password and PIN, and holds them until a first code confirms the seed. */
  async startEnrollment(human: HumanToEnroll, password: string, pin: string): Promise<{ seed: Buffer }> {
    if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      throw new Error(`A password needs ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
    }
    if (typeof pin !== "string" || !PIN_RULE.test(pin)) throw new Error("A PIN is 6 to 12 digits.");
    const [passwordHash, pinHash] = await Promise.all([hashSecret(password), hashSecret(pin)]);
    const seed = randomBytes(SEED_BYTES);
    this.pending.set(human.id, { human, passwordHash, pinHash, seed });
    return { seed };
  }

  /** Stores the human and their credentials once a code from the new seed is right. */
  async confirmEnrollment(humanId: string, code: string): Promise<boolean> {
    const p = this.pending.get(humanId);
    if (!p) return false;
    const step = this.matchingStep(p.seed, code, 0);
    if (step === null) return false;
    const sealed = this.seal(p.seed);
    this.db.transaction(() => {
      const at = this.clock.now().toISOString();
      const exists = this.db.prepare("SELECT 1 AS x FROM humans WHERE id = ?").get(humanId);
      if (!exists) {
        this.db
          .prepare("INSERT INTO humans(id, display_name, role, created_at) VALUES (?, ?, ?, ?)")
          .run(humanId, p.human.displayName, p.human.role, at);
      }
      this.db
        .prepare(
          `INSERT INTO human_credentials(human_id, password_hash, pin_hash, totp_seed_enc, totp_last_step, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(humanId, p.passwordHash, p.pinHash, sealed, step, at);
      this.audit.append({ actorKind: "human", actorId: humanId, action: "human.enrolled", target: humanId, data: { role: p.human.role } });
    }, "immediate");
    this.pending.delete(humanId);
    return true;
  }

  async verifyLogin(account: string, password: string, code: string): Promise<LoginResult> {
    const row = typeof account === "string" ? this.row(account) : null;
    if (!row || row.disabled_at !== null) {
      await matches(String(password), await dummy());
      return { ok: false, reason: "password" };
    }
    if (!(await matches(String(password), row.password_hash))) return { ok: false, reason: "password" };
    const seed = this.open(row.totp_seed_enc);
    if (!seed) return { ok: false, reason: "no-key" };
    const step = this.matchingStep(seed, String(code), row.totp_last_step);
    if (step === null) return { ok: false, reason: "code" };
    if (step <= row.totp_last_step) return { ok: false, reason: "replay" };
    // Only one of two logins racing with the same code moves the step.
    const moved = this.db
      .prepare("UPDATE human_credentials SET totp_last_step = ? WHERE human_id = ? AND totp_last_step < ?")
      .run(step, row.human_id, step).changes;
    if (moved !== 1) return { ok: false, reason: "replay" };
    return { ok: true, humanId: row.human_id, role: row.role };
  }

  async verifyPin(humanId: string, pin: string): Promise<boolean> {
    const row = this.row(humanId);
    if (!row || row.disabled_at !== null) {
      await matches(String(pin), await dummy());
      return false;
    }
    return matches(String(pin), row.pin_hash);
  }

  /** Recovery from the host (`reset-owner`): the human enrolls again. */
  reset(humanId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM human_credentials WHERE human_id = ?").run(humanId);
      this.audit.append({ actorKind: "hq", actorId: "host", action: "human.credentials-reset", target: humanId });
    }, "immediate");
    this.pending.delete(humanId);
  }

  private row(humanId: string): CredentialRow | null {
    return (
      this.db
        .prepare(
          `SELECT c.human_id, h.role, h.disabled_at, c.password_hash, c.pin_hash, c.totp_seed_enc, c.totp_last_step
           FROM human_credentials c JOIN humans h ON h.id = c.human_id WHERE c.human_id = ?`,
        )
        .get<CredentialRow>(humanId) ?? null
    );
  }

  /**
   * The step among the previous, current and next whose code matches, or null.
   * A step at or below `lastUsed` is still returned so the caller can tell a
   * replay from a wrong code.
   */
  private matchingStep(seed: Buffer, code: string, lastUsed: number): number | null {
    if (!/^\d{6}$/.test(code)) return null;
    const now = stepOf(this.clock.now());
    let replay: number | null = null;
    for (const step of [now - 1, now, now + 1]) {
      if (!timingSafeEqual(Buffer.from(totpAt(seed, step)), Buffer.from(code))) continue;
      if (step > lastUsed) return step;
      replay = step;
    }
    return replay;
  }

  private key(create: boolean): Buffer | null {
    if (!existsSync(this.keyFile)) {
      if (!create) return null;
      try {
        writeFileSync(this.keyFile, randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    const key = readFileSync(this.keyFile);
    return key.length === KEY_BYTES ? key : null;
  }

  private seal(seed: Buffer): string {
    const key = this.key(true);
    if (!key) throw new Error(`The key file ${this.keyFile} is damaged. Run reset-owner on the host.`);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(seed), c.final()]);
    return ["v1", iv, c.getAuthTag(), ct].map((x) => (typeof x === "string" ? x : x.toString("base64url"))).join(":");
  }

  private open(sealed: string): Buffer | null {
    const key = this.key(false);
    if (!key) return null;
    const [v, iv, tag, ct] = sealed.split(":");
    if (v !== "v1" || !iv || !tag || !ct) return null;
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]);
    } catch {
      return null; // another key: the seed does not open
    }
  }
}

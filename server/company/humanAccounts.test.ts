import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteAuditSink } from "./audit";
import { FakeClock } from "./clock";
import { openCompanyDb, type CompanyDb } from "./db";
import { HumanAccounts, type HumanToEnroll } from "./humanAccounts";
import { base32Encode, stepOf, totpAt } from "./totp";

const NOW = "2026-11-12T09:00:00.000Z";
const PASSWORD = "correct horse battery";
const PIN = "583920";
const OWNER = { id: "owner", displayName: "Jerry", role: "owner" as const };

function fresh(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "hq-accounts-"));
  const db = openCompanyDb(join(dir, "company.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const clock = new FakeClock(NOW);
  const audit = new SqliteAuditSink(db, clock);
  const keyFile = join(dir, "owner.key");
  const accounts = new HumanAccounts(db, clock, audit, keyFile);
  return { dir, db, clock, audit, keyFile, accounts };
}

const codeNow = (seed: Buffer, clock: FakeClock, offset = 0) => totpAt(seed, stepOf(clock.now()) + offset);

async function enroll(a: HumanAccounts, clock: FakeClock, human: HumanToEnroll = OWNER, password = PASSWORD, pin = PIN) {
  const { seed } = await a.startEnrollment(human, password, pin);
  assert.equal(await a.confirmEnrollment(human.id, codeNow(seed, clock)), true);
  // A login needs a later step than the one enrollment used.
  clock.advance(30_000);
  return seed;
}

function everyCell(db: CompanyDb): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  return tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join("\n");
}

test("enrollment needs a valid code, then the owner exists", async (t) => {
  const { accounts, clock, audit } = fresh(t);
  assert.equal(accounts.hasOwner(), false);
  const { seed } = await accounts.startEnrollment(OWNER, PASSWORD, PIN);
  assert.equal(await accounts.confirmEnrollment("owner", "000000" === codeNow(seed, clock) ? "111111" : "000000"), false);
  assert.equal(accounts.hasOwner(), false);
  assert.equal(await accounts.confirmEnrollment("owner", codeNow(seed, clock)), true);
  assert.equal(accounts.hasOwner(), true);
  const row = audit.query({ action: "human.enrolled" })[0];
  assert.equal(row.target, "owner");
  assert.deepEqual(row.data, { role: "owner" });
});

test("SR-C-02 [T-S5.5] the same TOTP code is refused the second time", async (t) => {
  const { accounts, clock } = fresh(t);
  const seed = await enroll(accounts, clock);
  const code = codeNow(seed, clock);
  assert.deepEqual(await accounts.verifyLogin("owner", PASSWORD, code), { ok: true, humanId: "owner", role: "owner" });
  assert.deepEqual(await accounts.verifyLogin("owner", PASSWORD, code), { ok: false, reason: "replay" });
});

test("a code from the previous or next step is accepted, two steps away is refused", async (t) => {
  const { accounts, clock } = fresh(t);
  const seed = await enroll(accounts, clock);
  clock.advance(5 * 30_000);
  assert.deepEqual(await accounts.verifyLogin("owner", PASSWORD, codeNow(seed, clock, -2)), { ok: false, reason: "code" });
  assert.deepEqual(await accounts.verifyLogin("owner", PASSWORD, codeNow(seed, clock, 2)), { ok: false, reason: "code" });
  assert.equal((await accounts.verifyLogin("owner", PASSWORD, codeNow(seed, clock, -1))).ok, true);
  assert.equal((await accounts.verifyLogin("owner", PASSWORD, codeNow(seed, clock, 1))).ok, true);
});

test("a wrong password fails before the code is looked at, and an unknown account fails the same way", async (t) => {
  const { accounts, clock } = fresh(t);
  const seed = await enroll(accounts, clock);
  assert.deepEqual(await accounts.verifyLogin("owner", "wrong password!!", codeNow(seed, clock)), { ok: false, reason: "password" });
  assert.deepEqual(await accounts.verifyLogin("nobody", PASSWORD, codeNow(seed, clock)), { ok: false, reason: "password" });
});

test("a disabled human cannot log in", async (t) => {
  const { accounts, clock, db } = fresh(t);
  const seed = await enroll(accounts, clock);
  db.prepare("UPDATE humans SET disabled_at = ? WHERE id = 'owner'").run(NOW);
  assert.deepEqual(await accounts.verifyLogin("owner", PASSWORD, codeNow(seed, clock)), { ok: false, reason: "password" });
});

test("SR-C-19 [T-X3.7] the store holds no password, PIN or TOTP seed in clear", async (t) => {
  const { accounts, clock, db, keyFile } = fresh(t);
  const seed = await enroll(accounts, clock);
  const key = readFileSync(keyFile);
  const cells = everyCell(db);
  for (const marker of [PASSWORD, PIN, base32Encode(seed), seed.toString("hex"), seed.toString("base64url"), key.toString("hex"), key.toString("base64url")]) {
    assert.ok(!cells.includes(marker), "a credential is stored in clear");
  }
  const row = db.prepare("SELECT password_hash, pin_hash, totp_seed_enc FROM human_credentials").get<Record<string, string>>();
  assert.ok(row?.password_hash.startsWith("scrypt$15$8$1$"));
  assert.ok(row?.pin_hash.startsWith("scrypt$15$8$1$"));
  assert.ok(row?.totp_seed_enc.startsWith("v1:"));
});

test("SR-C-19 [T-X3.7] a copy of the database without the key file opens no seed", async (t) => {
  const { accounts, clock, db, dir, audit } = fresh(t);
  const seed = await enroll(accounts, clock);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const copy = join(dir, "stolen.db");
  copyFileSync(join(dir, "company.db"), copy);
  const stolen = openCompanyDb(copy);
  const other = new HumanAccounts(stolen, clock, audit, join(dir, "attacker.key"));
  const r = await other.verifyLogin("owner", PASSWORD, codeNow(seed, clock));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && (r.reason === "no-key" || r.reason === "code"));
  // With no key file at all, the reason is no-key.
  rmSync(join(dir, "attacker.key"), { force: true });
  const none = new HumanAccounts(stolen, clock, audit, join(dir, "missing.key"));
  assert.deepEqual(await none.verifyLogin("owner", PASSWORD, codeNow(seed, clock)), { ok: false, reason: "no-key" });
  stolen.close();
});

test("the key file is 0600", { skip: process.platform === "win32" }, async (t) => {
  const { accounts, clock, keyFile } = fresh(t);
  await enroll(accounts, clock);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
});

test("password and PIN rules are enforced", async (t) => {
  const { accounts, db } = fresh(t);
  await assert.rejects(accounts.startEnrollment(OWNER, "elevenchars", PIN));
  await assert.rejects(accounts.startEnrollment(OWNER, PASSWORD, "12345"));
  await assert.rejects(accounts.startEnrollment(OWNER, PASSWORD, "12345a"));
  await assert.rejects(accounts.startEnrollment(OWNER, "x".repeat(257), PIN));
  assert.equal(db.prepare("SELECT count(*) AS n FROM human_credentials").get<{ n: number }>()?.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM humans").get<{ n: number }>()?.n, 0);
});

test("verifyPin returns true only for the right PIN", async (t) => {
  const { accounts, clock } = fresh(t);
  await enroll(accounts, clock);
  assert.equal(await accounts.verifyPin("owner", PIN), true);
  assert.equal(await accounts.verifyPin("owner", "583921"), false);
  assert.equal(await accounts.verifyPin("nobody", PIN), false);
});

test("a second owner cannot enroll", async (t) => {
  const { accounts, clock } = fresh(t);
  await enroll(accounts, clock);
  const { seed } = await accounts.startEnrollment({ id: "owner2", displayName: "Other", role: "owner" }, PASSWORD, PIN);
  await assert.rejects(accounts.confirmEnrollment("owner2", codeNow(seed, clock)));
});

test("a supervisor enrolls and logs in with their own role", async (t) => {
  const { accounts, clock } = fresh(t);
  await enroll(accounts, clock);
  const seed = await enroll(accounts, clock, { id: "sup1", displayName: "Sam", role: "supervisor" }, "another long password", "246810");
  assert.deepEqual(await accounts.verifyLogin("sup1", "another long password", codeNow(seed, clock)), { ok: true, humanId: "sup1", role: "supervisor" });
});

test("reset removes the credentials and is audited as the host", async (t) => {
  const { accounts, clock, audit, db } = fresh(t);
  const seed = await enroll(accounts, clock);
  accounts.reset("owner");
  assert.equal(accounts.hasOwner(), false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM human_credentials").get<{ n: number }>()?.n, 0);
  assert.deepEqual(await accounts.verifyLogin("owner", PASSWORD, codeNow(seed, clock)), { ok: false, reason: "password" });
  const row = audit.query({ action: "human.credentials-reset" })[0];
  assert.equal(row.actorKind, "hq");
  assert.equal(row.actorId, "host");
  // The owner enrolls again under the same id.
  await enroll(accounts, clock);
  assert.equal(accounts.hasOwner(), true);
});

test("totp_last_step never goes back", async (t) => {
  const { accounts, clock, db } = fresh(t);
  await enroll(accounts, clock);
  assert.throws(() => db.exec("UPDATE human_credentials SET totp_last_step = 0"));
});

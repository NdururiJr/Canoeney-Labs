import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_SECRET_PATTERN, AgentSecrets, hashSecret } from "./agentSecrets";
import { SqliteAuditSink } from "./audit";
import { FakeClock } from "./clock";
import { openCompanyDb, type CompanyDb } from "./db";

const NOW = "2026-11-12T08:00:00.000Z";

function addAgent(db: CompanyDb, id: string, status = "active"): void {
  db.prepare(
    "INSERT INTO agents(id, name, role_id, department_id, cli, status, created_at) VALUES (?, ?, 'builder', 'delivery', 'claude', ?, ?)",
  ).run(id, id, status, NOW);
}

function setup(db: CompanyDb) {
  const clock = new FakeClock(NOW);
  const audit = new SqliteAuditSink(db, clock);
  return { audit, secrets: new AgentSecrets(db, clock, audit) };
}

function fresh(t: { after(fn: () => void): void }) {
  const db = openCompanyDb(":memory:");
  t.after(() => db.close());
  addAgent(db, "p/ana");
  return { db, ...setup(db) };
}

function everyCell(db: CompanyDb): string[] {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  const cells: string[] = [];
  for (const { name } of tables) {
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>()) {
      for (const v of Object.values(row)) cells.push(String(v));
    }
  }
  return cells;
}

test("SR-B-05 [T-S1.4 T-X3.7] a secret is 256-bit and only its hash is stored", (t) => {
  const { db, secrets } = fresh(t);
  const s = secrets.issue("p/ana");
  assert.match(s, AGENT_SECRET_PATTERN);
  assert.equal(Buffer.from(s.slice(4), "base64url").length, 32);
  const body = s.slice(4);
  for (const cell of everyCell(db)) {
    assert.ok(!cell.includes(s), "clear secret stored");
    assert.ok(!cell.includes(body), "secret body stored");
  }
  assert.equal(db.prepare("SELECT secret_hash FROM agent_secrets").get<{ secret_hash: string }>()?.secret_hash, hashSecret(s));
});

test("SR-B-06 [T-S1.2 T-S1.3] issuing again revokes the previous secret", (t) => {
  const { secrets } = fresh(t);
  const first = secrets.issue("p/ana");
  const second = secrets.issue("p/ana");
  assert.deepEqual(secrets.authenticate(first), { ok: false, reason: "revoked", companyAgentId: "p/ana" });
  assert.deepEqual(secrets.authenticate(second), { ok: true, companyAgentId: "p/ana" });
});

test("SR-B-07 [T-X3.6] a secret survives closing and reopening the store", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hq secrets "));
  const file = join(dir, "company.db");
  const db1 = openCompanyDb(file);
  addAgent(db1, "p/ana");
  const s = setup(db1).secrets.issue("p/ana");
  db1.close();
  const db2 = openCompanyDb(file);
  t.after(() => {
    db2.close(); // before removing the folder: Windows keeps an open file's folder
    rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(setup(db2).secrets.authenticate(s), { ok: true, companyAgentId: "p/ana" });
});

test("SR-B-08 [T-S1.3 T-X2.13] revoke on pause stops the secret at once", (t) => {
  const { secrets } = fresh(t);
  const s = secrets.issue("p/ana");
  assert.equal(secrets.hasLive("p/ana"), true);
  assert.equal(secrets.revoke("p/ana", "paused"), true);
  assert.equal(secrets.authenticate(s).ok, false);
  assert.equal(secrets.hasLive("p/ana"), false);
  assert.equal(secrets.revoke("p/ana", "paused"), false);
});

test("malformed and unknown secrets name no agent", (t) => {
  const { secrets } = fresh(t);
  secrets.issue("p/ana");
  assert.deepEqual(secrets.authenticate("nope"), { ok: false, reason: "malformed" });
  assert.deepEqual(secrets.authenticate("hqa_" + "A".repeat(43)), { ok: false, reason: "unknown" });
});

test("a revoked or inactive secret names its agent", (t) => {
  const { db, secrets } = fresh(t);
  const s = secrets.issue("p/ana");
  db.prepare("UPDATE agents SET status = 'paused' WHERE id = 'p/ana'").run();
  assert.deepEqual(secrets.authenticate(s), { ok: false, reason: "inactive", companyAgentId: "p/ana" });
  secrets.revoke("p/ana", "stopped");
  assert.deepEqual(secrets.authenticate(s), { ok: false, reason: "revoked", companyAgentId: "p/ana" });
});

test("agent_secrets refuses delete and un-revoke", (t) => {
  const { db, secrets } = fresh(t);
  secrets.issue("p/ana");
  secrets.issue("p/ana");
  assert.throws(() => db.exec("DELETE FROM agent_secrets"));
  assert.throws(() => db.exec("UPDATE agent_secrets SET revoked_at = NULL, revoked_reason = NULL WHERE revoked_at IS NOT NULL"));
  assert.throws(() => db.exec("UPDATE agent_secrets SET secret_hash = '" + "0".repeat(64) + "' WHERE revoked_at IS NULL"));
  assert.throws(() => db.exec(`UPDATE agent_secrets SET agent_id = 'p/ana' WHERE revoked_at IS NULL`));
  assert.equal(db.prepare("SELECT count(*) AS n FROM agent_secrets").get<{ n: number }>()?.n, 2);
});

test("a retired agent row cannot be reactivated", (t) => {
  const { db } = fresh(t);
  db.prepare("UPDATE agents SET status = 'retired', retired_at = ? WHERE id = 'p/ana'").run(NOW);
  assert.throws(() => db.exec("UPDATE agents SET status = 'active' WHERE id = 'p/ana'"));
  assert.throws(() => db.exec("UPDATE agents SET retired_at = NULL WHERE id = 'p/ana'"));
  db.exec("UPDATE agents SET name = 'Ana B' WHERE id = 'p/ana'"); // other columns still change
});

test("audit rows for issue hold neither value nor hash", (t) => {
  const { audit, secrets } = fresh(t);
  const s = secrets.issue("p/ana");
  const rows = audit.query({ action: "agent.secret.issued" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, "p/ana");
  const text = JSON.stringify(rows);
  assert.ok(!text.includes(s.slice(4)));
  assert.ok(!text.includes(hashSecret(s)));
});

test("a secret for an unknown agent is not issued", (t) => {
  const { secrets } = fresh(t);
  assert.throws(() => secrets.issue("p/nobody"));
});

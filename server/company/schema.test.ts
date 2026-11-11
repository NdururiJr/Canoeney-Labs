import assert from "node:assert/strict";
import { test } from "node:test";
import { openCompanyDb, type CompanyDb } from "./db";
import {
  ACTOR_KINDS,
  AGENT_STATUSES,
  DECISION_CATEGORIES,
  DECISION_STATUSES,
  DEPARTMENT_IDS,
  EXECUTION_STATUSES,
  HUMAN_ROLES,
  PERMISSION_KINDS,
  ROLE_IDS,
  SPEND_SOURCES,
  URGENCIES,
  VERIFICATIONS,
} from "./types";

const NOW = "2026-01-01T00:00:00.000Z";

function fresh(t: { after(fn: () => void): void }): CompanyDb {
  const db = openCompanyDb(":memory:");
  t.after(() => db.close());
  return db;
}

function addHuman(db: CompanyDb, id: string, role: string): void {
  db.prepare("INSERT INTO humans(id, display_name, role, created_at) VALUES (?, ?, ?, ?)").run(id, id, role, NOW);
}

function addAgent(db: CompanyDb, id: string, extra: { role?: string; dept?: string; manager?: string | null } = {}): void {
  db.prepare(
    "INSERT INTO agents(id, name, role_id, department_id, manager_id, cli, created_at) VALUES (?, ?, ?, ?, ?, 'claude', ?)",
  ).run(id, id, extra.role ?? "ceo", extra.dept ?? "executive", extra.manager ?? null, NOW);
}

let seq = 0;
function addDecision(db: CompanyDb, over: { category?: number | null; code?: string; key?: string; exec?: string } = {}): void {
  seq++;
  db.prepare(
    `INSERT INTO decisions(id, category, requester_kind, requester_id, summary, urgency, execution_status,
       reply_code, dedupe_key, idempotency_key, created_at)
     VALUES (?, ?, 'hq', 'hq', 's', 'normal', ?, ?, ?, ?, ?)`,
  ).run(
    `d${seq}`,
    over.category === undefined ? 2 : over.category,
    over.exec ?? "not-started",
    over.code ?? `code${seq}`,
    `dk${seq}`,
    over.key ?? `ik${seq}`,
    NOW,
  );
}

const ids = (db: CompanyDb, table: string): string[] =>
  db
    .prepare(`SELECT id FROM ${table}`)
    .all<{ id: string }>()
    .map((r) => r.id)
    .sort();

// Pinned to literals, not to the types.ts arrays: the seed is part of migration 001.
const SEEDED_ROLES = [
  "accountant",
  "builder",
  "ceo",
  "cio",
  "cto",
  "customer-service",
  "marketing",
  "qa",
  "research",
  "sales",
  "security-audit",
  "security-reviewer",
  "solutions",
];
const SEEDED_DEPARTMENTS = ["clients", "delivery", "executive", "finance", "growth", "internal-it", "security-audit", "strategy"];

test("seeds the 13 roles and 8 departments", (t) => {
  const db = fresh(t);
  assert.equal(SEEDED_ROLES.length, 13);
  assert.equal(SEEDED_DEPARTMENTS.length, 8);
  assert.deepEqual(ids(db, "roles"), SEEDED_ROLES);
  assert.deepEqual(ids(db, "departments"), SEEDED_DEPARTMENTS);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM departments WHERE head_agent_id IS NOT NULL").get<{ n: number }>()?.n,
    0,
  );
});

test("only one owner", (t) => {
  const db = fresh(t);
  addHuman(db, "h1", "owner");
  assert.throws(() => addHuman(db, "h2", "owner"), /UNIQUE/);
  addHuman(db, "h3", "supervisor");
  addHuman(db, "h4", "supervisor");
  assert.throws(() => addHuman(db, "h5", "admin"), /CHECK/);
});

test("an agent's role and department must exist", (t) => {
  const db = fresh(t);
  assert.throws(() => addAgent(db, "a1", { role: "ninja" }), /FOREIGN KEY/);
  assert.throws(() => addAgent(db, "a2", { dept: "dojo" }), /FOREIGN KEY/);
  addAgent(db, "a3");
});

test("an agent cannot manage itself", (t) => {
  const db = fresh(t);
  assert.throws(() => addAgent(db, "a1", { manager: "a1" }), /CHECK/);
  addAgent(db, "boss");
  addAgent(db, "a2", { manager: "boss" });
});

test("a client project needs a client and a company project must not have one", (t) => {
  const db = fresh(t);
  db.prepare("INSERT INTO clients(id, display_name, created_at) VALUES ('c1', 'Acme', ?)").run(NOW);
  const ins = (id: string, kind: string, client: string | null) =>
    db
      .prepare("INSERT INTO projects(id, name, repo, kind, client_id, created_at) VALUES (?, ?, 'r', ?, ?, ?)")
      .run(id, id, kind, client, NOW);
  assert.throws(() => ins("p1", "client", null), /CHECK/);
  assert.throws(() => ins("p2", "company", "c1"), /CHECK/);
  ins("p3", "company", null);
  ins("p4", "client", "c1");
});

test("decision category is 1-8 or null", (t) => {
  const db = fresh(t);
  assert.throws(() => addDecision(db, { category: 9 }), /CHECK/);
  assert.throws(() => addDecision(db, { category: 0 }), /CHECK/);
  addDecision(db, { category: null });
  addDecision(db, { category: 2 });
});

test("execution status accepts started", (t) => {
  const db = fresh(t);
  addDecision(db, { exec: "started" });
  assert.throws(() => addDecision(db, { exec: "running" }), /CHECK/);
});

test("reply codes and idempotency keys are unique", (t) => {
  const db = fresh(t);
  addDecision(db, { code: "AB12", key: "k1" });
  assert.throws(() => addDecision(db, { code: "AB12", key: "k2" }), /UNIQUE/);
  assert.throws(() => addDecision(db, { code: "CD34", key: "k1" }), /UNIQUE/);
});

test("charter versions are append-only", (t) => {
  const db = fresh(t);
  addHuman(db, "h1", "owner");
  db.prepare(
    "INSERT INTO charter_versions(version, content_json, changed_by_human_id, changed_at) VALUES (1, '{}', 'h1', ?)",
  ).run(NOW);
  assert.throws(() => db.exec("UPDATE charter_versions SET note = 'x'"), /append-only/);
  assert.throws(() => db.exec("DELETE FROM charter_versions"), /append-only/);
});

test("audit events are append-only", (t) => {
  const db = fresh(t);
  db.prepare(
    "INSERT INTO audit_events(seq, at, actor_kind, actor_id, action, data_json, prev_hash, hash) VALUES (1, ?, 'hq', 'hq', 'x', '{}', ?, 'h')",
  ).run(NOW, "0".repeat(64));
  assert.throws(() => db.exec("UPDATE audit_events SET action = 'y'"), /append-only/);
  assert.throws(() => db.exec("DELETE FROM audit_events"), /append-only/);
});

test("one active grant per agent, kind and value; a revoked grant can be granted again", (t) => {
  const db = fresh(t);
  addAgent(db, "a1");
  addHuman(db, "h1", "owner");
  const grant = (value: string) =>
    db
      .prepare("INSERT INTO permissions(agent_id, kind, value, granted_by_human_id, granted_at) VALUES ('a1', 'tool', ?, 'h1', ?)")
      .run(value, NOW);
  grant("git");
  assert.throws(() => grant("git"), /UNIQUE/);
  grant("npm");
  db.prepare("UPDATE permissions SET revoked_at = ? WHERE value = 'git'").run(NOW);
  grant("git");
});

test("currency must be three upper-case letters", (t) => {
  const db = fresh(t);
  const budget = (area: string, currency: string) =>
    db.prepare("INSERT INTO budgets(area, period, limit_minor, currency) VALUES (?, '2026-01', 100, ?)").run(area, currency);
  budget("a", "KES");
  assert.throws(() => budget("b", "kes"), /CHECK/);
  assert.throws(() => budget("c", "KE"), /CHECK/);
});

// Tripwire: every value of each types.ts union is accepted by its column and
// one value outside it is refused. When a union grows, this fails until a new
// migration widens the CHECK (a migration is never edited after it merges).
const GENESIS = "0".repeat(64);

function insertAudit(db: CompanyDb, actorKind: string): void {
  const head = db.prepare("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1").get<{ seq: number; hash: string }>();
  db.prepare(
    "INSERT INTO audit_events(seq, at, actor_kind, actor_id, action, data_json, prev_hash, hash) VALUES (?, ?, ?, 'x', 'x', '{}', ?, ?)",
  ).run((head?.seq ?? 0) + 1, NOW, actorKind, head?.hash ?? GENESIS, `h${++seq}`);
}

function insertDecision(db: CompanyDb, column: string, value: string | number): void {
  seq++;
  const cols: Record<string, string | number> = {
    id: `d${seq}`,
    requester_kind: "hq",
    requester_id: "hq",
    summary: "s",
    urgency: "normal",
    reply_code: `code${seq}`,
    dedupe_key: `dk${seq}`,
    idempotency_key: `ik${seq}`,
    created_at: NOW,
    [column]: value,
  };
  const names = Object.keys(cols);
  db.prepare(`INSERT INTO decisions(${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(
    ...names.map((n) => cols[n]),
  );
}

test("every value of the types.ts unions is accepted by its column and one outside is refused", (t) => {
  const db = fresh(t);
  addHuman(db, "owner1", "owner"); // "owner" is accepted; there can be only one

  for (const role of ROLE_IDS) addAgent(db, `r-${role}`, { role });
  assert.throws(() => addAgent(db, "r-bad", { role: "ninja" }), /FOREIGN KEY/);
  for (const dept of DEPARTMENT_IDS) addAgent(db, `d-${dept}`, { dept });
  assert.throws(() => addAgent(db, "d-bad", { dept: "dojo" }), /FOREIGN KEY/);

  for (const role of HUMAN_ROLES) if (role !== "owner") addHuman(db, `h-${role}`, role);
  assert.throws(() => addHuman(db, "h-bad", "admin"), /CHECK/);

  const agentStatus = (id: string, status: string) =>
    db
      .prepare("INSERT INTO agents(id, name, role_id, department_id, cli, status, created_at) VALUES (?, ?, 'ceo', 'executive', 'claude', ?, ?)")
      .run(id, id, status, NOW);
  for (const s of AGENT_STATUSES) agentStatus(`s-${s}`, s);
  assert.throws(() => agentStatus("s-bad", "sleeping"), /CHECK/);

  for (const s of DECISION_STATUSES) insertDecision(db, "status", s);
  assert.throws(() => insertDecision(db, "status", "maybe"), /CHECK/);
  for (const s of EXECUTION_STATUSES) insertDecision(db, "execution_status", s);
  assert.throws(() => insertDecision(db, "execution_status", "running"), /CHECK/);
  for (const u of URGENCIES) insertDecision(db, "urgency", u);
  assert.throws(() => insertDecision(db, "urgency", "low"), /CHECK/);
  for (const v of VERIFICATIONS) insertDecision(db, "verification", v);
  assert.throws(() => insertDecision(db, "verification", "email"), /CHECK/);
  for (const c of DECISION_CATEGORIES) insertDecision(db, "category", c);
  assert.throws(() => insertDecision(db, "category", 9), /CHECK/);

  addAgent(db, "grantee");
  const grant = (kind: string) =>
    db
      .prepare("INSERT INTO permissions(agent_id, kind, value, granted_by_human_id, granted_at) VALUES ('grantee', ?, 'v', 'owner1', ?)")
      .run(kind, NOW);
  for (const k of PERMISSION_KINDS) grant(k);
  assert.throws(() => grant("root"), /CHECK/);

  const spend = (source: string) =>
    db
      .prepare("INSERT INTO spend(occurred_at, vendor, area, amount_minor, currency, source) VALUES (?, 'v', 'a', 1, 'KES', ?)")
      .run(NOW, source);
  for (const s of SPEND_SOURCES) spend(s);
  assert.throws(() => spend("gift"), /CHECK/);

  for (const k of ACTOR_KINDS) insertAudit(db, k);
  assert.throws(() => insertAudit(db, "robot"), /CHECK/);

  const outbox = (urgency: string) =>
    db
      .prepare(
        "INSERT INTO channel_outbox(channel, recipient_human_id, urgency, title, body, status, created_at) VALUES ('dashboard', 'owner1', ?, 't', 'b', 'queued', ?)",
      )
      .run(urgency, NOW);
  for (const u of URGENCIES) outbox(u);
  assert.throws(() => outbox("low"), /CHECK/);
});

test("a decision cost has both an amount and a valid currency, or neither", (t) => {
  const db = fresh(t);
  const cost = (minor: number | null, currency: string | null) => {
    seq++;
    db.prepare(
      `INSERT INTO decisions(id, requester_kind, requester_id, summary, urgency, reply_code, dedupe_key, idempotency_key,
         cost_minor, cost_currency, created_at)
       VALUES (?, 'hq', 'hq', 's', 'normal', ?, ?, ?, ?, ?, ?)`,
    ).run(`d${seq}`, `code${seq}`, `dk${seq}`, `ik${seq}`, minor, currency, NOW);
  };
  cost(null, null);
  cost(500, "KES");
  assert.throws(() => cost(500, null), /CHECK/);
  assert.throws(() => cost(null, "KES"), /CHECK/);
  assert.throws(() => cost(500, "kes"), /CHECK/);
  assert.throws(() => cost(500, "KE"), /CHECK/);
});

test("a permission grant must record who granted it", (t) => {
  const db = fresh(t);
  addAgent(db, "a1");
  addHuman(db, "h1", "owner");
  addDecision(db);
  const decisionId = `d${seq}`;
  const grant = (value: string, decision: string | null, human: string | null) =>
    db
      .prepare(
        "INSERT INTO permissions(agent_id, kind, value, granted_by_decision_id, granted_by_human_id, granted_at) VALUES ('a1', 'tool', ?, ?, ?, ?)",
      )
      .run(value, decision, human, NOW);
  assert.throws(() => grant("git", null, null), /CHECK/);
  grant("git", null, "h1");
  grant("npm", decisionId, null);
});

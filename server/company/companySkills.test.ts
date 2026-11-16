import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentRegistry } from "./agents";
import { AgentSecrets } from "./agentSecrets";
import { SqliteAuditSink } from "./audit";
import { AuthorityError, relaxes, type Authority } from "./authority";
import { FakeClock } from "./clock";
import { CompanySkills, type LockedSkill } from "./companySkills";
import { openCompanyDb, type CompanyDb } from "./db";
import { ProjectSettings } from "./projectSettings";
import { HQ_TOOLS, TOOLS_BY_ROLE } from "./roleTools";
import type { AuditEvent, AuditEventInput, AuditSink } from "./slots/types";
import { ROLE_IDS } from "./types";

const NOW = "2026-11-15T08:00:00.000Z";
const PIN: Authority = { via: "pin", humanId: "owner" };
const SESSION: Authority = { via: "session", humanId: "owner" };
const HQ: Authority = { via: "hq" };

let decisionSeq = 0;
function addDecision(db: CompanyDb, status: "pending" | "approved"): string {
  const id = `dec-${++decisionSeq}`;
  db.prepare(
    `INSERT INTO decisions(id, category, requester_kind, requester_id, summary, urgency, status, reply_code, dedupe_key, idempotency_key, created_at)
     VALUES (?, 2, 'hq', 'hq', 's', 'normal', ?, ?, ?, ?, ?)`,
  ).run(id, status, `rc-${id}`, `dk-${id}`, `ik-${id}`, NOW);
  return id;
}

/** Wraps an audit sink and throws when asked to append one action. */
class FailingAudit implements AuditSink {
  failOn: string | null = null;
  constructor(private readonly inner: AuditSink) {}
  append(e: AuditEventInput): AuditEvent {
    if (e.action === this.failOn) throw new Error("audit append failed");
    return this.inner.append(e);
  }
  head() {
    return this.inner.head();
  }
  verify() {
    return this.inner.verify();
  }
  query(q?: Parameters<AuditSink["query"]>[0]) {
    return this.inner.query(q);
  }
}

function fresh(t: { after(fn: () => void): void }) {
  const db = openCompanyDb(":memory:");
  t.after(() => db.close());
  const clock = new FakeClock(NOW);
  const real = new SqliteAuditSink(db, clock);
  const audit = new FailingAudit(real);
  const secrets = new AgentSecrets(db, clock, real);
  const agents = new AgentRegistry(db, clock, real, secrets);
  for (const [id, role] of [
    ["owner", "owner"],
    ["sup", "supervisor"],
  ]) {
    db.prepare("INSERT INTO humans(id, display_name, role, created_at) VALUES (?, ?, ?, ?)").run(id, id, role, NOW);
  }
  const settings = new ProjectSettings(db, clock, audit, agents);
  const skills = new CompanySkills(db, clock, settings);
  return { db, clock, audit, settings, skills };
}

type Ctx = ReturnType<typeof fresh>;

const snapshot = (c: Ctx): string => JSON.stringify(c.db.prepare("SELECT role, skill FROM role_skills ORDER BY role, skill").all());

function expectRefused(c: Ctx, fn: () => unknown, reason: AuthorityError["reason"], actorId: string) {
  const before = snapshot(c);
  const refusedBefore = c.audit.query({ action: "settings.refused" }).length;
  const setBefore = c.audit.query({ action: "skills.role-set" }).length;
  assert.throws(fn, (e: unknown) => e instanceof AuthorityError && e.reason === reason);
  const rows = c.audit.query({ action: "settings.refused" });
  assert.equal(rows.length, refusedBefore + 1, "one settings.refused row");
  const row = rows[rows.length - 1];
  assert.equal(row.actorId, actorId);
  assert.equal(row.data.reason, reason);
  assert.equal(row.data.change, "role-skills");
  assert.equal(c.audit.query({ action: "skills.role-set" }).length, setBefore, "no skills.role-set row");
  assert.equal(snapshot(c), before, "the role set is unchanged");
}

const sorted = (a: string[]): string[] => [...a].sort();

test("migration 008 creates the skill tables", (t) => {
  const { db } = fresh(t);
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>()
    .map((r) => r.name);
  for (const table of ["skill_source", "skill_lock", "role_skills", "agent_sandboxes"]) assert.ok(names.includes(table), table);
  // skill_source holds at most one row.
  const ins = (id: number) =>
    db.prepare("INSERT INTO skill_source(id, repo, commit_sha, lock_hash, pinned_at) VALUES (?, 'a/b', 'c', 'h', ?)").run(id, NOW);
  assert.throws(() => ins(2), /CHECK/);
});

test("the starting role sets are §2a's", (t) => {
  const { skills } = fresh(t);
  assert.deepEqual(sorted(skills.roleSet("builder")), sorted(["test-driven-development", "systematic-debugging", "verification-before-completion", "executing-plans"]));
  assert.deepEqual(sorted(skills.roleSet("cto")), sorted(["writing-plans", "requesting-code-review", "brainstorming"]));
  assert.deepEqual(skills.roleSet("ceo"), ["verification-before-completion"]);
  assert.deepEqual(skills.roleSet("cio"), ["verification-before-completion"]);
  assert.deepEqual(skills.roleSet("qa"), []);
  for (const role of ROLE_IDS) if (!["builder", "cto", "ceo", "cio"].includes(role)) assert.deepEqual(skills.roleSet(role), [], role);
});

test("SR-F-03 [T-S12.4] a role set changes only with the PIN or an approved decision", (t) => {
  const c = fresh(t);
  const wanted = ["brainstorming", "writing-plans"];

  // A session without the PIN, and HQ itself.
  expectRefused(c, () => c.skills.setRoleSkills("cto", wanted, SESSION), "pin-or-decision-required", "owner");
  expectRefused(c, () => c.skills.setRoleSkills("cto", wanted, HQ), "hq-cannot-grant", "hq");
  // HQ may not even narrow a set: a role-set change is never a revoke.
  expectRefused(c, () => c.skills.setRoleSkills("builder", [], HQ), "hq-cannot-grant", "hq");
  // A supervisor, with or without the PIN.
  expectRefused(c, () => c.skills.setRoleSkills("cto", wanted, { via: "pin", humanId: "sup" }), "not-owner", "sup");

  // A pending decision authorises nothing.
  const pending = addDecision(c.db, "pending");
  expectRefused(c, () => c.skills.setRoleSkills("cto", wanted, { via: "decision", decisionId: pending }), "decision-not-approved", "hq");

  // The owner with the PIN.
  const r = c.skills.setRoleSkills("cto", wanted, PIN);
  assert.deepEqual(r, { added: [], removed: ["requesting-code-review"] });
  assert.deepEqual(sorted(c.skills.roleSet("cto")), wanted);
  const row = c.audit.query({ action: "skills.role-set" }).at(-1)!;
  assert.equal(row.actorKind, "human");
  assert.equal(row.actorId, "owner");
  assert.equal(row.data.role, "cto");
  assert.deepEqual(row.data.added, []);
  assert.deepEqual(row.data.removed, ["requesting-code-review"]);
  assert.equal(row.data.authority, "pin");

  // An approved decision, and its row names it.
  const approved = addDecision(c.db, "approved");
  const r2 = c.skills.setRoleSkills("qa", ["test-driven-development"], { via: "decision", decisionId: approved });
  assert.deepEqual(r2, { added: ["test-driven-development"], removed: [] });
  assert.deepEqual(c.skills.roleSet("qa"), ["test-driven-development"]);
  const row2 = c.audit.query({ action: "skills.role-set" }).at(-1)!;
  assert.equal(row2.decisionId, approved);
  assert.equal(row2.actorKind, "hq");
  assert.equal(row2.data.authority, "decision");
});

test("a role-set write that changes nothing writes nothing", (t) => {
  const c = fresh(t);
  const seq = c.audit.head()?.seq ?? 0;
  assert.deepEqual(c.skills.setRoleSkills("ceo", ["verification-before-completion"], SESSION), { added: [], removed: [] });
  assert.equal(c.audit.head()?.seq ?? 0, seq);
});

test("a role-set name must be a skill name", (t) => {
  const c = fresh(t);
  for (const bad of ["", "Upper", "-lead", "a/b", "../x", "a".repeat(64), "has space"]) {
    assert.throws(() => c.skills.setRoleSkills("qa", [bad], PIN), /skill name/i, bad);
  }
  assert.deepEqual(c.skills.roleSet("qa"), []);
});

test("SR-F-03 [T-S12.4] if the audit row cannot be written the role set rolls back", (t) => {
  const c = fresh(t);
  const before = snapshot(c);
  c.audit.failOn = "skills.role-set";
  assert.throws(() => c.skills.setRoleSkills("builder", ["brainstorming"], PIN), /audit append failed/);
  c.audit.failOn = null;
  assert.equal(snapshot(c), before);
  assert.deepEqual(sorted(c.skills.roleSet("builder")), sorted(["test-driven-development", "systematic-debugging", "verification-before-completion", "executing-plans"]));
  assert.equal(c.audit.query({ action: "skills.role-set" }).length, 0);
});

test("SR-F-03 [T-S12.4] a pin and a role-set change relax a control only when something changes", () => {
  assert.equal(relaxes({ kind: "skills-pin", before: null, after: "a".repeat(40), lockHash: "h" }), true);
  assert.equal(relaxes({ kind: "skills-pin", before: "a".repeat(40), after: "b".repeat(40), lockHash: "h" }), true);
  assert.equal(relaxes({ kind: "skills-pin", before: "a".repeat(40), after: "a".repeat(40), lockHash: "h" }), false);
  assert.equal(relaxes({ kind: "role-skills", role: "cto", before: ["a"], after: ["a", "b"] }), true);
  assert.equal(relaxes({ kind: "role-skills", role: "cto", before: ["a", "b"], after: ["a"] }), true);
  // Order is not a change.
  assert.equal(relaxes({ kind: "role-skills", role: "cto", before: ["a", "b"], after: ["b", "a"] }), false);
});

test("SR-F-03 [T-S12.4] no agent tool changes skills", () => {
  for (const tool of HQ_TOOLS) assert.ok(!tool.includes("skill"), tool);
  for (const [role, tools] of Object.entries(TOOLS_BY_ROLE)) {
    for (const tool of tools) assert.ok(!tool.includes("skill"), `${role}: ${tool}`);
  }
});

const lockedSkill = (name: string): LockedSkill => ({
  name,
  hash: "h".repeat(63) + name.length,
  files: [
    { path: "SKILL.md", mode: "100644", sha256: "a".repeat(64) },
    { path: "run.sh", mode: "100755", sha256: "b".repeat(64) },
  ],
  scripts: ["run.sh"],
});

test("writePin replaces the source and the lock; the company store holds them", (t) => {
  const c = fresh(t);
  assert.equal(c.skills.source(), null);
  assert.deepEqual(c.skills.lock(), []);

  c.skills.writePin({ repo: "acme/skills", commit: "a".repeat(40), lockHash: "L1", skills: [lockedSkill("beta"), lockedSkill("alpha")] }, PIN);
  assert.deepEqual(c.skills.source(), { repo: "acme/skills", commit: "a".repeat(40), lockHash: "L1" });
  assert.deepEqual(
    c.skills.lock().map((s) => s.name),
    ["alpha", "beta"],
  );
  assert.deepEqual(c.skills.lock()[0], lockedSkill("alpha"));

  // A second pin replaces both.
  c.skills.writePin({ repo: "acme/skills", commit: "b".repeat(40), lockHash: "L2", skills: [lockedSkill("gamma")] }, PIN);
  assert.deepEqual(c.skills.source(), { repo: "acme/skills", commit: "b".repeat(40), lockHash: "L2" });
  assert.deepEqual(
    c.skills.lock().map((s) => s.name),
    ["gamma"],
  );
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM skill_source").get<{ n: number }>()!.n, 1);
});

test("writePin joins the caller's transaction, and rolls back with it", (t) => {
  const c = fresh(t);
  assert.throws(() =>
    c.db.transaction(() => {
      c.skills.writePin({ repo: "acme/skills", commit: "a".repeat(40), lockHash: "L1", skills: [lockedSkill("alpha")] }, PIN);
      throw new Error("later step failed");
    }, "immediate"),
  /later step failed/);
  assert.equal(c.skills.source(), null);
  assert.deepEqual(c.skills.lock(), []);
});

test("SR-F-03 [T-S12.4] writePin is not an authority of its own: a session or HQ cannot call it", (t) => {
  const c = fresh(t);
  for (const by of [SESSION, HQ]) {
    assert.throws(() => c.skills.writePin({ repo: "acme/skills", commit: "a".repeat(40), lockHash: "L1", skills: [] }, by), /PIN or an approved decision/);
  }
  assert.equal(c.skills.source(), null);
});

test("the lock lives only in the company store", (t) => {
  const c = fresh(t);
  const root = mkdtempSync(join(tmpdir(), "hq-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A project home and an agent folder the test made.
  const projectHome = join(root, "project");
  const agentFolder = join(root, "agent");
  mkdirSync(join(projectHome, ".hq"), { recursive: true });
  mkdirSync(join(agentFolder, ".claude", "skills"), { recursive: true });
  writeFileSync(join(agentFolder, "README.md"), "x");

  c.skills.writePin({ repo: "acme/skills", commit: "a".repeat(40), lockHash: "L1", skills: [lockedSkill("alpha")] }, PIN);

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name, ...walk(join(dir, e.name))] : [e.name]));
  const names = [...walk(projectHome), ...walk(agentFolder)];
  assert.deepEqual(
    names.filter((n) => /lock/i.test(n)),
    [],
  );
  // The lock is in the store.
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM skill_lock").get<{ n: number }>()!.n, 1);
});

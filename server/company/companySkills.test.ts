import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentRegistry } from "./agents";
import { AgentSecrets } from "./agentSecrets";
import { SqliteAuditSink } from "./audit";
import { AuthorityError, relaxes, type Authority } from "./authority";
import { FakeClock } from "./clock";
import type { Finding } from "../github/repoGuard";
import { makeSkillsRepo, type FixtureFiles } from "../testing/skillsRepo";
import { CompanySkills, SkillPinRefused, type LockedSkill } from "./companySkills";
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

// ---------------------------------------------------------------- the pin (Task 3)

const SKILLS_REPO = "acme/skills";
const NOT_A_PIN = "f".repeat(64);

/** A company home with a local skills repo behind it; no network is reached. */
function freshPin(t: { after(fn: () => void): void }, o: { check?: (repo: string) => Promise<Finding[]> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hq-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = makeSkillsRepo(root);
  const home = join(root, "company home");
  const base = fresh(t);
  const skills = new CompanySkills(base.db, base.clock, base.settings, {
    home,
    check: o.check ?? (async () => []),
    urlFor: () => origin.url,
    allowFile: true,
  });
  return { ...base, skills, origin, home, bare: join(home, "skills", "repo.git"), store: join(home, "skills", "store") };
}

const skillTree = (skills: Record<string, string>): FixtureFiles =>
  Object.fromEntries(Object.entries(skills).map(([name, body]) => [`skills/${name}/SKILL.md`, body]));

const pinState = (c: ReturnType<typeof freshPin>): string => JSON.stringify({ source: c.skills.source(), lock: c.skills.lock() });

async function expectPinRefused(c: ReturnType<typeof freshPin>, fn: () => Promise<unknown>, reason: string, actorId = "owner") {
  const before = pinState(c);
  const rows = c.audit.query({ action: "skills.pin-refused" }).length;
  const pinned = c.audit.query({ action: "skills.pinned" }).length;
  await assert.rejects(fn, (e: unknown) => e instanceof SkillPinRefused && e.reason === reason, `refused with ${reason}`);
  const after = c.audit.query({ action: "skills.pin-refused" });
  assert.equal(after.length, rows + 1, "one skills.pin-refused row");
  assert.equal(after.at(-1)!.actorId, actorId, "the caller is the actor");
  assert.equal(after.at(-1)!.data.reason, reason);
  assert.equal(c.audit.query({ action: "skills.pinned" }).length, pinned, "no skills.pinned row");
  assert.equal(pinState(c), before, "the pin reads back unchanged");
}

const storeIsEmpty = (c: ReturnType<typeof freshPin>) => !existsSync(c.store) || readdirSync(c.store).length === 0;

test("SR-F-01 [T-S12.1] the pin installs only what the owner previewed", async (t) => {
  const c = freshPin(t);
  const a = c.origin.commit(skillTree({ alpha: "alpha v1" }));
  const preview = await c.skills.preview(SKILLS_REPO, a, PIN);
  assert.equal(preview.commit, a);
  assert.deepEqual(preview.skills.map((s) => s.name), ["alpha"]);

  // The repo moves on between the preview and the confirm.
  const b = c.origin.commit(skillTree({ alpha: "alpha v2", beta: "beta" }));
  await c.skills.pin(SKILLS_REPO, a, preview.lockHash, PIN);
  assert.deepEqual(c.skills.source(), { repo: SKILLS_REPO, commit: a, lockHash: preview.lockHash });
  assert.deepEqual(c.skills.lock().map((s) => s.name), ["alpha"]);
  assert.equal(c.skills.lock()[0].hash, preview.skills[0].hash);
  assert.equal(readFileSync(join(c.store, preview.skills[0].hash, "SKILL.md"), "utf8"), "alpha v1");
  const row = c.audit.query({ action: "skills.pinned" }).at(-1)!;
  assert.equal(row.actorId, "owner");
  assert.equal(row.data.repo, SKILLS_REPO);
  assert.equal(row.data.commit, a);
  assert.equal(row.data.lockHash, preview.lockHash);
  assert.deepEqual(row.data.added, ["alpha"]);
  assert.deepEqual(row.data.changed, []);
  assert.deepEqual(row.data.removed, []);

  // A confirm whose lock hash is not what the commit reads as is refused.
  await expectPinRefused(c, () => c.skills.pin(SKILLS_REPO, b, preview.lockHash, PIN), "lock-changed");
  await expectPinRefused(c, () => c.skills.pin(SKILLS_REPO, b, NOT_A_PIN, PIN), "lock-changed");
  assert.equal(c.skills.source()!.commit, a);
});

test("SR-F-01 [T-S12.1] a commit that is not on the skills repo's default branch is refused", async (t) => {
  const c = freshPin(t);
  const main = c.origin.commit(skillTree({ alpha: "a" }));
  const pr = c.origin.commit(skillTree({ alpha: "a", evil: "e" }), { ref: "refs/pull/1/head", parent: main });
  await expectPinRefused(c, () => c.skills.preview(SKILLS_REPO, pr, PIN), "not-on-default-branch");
  await expectPinRefused(c, () => c.skills.pin(SKILLS_REPO, pr, NOT_A_PIN, PIN), "not-on-default-branch");
  assert.equal(c.skills.source(), null);
  assert.deepEqual(c.skills.lock(), []);
  assert.ok(storeIsEmpty(c), "nothing reached the store");
});

test("a pin refusal for a bad commit id, a failed fetch, or a bad repo name", async (t) => {
  const c = freshPin(t);
  c.origin.commit(skillTree({ alpha: "a" }));
  await expectPinRefused(c, () => c.skills.preview(SKILLS_REPO, "nope", PIN), "bad-sha");
  await expectPinRefused(c, () => c.skills.pin(SKILLS_REPO, "A".repeat(40), NOT_A_PIN, PIN), "bad-sha");

  const lost = new CompanySkills(c.db, c.clock, c.settings, { home: c.home, urlFor: () => join(c.home, "no-such-repo.git"), allowFile: true });
  await expectPinRefused({ ...c, skills: lost }, () => lost.preview(SKILLS_REPO, "a".repeat(40), PIN), "fetch-failed");
  await expectPinRefused({ ...c, skills: lost }, () => lost.pin(SKILLS_REPO, "a".repeat(40), NOT_A_PIN, PIN), "fetch-failed");

  // A repo name that is not owner/name never reaches git.
  for (const bad of ["", "acme", "a/b/c", "a/", "/b", "a b/c", "a/b;c", "https://x/y"]) {
    await assert.rejects(() => c.skills.preview(bad, "a".repeat(40), PIN), /owner\/name/, bad);
    await assert.rejects(() => c.skills.pin(bad, "a".repeat(40), NOT_A_PIN, PIN), /owner\/name/, bad);
  }
});

test("SR-F-01 [T-S12.5] a pin with one refused skill pins nothing", async (t) => {
  const c = freshPin(t);
  const sha = c.origin.commit({ ...skillTree({ good: "g", bad: "b" }), "skills/bad/leak": { link: "/etc/passwd" } });
  const preview = await c.skills.preview(SKILLS_REPO, sha, PIN);
  assert.deepEqual(preview.refused, [{ skill: "bad", reason: "link" }]);
  assert.deepEqual(preview.skills.map((s) => s.name), ["good"]);
  await expectPinRefused(c, () => c.skills.pin(SKILLS_REPO, sha, preview.lockHash, PIN), "refused-skill");
  assert.ok(storeIsEmpty(c), "the good skill was not stored either");
});

test("the preview links the commit and, once a pin exists, the comparison from the old pin", async (t) => {
  const c = freshPin(t);
  const a = c.origin.commit(skillTree({ alpha: "1" }));
  const first = await c.skills.preview(SKILLS_REPO, a, PIN);
  assert.deepEqual(first.links, { commit: `https://github.com/${SKILLS_REPO}/commit/${a}`, compare: null });
  assert.deepEqual(first.added, ["alpha"]);
  await c.skills.pin(SKILLS_REPO, a, first.lockHash, PIN);

  const b = c.origin.commit(skillTree({ alpha: "2", beta: "x" }));
  const second = await c.skills.preview(SKILLS_REPO, b, PIN);
  assert.deepEqual(second.links, { commit: `https://github.com/${SKILLS_REPO}/commit/${b}`, compare: `https://github.com/${SKILLS_REPO}/compare/${a}...${b}` });
  assert.deepEqual(second.added, ["beta"]);
  assert.deepEqual(second.changed, ["alpha"]);
  assert.deepEqual(second.removed, []);
  assert.equal(second.repo, SKILLS_REPO);
  assert.equal(second.commit, b);
  // A preview changes nothing.
  assert.equal(c.skills.source()!.commit, a);
});

test("a preview lists each skill's file count and its scripts", async (t) => {
  const c = freshPin(t);
  const sha = c.origin.commit({ ...skillTree({ alpha: "a" }), "skills/alpha/run.sh": { data: "echo hi", mode: "100755" }, "skills/alpha/notes.md": "n" });
  const p = await c.skills.preview(SKILLS_REPO, sha, PIN);
  assert.equal(p.skills[0].files, 3);
  assert.deepEqual(p.skills[0].scripts, ["run.sh"]);
  assert.match(p.skills[0].hash, /^[0-9a-f]{64}$/);
  assert.match(p.lockHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(p.findings, []);
});

test("SR-F-01 [T-S12.1] a pin whose audit row cannot be written changes nothing", async (t) => {
  const c = freshPin(t);
  const a = c.origin.commit(skillTree({ alpha: "1" }));
  await c.skills.pin(SKILLS_REPO, a, (await c.skills.preview(SKILLS_REPO, a, PIN)).lockHash, PIN);
  const before = pinState(c);

  const b = c.origin.commit(skillTree({ alpha: "2" }));
  const p = await c.skills.preview(SKILLS_REPO, b, PIN);
  c.audit.failOn = "skills.pinned";
  await assert.rejects(() => c.skills.pin(SKILLS_REPO, b, p.lockHash, PIN), /audit append failed/);
  c.audit.failOn = null;
  assert.equal(pinState(c), before, "the old pin stays");
  assert.equal(c.skills.source()!.commit, a);
  assert.equal(c.audit.query({ action: "skills.pinned" }).length, 1);

  // The same holds for a role-set change (the Task 1 test above covers it in full).
  const roles = snapshot(c);
  c.audit.failOn = "skills.role-set";
  assert.throws(() => c.skills.setRoleSkills("builder", ["alpha"], PIN), /audit append failed/);
  c.audit.failOn = null;
  assert.equal(snapshot(c), roles);

  // With the sink healthy again, the same confirm pins.
  await c.skills.pin(SKILLS_REPO, b, p.lockHash, PIN);
  assert.equal(c.skills.source()!.commit, b);
});

test("SR-F-03 [T-S12.4] pinning needs the PIN or an approved decision", async (t) => {
  const c = freshPin(t);
  const sha = c.origin.commit(skillTree({ alpha: "a" }));
  const { lockHash } = await c.skills.preview(SKILLS_REPO, sha, PIN);
  rmSync(c.bare, { recursive: true, force: true });

  const refused = async (by: Authority, reason: AuthorityError["reason"], actorId: string) => {
    const before = pinState(c);
    const n = c.audit.query({ action: "settings.refused" }).length;
    await assert.rejects(() => c.skills.pin(SKILLS_REPO, sha, lockHash, by), (e: unknown) => e instanceof AuthorityError && e.reason === reason);
    const rows = c.audit.query({ action: "settings.refused" });
    assert.equal(rows.length, n + 1);
    assert.equal(rows.at(-1)!.actorId, actorId);
    assert.equal(rows.at(-1)!.data.reason, reason);
    assert.equal(rows.at(-1)!.data.change, "skills-pin");
    assert.equal(c.audit.query({ action: "skills.pinned" }).length, 0);
    assert.equal(pinState(c), before);
  };
  await refused(SESSION, "pin-or-decision-required", "owner");
  await refused(HQ, "hq-cannot-grant", "hq");
  await refused({ via: "pin", humanId: "sup" }, "not-owner", "sup");
  await refused({ via: "decision", decisionId: addDecision(c.db, "pending") }, "decision-not-approved", "hq");
  assert.ok(!existsSync(c.bare), "a refused caller made HQ fetch nothing");

  // An approved decision pins, and the row names it.
  const approved = addDecision(c.db, "approved");
  await c.skills.pin(SKILLS_REPO, sha, lockHash, { via: "decision", decisionId: approved });
  assert.equal(c.skills.source()!.commit, sha);
  const viaDecision = c.audit.query({ action: "skills.pinned" }).at(-1)!;
  assert.equal(viaDecision.decisionId, approved);
  assert.equal(viaDecision.data.authority, "decision");

  // And the owner with the PIN, on a fresh company.
  const d = freshPin(t);
  const sha2 = d.origin.commit(skillTree({ alpha: "a" }));
  await d.skills.pin(SKILLS_REPO, sha2, (await d.skills.preview(SKILLS_REPO, sha2, PIN)).lockHash, PIN);
  const row = d.audit.query({ action: "skills.pinned" }).at(-1)!;
  assert.equal(row.actorKind, "human");
  assert.equal(row.actorId, "owner");
  assert.equal(row.data.authority, "pin");
});

test("the pin preview names the roles that lose a skill", async (t) => {
  const c = freshPin(t);
  const a = c.origin.commit(skillTree({ alpha: "a", beta: "b", gamma: "g" }));
  await c.skills.pin(SKILLS_REPO, a, (await c.skills.preview(SKILLS_REPO, a, PIN)).lockHash, PIN);
  c.skills.setRoleSkills("qa", ["alpha", "beta"], PIN);
  c.skills.setRoleSkills("cto", ["beta", "never-pinned"], PIN);
  c.skills.setRoleSkills("sales", ["gamma"], PIN);

  // The next commit drops alpha and beta.
  const next = c.origin.commit(skillTree({ gamma: "g" }));
  const p = await c.skills.preview(SKILLS_REPO, next, PIN);
  assert.deepEqual(p.removed, ["alpha", "beta"]);
  const losing = Object.fromEntries(p.rolesLosing.map((r) => [r.role, r.skills]));
  assert.deepEqual(losing.qa, ["alpha", "beta"]);
  assert.deepEqual(losing.cto, ["beta"], "a name that was never in the lock is not a loss");
  assert.equal(losing.sales, undefined);
  assert.equal(losing.builder, undefined, "the starting sets name skills the lock does not hold yet");
});

test("a pin is refused while the skills repo check has findings", async (t) => {
  const finding: Finding = { name: "collaborators", detail: "an agent can write to the skills repo", fixable: false };
  let findings: Finding[] = [finding];
  const c = freshPin(t, { check: async () => findings });
  const sha = c.origin.commit(skillTree({ alpha: "a" }));
  const p = await c.skills.preview(SKILLS_REPO, sha, PIN);
  assert.deepEqual(p.findings, [finding], "the preview shows the finding");
  await expectPinRefused(c, () => c.skills.pin(SKILLS_REPO, sha, p.lockHash, PIN), "repo-check");
  assert.ok(storeIsEmpty(c));

  findings = [];
  await c.skills.pin(SKILLS_REPO, sha, p.lockHash, PIN);
  assert.equal(c.skills.source()!.commit, sha);
});

test("a check that throws refuses the preview and the pin as repo-check, audited with the caller as actor", async (t) => {
  let boom = false;
  const c = freshPin(t, {
    check: async () => {
      if (boom) throw new Error("gh exploded");
      return [];
    },
  });
  const sha = c.origin.commit(skillTree({ alpha: "a" }));
  const p = await c.skills.preview(SKILLS_REPO, sha, PIN);
  boom = true;
  // A supervisor's preview is audited under the supervisor, not the owner.
  const SUP: Authority = { via: "session", humanId: "sup" };
  await expectPinRefused(c, () => c.skills.preview(SKILLS_REPO, sha, SUP), "repo-check", "sup");
  await expectPinRefused(c, () => c.skills.pin(SKILLS_REPO, sha, p.lockHash, PIN), "repo-check");
  assert.ok(storeIsEmpty(c));
  // The text the owner reads names no internal error.
  const err = await c.skills.pin(SKILLS_REPO, sha, p.lockHash, PIN).catch((e: unknown) => e);
  assert.ok(err instanceof SkillPinRefused);
  assert.doesNotMatch(err.message, /exploded/);
  boom = false;
  await c.skills.pin(SKILLS_REPO, sha, p.lockHash, PIN);
  assert.equal(c.skills.source()!.commit, sha);
});

test("two pins at once run one after the other", async (t) => {
  const c = freshPin(t);
  const a = c.origin.commit(skillTree({ alpha: "1" }));
  const b = c.origin.commit(skillTree({ alpha: "2" }));
  const [pa, pb] = await Promise.all([c.skills.preview(SKILLS_REPO, a, PIN), c.skills.preview(SKILLS_REPO, b, PIN)]);
  await Promise.all([c.skills.pin(SKILLS_REPO, a, pa.lockHash, PIN), c.skills.pin(SKILLS_REPO, b, pb.lockHash, PIN)]);
  assert.equal(c.skills.source()!.commit, b);
});

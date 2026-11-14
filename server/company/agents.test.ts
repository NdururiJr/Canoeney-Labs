import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentRegistry, companyAgentId } from "./agents";
import { AgentSecrets } from "./agentSecrets";
import { SqliteAuditSink } from "./audit";
import { FakeClock } from "./clock";
import { openCompanyDb, type CompanyDb } from "./db";

/** A logged-in human, as dashboard commands pass it (M0-C). */
const DASHBOARD_ACTOR = { kind: "human", id: "owner" } as const;
const NOW = "2026-11-12T08:00:00.000Z";

/** A settings row naming the project's GitHub repo, as the import or the dashboard writes it. */
function settingsGithub(db: CompanyDb, projectId: string, github: string): void {
  db.prepare("INSERT INTO project_settings(project_id, github, workflow_json, export_plan, updated_at) VALUES (?, ?, '{}', 0, ?)").run(projectId, github, NOW);
}

function fresh(t: { after(fn: () => void): void }, slugs = ["alpha"]) {
  const db = openCompanyDb(":memory:");
  t.after(() => db.close());
  const clock = new FakeClock(NOW);
  const audit = new SqliteAuditSink(db, clock);
  const secrets = new AgentSecrets(db, clock, audit);
  const agents = new AgentRegistry(db, clock, audit, secrets);
  for (const slug of slugs) agents.ensureProject({ slug, name: slug, root: join(tmpdir(), `repo-${slug}`), github: null });
  return { db, clock, audit, secrets, agents };
}

const member = (id: string, isLead = false) => ({ id, name: id[0].toUpperCase() + id.slice(1), cli: "claude" as const, isLead });

/** A CTO "lead" and builders, registered from the dashboard. */
function team(agents: AgentRegistry, slug: string, ...builders: string[]): void {
  agents.register(slug, member("lead"), "cto", DASHBOARD_ACTOR, "dashboard");
  for (const id of builders) agents.register(slug, member(id), "builder", DASHBOARD_ACTOR, "dashboard");
}

test("companyAgentId joins project and agent, and refuses ids that are not plain slugs", () => {
  assert.equal(companyAgentId("alpha", "lead"), "alpha/lead");
  for (const [p, a] of [
    ["alpha", "../x"],
    ["Alpha", "lead"],
    ["alpha", ""],
    ["a/b", "lead"],
  ]) {
    assert.throws(() => companyAgentId(p, a));
  }
});

test("same agent id in two projects registers twice", (t) => {
  const { agents } = fresh(t, ["alpha", "beta"]);
  team(agents, "alpha");
  team(agents, "beta");
  assert.equal(agents.get("alpha", "lead")?.companyId, "alpha/lead");
  assert.equal(agents.get("beta", "lead")?.companyId, "beta/lead");
  assert.equal(agents.getById("beta/lead")?.projectSlug, "beta");
  assert.equal(agents.list("alpha").length, 1);
});

test("register refuses an id that is already registered, in any status", (t) => {
  const { agents } = fresh(t);
  agents.register("alpha", member("ana"), "builder", DASHBOARD_ACTOR, "dashboard");
  agents.setStatus("alpha", "ana", "retired", DASHBOARD_ACTOR);
  assert.throws(() => agents.register("alpha", member("ana"), "builder", DASHBOARD_ACTOR, "dashboard"));
});

test("the store picks the project id: a repo keeps its id, a second repo of the same name gets the next one, a moved repo keeps its own", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hq projects "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [a, b, c] = ["repo a", "repo b", "repo c"].map((n) => join(dir, n));
  for (const p of [a, b, c]) mkdirSync(p);
  const { agents, audit, db } = fresh(t, []);
  const gh = "acme/alpha";
  assert.equal(agents.ensureProject({ slug: "alpha", name: "alpha", root: a, github: gh }), "alpha");
  settingsGithub(db, "alpha", gh);
  assert.equal(agents.ensureProject({ slug: "alpha", name: "alpha", root: a, github: gh }), "alpha"); // same root: nothing happens
  assert.equal(agents.ensureProject({ slug: "alpha", name: "alpha", root: b, github: gh }), "alpha-2"); // repo a still exists
  assert.equal(agents.projectForRoot(b), "alpha-2");
  rmSync(a, { recursive: true });
  assert.equal(agents.ensureProject({ slug: "alpha", name: "alpha", root: c, github: gh }), "alpha"); // a was moved to c
  assert.equal(db.prepare("SELECT repo FROM projects WHERE id = 'alpha'").get<{ repo: string }>()?.repo, c);
  const moved = audit.query({ action: "project.moved" });
  assert.equal(moved.length, 1);
  assert.deepEqual(moved[0].data, { from: a, to: c });
  assert.equal(audit.query({ action: "project.registered" }).length, 2);
  // With no slug given, the id is the folder name.
  const d = join(dir, "My Repo!");
  mkdirSync(d);
  assert.equal(agents.ensureProject({ name: "x", root: d, github: null }), "my-repo");
});

test("SR-B-08 [T-S1.3 T-X2.13] pausing revokes in the same transaction", (t) => {
  const { agents, secrets } = fresh(t);
  team(agents, "alpha", "ana");
  const s = secrets.issue("alpha/ana");
  agents.setStatus("alpha", "ana", "paused", DASHBOARD_ACTOR);
  assert.deepEqual(secrets.authenticate(s), { ok: false, reason: "revoked", companyAgentId: "alpha/ana" });
  agents.setStatus("alpha", "ana", "active", DASHBOARD_ACTOR);
  assert.equal(secrets.authenticate(s).ok, false);
  assert.equal(secrets.hasLive("alpha/ana"), false);
});

test("retiring revokes the secret and is final", (t) => {
  const { agents, secrets, db } = fresh(t);
  team(agents, "alpha", "ana");
  const s = secrets.issue("alpha/ana");
  agents.setStatus("alpha", "ana", "retired", DASHBOARD_ACTOR);
  assert.deepEqual(secrets.authenticate(s), { ok: false, reason: "revoked", companyAgentId: "alpha/ana" });
  assert.equal(db.prepare("SELECT retired_at FROM agents WHERE id = 'alpha/ana'").get<{ retired_at: string }>()?.retired_at, NOW);
  assert.throws(() => agents.setStatus("alpha", "ana", "active", DASHBOARD_ACTOR));
  assert.equal(agents.get("alpha", "ana")?.status, "retired");
});

test("a role change is stored and audited with the actor", (t) => {
  const { agents, audit } = fresh(t);
  team(agents, "alpha", "ana");
  agents.setRole("alpha", "lead", "builder", DASHBOARD_ACTOR);
  assert.equal(agents.get("alpha", "lead")?.role, "builder");
  assert.equal(agents.cto("alpha"), null);
  const row = audit.query({ action: "agent.role-changed" })[0];
  assert.equal(row.actorKind, "human");
  assert.equal(row.actorId, "owner");
  assert.deepEqual(row.data, { from: "cto", to: "builder" });
});

test("cto can be limited to agents in the current config", (t) => {
  const { agents } = fresh(t);
  team(agents, "alpha");
  agents.register("alpha", member("lead-2"), "cto", DASHBOARD_ACTOR, "dashboard");
  assert.equal(agents.cto("alpha")?.agentId, "lead");
  assert.equal(agents.cto("alpha", (id) => id === "lead-2")?.agentId, "lead-2");
});

test("register can name the manager, so a new team's builders report to its own CTO", (t) => {
  const { agents } = fresh(t);
  team(agents, "alpha");
  agents.register("alpha", member("lead-2"), "cto", DASHBOARD_ACTOR, "dashboard");
  const b = agents.register("alpha", member("ana-2"), "builder", DASHBOARD_ACTOR, "dashboard", {}, "alpha/lead-2");
  assert.equal(b.managerId, "alpha/lead-2");
});

test("a repo in a reused folder name is a new project unless its GitHub remote matches", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hq reused "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [old, other, same, none] = ["old/site", "other/site", "same/site", "none/site"].map((n) => join(dir, n));
  for (const p of [old, other, same, none]) mkdirSync(p, { recursive: true });
  const { agents, audit, db } = fresh(t, []);
  assert.equal(agents.ensureProject({ name: "site", root: old, github: "acme/site" }), "site");
  settingsGithub(db, "site", "acme/site");
  rmSync(old, { recursive: true });

  assert.equal(agents.ensureProject({ name: "site", root: other, github: "acme/other" }), "site-2");
  assert.equal(audit.query({ action: "project.moved" }).length, 0);
  assert.equal(agents.ensureProject({ name: "site", root: same, github: "ACME/site" }), "site");
  const moved = audit.query({ action: "project.moved" });
  assert.equal(moved.length, 1);
  assert.deepEqual(moved[0].data, { from: old, to: same });
  assert.equal(agents.ensureProject({ name: "site", root: none, github: null }), "site-3");
});

test("a project with no stored GitHub repo is never taken over by a folder of the same name", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hq reused "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [old, next] = ["old/site", "next/site"].map((n) => join(dir, n));
  for (const p of [old, next]) mkdirSync(p, { recursive: true });
  const { agents } = fresh(t, []);
  assert.equal(agents.ensureProject({ name: "site", root: old, github: "acme/site" }), "site"); // no settings row yet
  rmSync(old, { recursive: true });
  assert.equal(agents.ensureProject({ name: "site", root: next, github: "acme/site" }), "site-2");
});

test("an agent whose session name another project's agent already has is refused", (t) => {
  const { agents, db } = fresh(t, ["a", "a-b"]);
  agents.register("a", member("b-c"), "builder", DASHBOARD_ACTOR, "dashboard");
  const before = JSON.stringify(db.prepare("SELECT * FROM agents ORDER BY rowid").all());
  assert.throws(() => agents.register("a-b", member("c"), "builder", DASHBOARD_ACTOR, "dashboard"), /session name hq-a-b-c/);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM agents ORDER BY rowid").all()), before);
  // A different id in the same project is fine.
  agents.register("a-b", member("d"), "builder", DASHBOARD_ACTOR, "dashboard");
});

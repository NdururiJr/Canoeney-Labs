import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentRegistry, companyAgentId } from "./agents";
import { AgentSecrets } from "./agentSecrets";
import { SqliteAuditSink } from "./audit";
import { FakeClock } from "./clock";
import { openCompanyDb } from "./db";

/** A logged-in human, as dashboard commands pass it (M0-C). */
const DASHBOARD_ACTOR = { kind: "human", id: "owner" } as const;
const NOW = "2026-11-12T08:00:00.000Z";

function fresh(t: { after(fn: () => void): void }, slugs = ["alpha"]) {
  const db = openCompanyDb(":memory:");
  t.after(() => db.close());
  const clock = new FakeClock(NOW);
  const audit = new SqliteAuditSink(db, clock);
  const secrets = new AgentSecrets(db, clock, audit);
  const agents = new AgentRegistry(db, clock, audit, secrets);
  for (const slug of slugs) agents.ensureProject({ slug, name: slug, root: join(tmpdir(), `repo-${slug}`) });
  return { db, clock, audit, secrets, agents };
}

const member = (id: string, isLead = false) => ({ id, name: id[0].toUpperCase() + id.slice(1), cli: "claude" as const, isLead });

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

test("first sync imports the lead as cto and workers as builders", (t) => {
  const { agents } = fresh(t);
  // The lead is listed after a builder on purpose: it is still registered first.
  const r = agents.syncFromConfig("alpha", [member("ana"), member("lead", true), member("ben")]);
  assert.deepEqual(r.ignoredLead, []);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.registered.length, 3);
  assert.equal(agents.cto("alpha")?.companyId, "alpha/lead");
  for (const id of ["ana", "ben"]) {
    const a = agents.get("alpha", id);
    assert.equal(a?.role, "builder");
    assert.equal(a?.managerId, "alpha/lead");
    assert.equal(a?.status, "active");
  }
  assert.equal(agents.get("alpha", "lead")?.managerId, null);
});

test("first sync with two isLead agents makes one cto", (t) => {
  const { agents } = fresh(t);
  const r = agents.syncFromConfig("alpha", [member("lead", true), member("ana", true)]);
  assert.equal(agents.get("alpha", "lead")?.role, "cto");
  assert.equal(agents.get("alpha", "ana")?.role, "builder");
  assert.deepEqual(r.ignoredLead, ["ana"]);
});

test("retired rows keep the import closed", (t) => {
  const { agents } = fresh(t);
  agents.syncFromConfig("alpha", [member("lead", true), member("ana")]);
  agents.setStatus("alpha", "lead", "retired", DASHBOARD_ACTOR);
  agents.setStatus("alpha", "ana", "retired", DASHBOARD_ACTOR);
  const r = agents.syncFromConfig("alpha", [member("lead", true), member("ana"), member("cara", true)]);
  assert.equal(agents.get("alpha", "cara")?.role, "builder");
  assert.deepEqual(r.ignoredLead, ["cara"]);
  assert.equal(agents.cto("alpha"), null);
});

test("a config id that fails the pattern is skipped", (t) => {
  const { agents } = fresh(t);
  const r = agents.syncFromConfig("alpha", [member("../x"), member("ana")]);
  assert.deepEqual(r.skipped, ["../x"]);
  assert.equal(agents.get("alpha", "ana")?.role, "builder");
  assert.equal(agents.list("alpha").length, 1);
});

test("SR-B-14 [T-S1.7 T-S7.1] a later isLead in config does not make a cto", (t) => {
  const { agents, audit } = fresh(t);
  agents.syncFromConfig("alpha", [member("lead", true), member("ana")]);
  const r = agents.syncFromConfig("alpha", [member("lead", true), member("ana", true), member("cara", true)]);
  assert.equal(agents.get("alpha", "cara")?.role, "builder");
  assert.equal(agents.get("alpha", "ana")?.role, "builder");
  assert.deepEqual(r.ignoredLead, ["cara"]);
  const row = audit.query({ action: "agent.registered" }).find((e) => e.target === "alpha/cara");
  assert.equal(row?.data.ignoredIsLead, true);
  assert.equal(row?.data.source, "config");
  assert.equal(agents.cto("alpha")?.agentId, "lead");
});

test("same agent id in two projects registers twice", (t) => {
  const { agents } = fresh(t, ["alpha", "beta"]);
  agents.syncFromConfig("alpha", [member("lead", true)]);
  agents.syncFromConfig("beta", [member("lead", true)]);
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
  assert.equal(agents.ensureProject({ slug: "alpha", name: "alpha", root: a }), "alpha");
  assert.equal(agents.ensureProject({ slug: "alpha", name: "alpha", root: a }), "alpha"); // same root: nothing happens
  assert.equal(agents.ensureProject({ slug: "alpha", name: "alpha", root: b }), "alpha-2"); // repo a still exists
  assert.equal(agents.projectForRoot(b), "alpha-2");
  rmSync(a, { recursive: true });
  assert.equal(agents.ensureProject({ slug: "alpha", name: "alpha", root: c }), "alpha"); // a was moved to c
  assert.equal(db.prepare("SELECT repo FROM projects WHERE id = 'alpha'").get<{ repo: string }>()?.repo, c);
  const moved = audit.query({ action: "project.moved" });
  assert.equal(moved.length, 1);
  assert.deepEqual(moved[0].data, { from: a, to: c });
  assert.equal(audit.query({ action: "project.registered" }).length, 2);
  // With no slug given, the id is the folder name.
  const d = join(dir, "My Repo!");
  mkdirSync(d);
  assert.equal(agents.ensureProject({ name: "x", root: d }), "my-repo");
});

test("SR-B-08 [T-S1.3 T-X2.13] pausing revokes in the same transaction", (t) => {
  const { agents, secrets } = fresh(t);
  agents.syncFromConfig("alpha", [member("lead", true), member("ana")]);
  const s = secrets.issue("alpha/ana");
  agents.setStatus("alpha", "ana", "paused", DASHBOARD_ACTOR);
  assert.deepEqual(secrets.authenticate(s), { ok: false, reason: "revoked", companyAgentId: "alpha/ana" });
  agents.setStatus("alpha", "ana", "active", DASHBOARD_ACTOR);
  assert.equal(secrets.authenticate(s).ok, false);
  assert.equal(secrets.hasLive("alpha/ana"), false);
});

test("retiring revokes the secret and is final", (t) => {
  const { agents, secrets, db } = fresh(t);
  agents.syncFromConfig("alpha", [member("lead", true), member("ana")]);
  const s = secrets.issue("alpha/ana");
  agents.setStatus("alpha", "ana", "retired", DASHBOARD_ACTOR);
  assert.deepEqual(secrets.authenticate(s), { ok: false, reason: "revoked", companyAgentId: "alpha/ana" });
  assert.equal(db.prepare("SELECT retired_at FROM agents WHERE id = 'alpha/ana'").get<{ retired_at: string }>()?.retired_at, NOW);
  assert.throws(() => agents.setStatus("alpha", "ana", "active", DASHBOARD_ACTOR));
  assert.equal(agents.get("alpha", "ana")?.status, "retired");
});

test("a role change is stored and audited with the actor", (t) => {
  const { agents, audit } = fresh(t);
  agents.syncFromConfig("alpha", [member("lead", true), member("ana")]);
  agents.setRole("alpha", "lead", "builder", DASHBOARD_ACTOR);
  assert.equal(agents.get("alpha", "lead")?.role, "builder");
  assert.equal(agents.cto("alpha"), null);
  const row = audit.query({ action: "agent.role-changed" })[0];
  assert.equal(row.actorKind, "human");
  assert.equal(row.actorId, "owner");
  assert.deepEqual(row.data, { from: "cto", to: "builder" });
});

test("sync reports config agents whose rows are paused or retired", (t) => {
  const { agents } = fresh(t);
  agents.syncFromConfig("alpha", [member("lead", true), member("ana"), member("ben")]);
  agents.setStatus("alpha", "ana", "paused", DASHBOARD_ACTOR);
  agents.setStatus("alpha", "ben", "retired", DASHBOARD_ACTOR);
  const r = agents.syncFromConfig("alpha", [member("lead", true), member("ana"), member("ben")]);
  assert.deepEqual(r.inactive, [
    { id: "ana", status: "paused" },
    { id: "ben", status: "retired" },
  ]);
});

test("cto can be limited to agents in the current config", (t) => {
  const { agents } = fresh(t);
  agents.syncFromConfig("alpha", [member("lead", true)]);
  agents.register("alpha", member("lead-2"), "cto", DASHBOARD_ACTOR, "dashboard");
  assert.equal(agents.cto("alpha")?.agentId, "lead");
  assert.equal(agents.cto("alpha", (id) => id === "lead-2")?.agentId, "lead-2");
});

test("register can name the manager, so a new team's builders report to its own CTO", (t) => {
  const { agents } = fresh(t);
  agents.syncFromConfig("alpha", [member("lead", true)]);
  agents.register("alpha", member("lead-2"), "cto", DASHBOARD_ACTOR, "dashboard");
  const b = agents.register("alpha", member("ana-2"), "builder", DASHBOARD_ACTOR, "dashboard", {}, "alpha/lead-2");
  assert.equal(b.managerId, "alpha/lead-2");
});

// PR #12 review, round 1: the blocking findings on confirmRepo and Local mode.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { CommandCtx } from "./dashboard";
import { ProjectRefusedError } from "./hqSource";
import { Projects } from "./projects";
import { makeHq, openTestRuntime, OWNER_PIN } from "./testing/hqFixture";

const owner = (projectId: string | null): CommandCtx => ({ actor: { kind: "human", id: "owner" }, role: "owner", remote: false, sessionId: "s1", projectId });
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir });
const PIN = { via: "pin", humanId: "owner" } as const;

test("SR-D-05 confirming a project whose folder now holds HQ's own source is refused, and nothing is stored", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  const site = join(hq.scratch, "site");
  mkdirSync(site);
  git(site, "init", "-q");
  git(site, "remote", "add", "origin", "https://github.com/acme/site.git");
  await hq.dashboard.dispatch(owner(hq.slug), { cmd: "addProject", args: [site], pin: OWNER_PIN });
  hq.company.settings.create("site", { github: "acme/site", workflow: hq.hub.snap.config.workflow }, PIN);
  // The folder's origin becomes HQ's own repo; HQ restarts.
  git(site, "remote", "set-url", "origin", "https://github.com/jsmastery-pro/jsm-hq.git");
  const restarted = new Projects(hq.company, (r, s) => openTestRuntime(hq.company, r, s));
  t.after(() => restarted.stopAll());
  await restarted.openAll();
  await assert.rejects(restarted.confirmRepo("site", PIN), (err: unknown) => err instanceof ProjectRefusedError);
  assert.equal(restarted.get("site"), null, "not opened");
  assert.equal(hq.company.db.prepare("SELECT github FROM project_settings WHERE project_id = 'site'").get<{ github: string }>()?.github, "acme/site", "stored repo unchanged");
  assert.equal(hq.company.audit.query({ action: "project.repo-confirmed" }).length, 0);
  const refused = hq.company.audit.query({ action: "project.refused" }).filter((r) => r.target === site || String(r.target).endsWith("site"));
  assert.ok(refused.length >= 1, "a project.refused row");
});

test("SR-D-05 confirming a project inside HQ's home is refused, and nothing is stored", async (t) => {
  const hq = await makeHq(t);
  const inside = join(process.env.HQ_HOME!, "kept-here");
  mkdirSync(inside, { recursive: true });
  git(inside, "init", "-q");
  git(inside, "remote", "add", "origin", "https://github.com/acme/kept.git");
  hq.company.agents.ensureProject({ slug: "kept", name: "kept", root: inside, github: "acme/old-kept" });
  await hq.projects.openAll();
  await assert.rejects(hq.projects.confirmRepo("kept", PIN), (err: unknown) => err instanceof ProjectRefusedError && err.reason === "hq-home");
  assert.equal(hq.projects.get("kept"), null, "not opened");
  assert.equal(hq.company.audit.query({ action: "project.repo-confirmed" }).length, 0);
  const rows = hq.company.audit.query({ action: "project.refused" });
  assert.deepEqual(rows.map((r) => r.data.reason), ["hq-home"]);
});

test("SR-E-06 an agent stored in Local mode can be switched to Sandbox without the PIN", async (t) => {
  const hq = await makeHq(t);
  hq.company.db.prepare("UPDATE agent_settings SET mode = 'local' WHERE agent_id = ?").run(`${hq.slug}/ana`);
  hq.company.settings.updateAgent(`${hq.slug}/ana`, { mode: "sandbox" }, { via: "session", humanId: "owner" });
  assert.equal(hq.company.db.prepare("SELECT mode FROM agent_settings WHERE agent_id = ?").get<{ mode: string }>(`${hq.slug}/ana`)?.mode, "sandbox");
});

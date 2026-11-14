import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openCompany } from "./company";
import type { CommandCtx } from "./dashboard";
import { hqSourceRoot } from "./hqSource";
import { startHq } from "./startHq";
import { newAgent } from "./store";
import { makeHq, mcpCall, openTestRuntime, openWs, OWNER_PIN, seedProject, writeRepoFiles } from "./testing/hqFixture";

const BETA_TEAM = [newAgent("zed", "Zed", "Lead", "#ff77a8", true), newAgent("yan", "Yan", "Developer", "#29adff", false)];

const ownerCtx = (projectId: string | null): CommandCtx => ({ actor: { kind: "human", id: "owner" }, role: "owner", remote: false, sessionId: "s1", projectId });

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

/** Waits for a frame matching `pick` among those collected after `from`. */
async function frame(frames: Record<string, unknown>[], from: number, pick: (f: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const f = frames.slice(from).find(pick);
    if (f) return f;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no such frame");
}

const teamOf = (f: Record<string, unknown>) => ((f.snapshot as { config: { team: { id: string }[] } }).config.team.map((a) => a.id));

test("two projects run side by side: each view shows only its own team and board", async (t) => {
  const hq = await makeHq(t, { extraProjects: [{ slug: "beta", team: BETA_TEAM }] });
  const cookie = await hq.sessionCookie();
  const { ws, frames } = await openWs(hq, { cookie, origin: "http://hq.test" });
  assert.ok(ws);
  t.after(() => ws.close());
  const first = await frame(frames, 0, (f) => f.type === "snapshot");
  assert.equal((first.snapshot as { projectId: string }).projectId, hq.slug);
  assert.deepEqual(teamOf(first), ["lead", "ana", "ben"]);
  assert.deepEqual(
    (first.snapshot as { projects: { id: string; state: string }[] }).projects.map((p) => [p.id, p.state]),
    [[hq.slug, "open"], ["beta", "open"]],
  );

  const at = frames.length;
  ws.send(JSON.stringify({ type: "select", projectId: "beta" }));
  const second = await frame(frames, at, (f) => f.type === "snapshot");
  assert.equal((second.snapshot as { projectId: string }).projectId, "beta");
  assert.deepEqual(teamOf(second), ["zed", "yan"]);

  const after = frames.length;
  hq.hub.setStatus("ana", { state: "working" } as never); // the first project: not this view's
  hq.runtime("beta").hub.setStatus("yan", { state: "working" } as never);
  const update = await frame(frames, after, (f) => f.type === "agent.updated");
  assert.equal((update.agent as { agentId: string }).agentId, "yan");
  assert.equal(frames.slice(after).filter((f) => f.type === "agent.updated" && (f.agent as { agentId: string }).agentId === "ana").length, 0);
});

test("/mcp from an agent of project B is served by project B's runtime", async (t) => {
  const hq = await makeHq(t, { extraProjects: [{ slug: "beta", team: BETA_TEAM }] });
  const beta = hq.runtime("beta");
  const board = beta.planner.createBoard("Beta board");
  beta.planner.createTask({ title: "Beta task", boardId: board.id }, "zed");
  hq.planner.createTask({ title: "Alpha task", boardId: hq.planner.defaultBoard().id }, "lead");
  const secret = hq.company.secrets.issue("beta/zed");
  const r = await mcpCall(hq, secret, "list_tasks");
  assert.equal(r.status, 200);
  const text = r.json?.result?.content[0].text ?? "";
  assert.match(text, /Beta task/);
  assert.doesNotMatch(text, /Alpha task/);
});

test("adding HQ's own source from the dashboard is refused", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  const before = hq.projects.list().length;
  const r = await hq.dashboard.dispatch(ownerCtx(hq.slug), { cmd: "addProject", args: [hqSourceRoot()], pin: OWNER_PIN });
  assert.deepEqual(r, { ok: false, error: "failed" });
  const refused = hq.company.audit.query({ action: "project.refused" });
  assert.equal(refused.length, 1);
  assert.equal(refused[0].actorId, "owner");
  assert.equal(refused[0].data.reason, "hq-folder");
  assert.equal(hq.projects.list().length, before);
});

test("addProject needs the owner's PIN, and its row names the authority", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  const site = gitRepo(join(hq.scratch, "site"));
  assert.deepEqual(await hq.dashboard.dispatch(ownerCtx(hq.slug), { cmd: "addProject", args: [site] }), { ok: false, error: "pin-required" });
  const sup: CommandCtx = { ...ownerCtx(hq.slug), actor: { kind: "human", id: "sup1" }, role: "supervisor" };
  assert.deepEqual(await hq.dashboard.dispatch(sup, { cmd: "addProject", args: [site], pin: OWNER_PIN }), { ok: false, error: "forbidden" });
  assert.equal(hq.projects.list().length, 1);

  assert.deepEqual(await hq.dashboard.dispatch(ownerCtx(hq.slug), { cmd: "addProject", args: [site], pin: OWNER_PIN }), { ok: true });
  const row = hq.company.audit.query({ action: "project.registered" }).find((e) => e.target === "site");
  assert.equal(row?.actorId, "owner");
  assert.equal(row?.data.authority, "pin");
  assert.deepEqual(hq.projects.list().find((p) => p.id === "site")?.state, "open");
  assert.ok(hq.projects.get("site"));
});

test("a folder inside HQ's home cannot be added as a project", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  const clone = gitRepo(join(process.env.HQ_HOME!, hq.slug, "ana"));
  const r = await hq.dashboard.dispatch(ownerCtx(hq.slug), { cmd: "addProject", args: [clone], pin: OWNER_PIN });
  assert.deepEqual(r, { ok: false, error: "failed" });
  assert.equal(hq.company.audit.query({ action: "project.refused" })[0]?.data.reason, "hq-home");
  assert.equal(hq.projects.list().length, 1);
});

test("a project whose folder is gone is listed as missing and none of its agents start", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  const gone = hq.company.agents.ensureProject({ slug: "gone", name: "gone", root: join(hq.scratch, "gone"), github: null });
  seedProject(hq.company, gone, BETA_TEAM, hq.hub.snap.config.workflow);
  await hq.projects.openAll();
  assert.equal(hq.projects.list().find((p) => p.id === "gone")?.state, "missing");
  assert.equal(hq.projects.get("gone"), null);
  assert.deepEqual(await hq.dashboard.dispatch(ownerCtx("gone"), { cmd: "startAgent", args: ["zed"] }), { ok: false, error: "failed" });
});

test("a project registered from HQ's own source is listed as such and not opened", async (t) => {
  const hq = await makeHq(t);
  hq.company.agents.ensureProject({ slug: "hq-own", name: "hq-own", root: hqSourceRoot(), github: null });
  await hq.projects.openAll();
  assert.equal(hq.projects.list().find((p) => p.id === "hq-own")?.state, "hq-source");
  assert.equal(hq.projects.get("hq-own"), null);
});

// ---------------------------------------------------------------- startHq

/** Temporary HQ homes; `stopping` runs before they are removed (Windows will not delete an open store). */
function hqHomes(t: TestContext): { dir: string; stopping(fn: () => void): void } {
  const dir = mkdtempSync(join(tmpdir(), "hq start "));
  const saved = { HQ_COMPANY_HOME: process.env.HQ_COMPANY_HOME, HQ_HOME: process.env.HQ_HOME };
  const stops: (() => void)[] = [];
  process.env.HQ_COMPANY_HOME = join(dir, "company home");
  process.env.HQ_HOME = join(dir, "hq home");
  t.after(() => {
    for (const fn of stops.reverse()) fn();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, stopping: (fn) => stops.push(fn) };
}

const START = { port: 0, dev: false, distDir: null, uiOrigin: "http://hq.test", extraOrigins: [], openRuntime: openTestRuntime };

test("HQ started in its own source registers nothing and opens the stored projects", async (t) => {
  const { dir, stopping } = hqHomes(t);
  await assert.rejects(startHq({ ...START, start: hqSourceRoot() }), /No project to open\. Run HQ in your project's repo, or pass --repo <path>\./);

  const site = gitRepo(join(dir, "site"));
  const c = openCompany({ home: process.env.HQ_COMPANY_HOME!, repoRoot: null });
  c.agents.ensureProject({ name: "site", root: site, github: null });
  c.close();
  const hq = await startHq({ ...START, start: hqSourceRoot() });
  stopping(() => hq.close());
  assert.deepEqual(hq.projects.list().map((p) => [p.id, p.state]), [["site", "open"]]);
  const company = hq.projects.company;
  assert.equal(company.audit.query({ action: "project.registered" }).length, 1); // the one stored before
  const started = company.audit.query({ action: "hq.started" });
  assert.deepEqual(started[0]?.data.projects, ["site"]);
});

test("HQ starts from a folder that is not a repo when the store has projects", async (t) => {
  const { dir, stopping } = hqHomes(t);
  const site = gitRepo(join(dir, "site"));
  const c = openCompany({ home: process.env.HQ_COMPANY_HOME!, repoRoot: null });
  c.agents.ensureProject({ name: "site", root: site, github: null });
  c.close();
  const plain = join(dir, "plain");
  mkdirSync(plain);
  const hq = await startHq({ ...START, start: plain });
  stopping(() => hq.close());
  assert.equal(hq.projects.defaultId(), "site");
});

test("SR-D-01 [T-S7.1] startHq ignores the repo's .jsmhq files", async (t) => {
  const { dir, stopping } = hqHomes(t);
  const repo = gitRepo(join(dir, "carrier"));
  writeRepoFiles(repo, {
    config: { project: { id: "victim", name: "Carrier" }, team: [{ id: "mallory", name: "Mallory", isLead: true, sandbox: { allow: ["*"] } }] },
    plan: { boards: [{ id: "b1", title: "From the repo", status: "active" }] as never, tasks: [] },
  });
  const hq = await startHq({ ...START, start: repo });
  stopping(() => hq.close());
  const id = hq.projects.defaultId()!;
  assert.equal(id, "carrier"); // from the folder, never from the file
  const rt = hq.projects.get(id)!;
  assert.deepEqual(rt.hub.snap.config.team, []);
  assert.equal(rt.hub.snap.boards.some((b) => b.title === "From the repo"), false);
  assert.equal(rt.hub.snap.welcome, true);
  assert.equal(hq.projects.company.settings.has(id), false);
});

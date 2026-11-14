// Fixes from M0-D2's final whole-branch review: each test reproduces one finding.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openCompany } from "./company";
import { FakeClock } from "./company/clock";
import { Dashboard, type CommandCtx } from "./dashboard";
import { hqSourceRoot } from "./hqSource";
import type { RunResult } from "./lib/exec";
import { Sbx } from "./sbx";
import { Projects } from "./projects";
import { startHq } from "./startHq";
import { newAgent } from "./store";
import { makeHq, openTestRuntime, openWs, OWNER_PIN } from "./testing/hqFixture";
import { withSessions } from "./testing/sessionFixture";
import { trackedHqFiles } from "./agentIsolation";
import { ensureWorkspace, WorkspaceRefusedError } from "./workspace";

const OWNER = { kind: "human", id: "owner" } as const;
const ownerCtx = (projectId: string | null): CommandCtx => ({ actor: OWNER, role: "owner", remote: false, sessionId: "s1", projectId });

function git(dir: string, ...args: string[]) {
  execFileSync("git", args, { cwd: dir });
}

function hqHomes(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "hq review "));
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
  return { dir, stopping: (fn: () => void) => stops.push(fn) };
}

const START = { port: 0, dev: false, distDir: null, uiOrigin: "http://hq.test", extraOrigins: [], openRuntime: openTestRuntime };

test("HQ with no project it can open stops and says which projects it could not open", async (t) => {
  hqHomes(t);
  const c = openCompany({ home: process.env.HQ_COMPANY_HOME!, repoRoot: null });
  c.agents.ensureProject({ slug: "hq-own", name: "hq-own", root: hqSourceRoot(), github: null });
  c.close();
  await assert.rejects(startHq({ ...START, start: hqSourceRoot() }), /No project could be opened \(hq-own: HQ's own source\)\. Run HQ in your project's repo, or pass --repo <path>\./);
});

test("a second HQ on a port in use starts none of its projects", async (t) => {
  const { dir } = hqHomes(t);
  const site = join(dir, "site");
  mkdirSync(site);
  git(site, "init", "-q");
  const busy = createServer();
  await new Promise<void>((r) => busy.listen(0, "127.0.0.1", () => r()));
  t.after(() => busy.close());
  const port = (busy.address() as { port: number }).port;
  const started: string[] = [];
  const openRuntime: typeof openTestRuntime = async (c, r, s) => {
    const rt = await openTestRuntime(c, r, s);
    rt.start = () => void started.push(s);
    return rt;
  };
  await assert.rejects(startHq({ ...START, port, start: site, openRuntime }), /EADDRINUSE/);
  assert.deepEqual(started, [], "nothing polls or reattaches before HQ is serving");
});

test("every snapshot a connection gets names its project and the project list", async (t) => {
  const hq = await makeHq(t, { extraProjects: [{ slug: "beta", team: [newAgent("zed", "Zed", "Lead", "#ff77a8", true)] }] });
  const { ws, frames } = await openWs(hq, { cookie: await hq.sessionCookie(), origin: "http://hq.test" });
  assert.ok(ws);
  t.after(() => ws.close());
  for (let i = 0; i < 100 && !frames.some((f) => f.type === "snapshot"); i++) await new Promise((r) => setTimeout(r, 10));
  const at = frames.length;
  // What completing the welcome or an import sends: the hub's own snapshot.
  hq.hub.emit({ type: "snapshot", snapshot: structuredClone(hq.hub.snap) });
  let f: Record<string, unknown> | undefined;
  for (let i = 0; i < 100 && !(f = frames.slice(at).find((x) => x.type === "snapshot")); i++) await new Promise((r) => setTimeout(r, 10));
  const snap = f!.snapshot as { projectId?: string; projects?: unknown[] };
  assert.equal(snap.projectId, hq.slug);
  assert.equal(snap.projects?.length, 2);
});

test("a refused addProject tells the owner why", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  const r = await hq.dashboard.dispatch(ownerCtx(hq.slug), { cmd: "addProject", args: [hqSourceRoot()], pin: OWNER_PIN });
  assert.equal(r.ok, false);
  assert.match((r as { message?: string }).message ?? "", /HQ never manages its own source/);
  const typo = await hq.dashboard.dispatch(ownerCtx(hq.slug), { cmd: "addProject", args: [join(hq.scratch, "no such folder")], pin: OWNER_PIN });
  assert.match((typo as { message?: string }).message ?? "", /not a git repository/);
});

test("HQ's own files tracked in a chosen subfolder are still refused", async (t) => {
  const hq = await makeHq(t);
  const repo = join(hq.scratch, "owner checkout");
  mkdirSync(join(repo, "sub"), { recursive: true });
  git(repo, "init", "-q");
  writeFileSync(join(repo, "sub", ".jsmhq-role.md"), "committed by mistake");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  const agent = { ...newAgent("ana", "Ana", "Developer", "#000000", false), workspacePath: join(repo, "sub") };
  await assert.rejects(ensureWorkspace(agent, hq.slug, hq.hub.repo), (err: unknown) => err instanceof WorkspaceRefusedError && err.reason === "hq-file");
});

test("SR-D-06 [T-S3.10] a company-level agent does not start when sbx's keys cannot be read", async (t) => {
  const hq = await makeHq(t);
  const s = withSessions(t, hq);
  hq.hub.snap.setup = { ...hq.hub.snap.setup, sandboxReady: true };
  hq.company.agents.setRole(hq.slug, "ana", "ceo", OWNER);
  hq.hub.cfg("ana")!.mode = "sandbox";
  const exec = async (_cmd: string, args: string[]): Promise<RunResult> =>
    args[0] === "secret" ? { ok: false, code: 1, stdout: "", stderr: "timed out" } : { ok: true, code: 0, stdout: "[]", stderr: "" };
  const sbx = new Sbx(hq.hub, hq.company, { exec });
  s.sessions.githubKeyFor = async (id) => {
    await sbx.refresh();
    return sbx.githubKeyFor(id);
  };
  Object.assign(s.sessions as unknown as Record<string, unknown>, { policyOk: true, sandboxExists: async () => false, whenSandboxExists: async () => false, refreshSandboxSizes: async () => {} });
  await s.sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.equal(s.backend.live.has(s.name("ana")), false);
  assert.deepEqual(hq.company.audit.query({ action: "workspace.refused" }).map((r) => [r.actorId, r.data.reason]), [["owner", "keys-unread"]]);
});

test("terminal input to two projects' same-named agents is audited per project", async () => {
  const rows: { target: string | null; data: Record<string, unknown> }[] = [];
  const d = new Dashboard(
    { sendTerminalInput: { role: "owner", audit: "collapsed", target: (a) => String(a[0]), run: () => {} } },
    { ownerAuth: {} as never, audit: { append: (r: { target?: string | null; data?: Record<string, unknown> }) => void rows.push({ target: r.target ?? null, data: r.data ?? {} }) } as never, clock: new FakeClock("2026-11-14T08:00:00.000Z") },
  );
  await d.dispatch(ownerCtx("x"), { cmd: "sendTerminalInput", args: ["ana", "ls\r"] });
  await d.dispatch(ownerCtx("y"), { cmd: "sendTerminalInput", args: ["ana", "ls\r"] });
  d.flush(true);
  assert.deepEqual(rows.map((r) => [r.target, r.data.project, r.data.count]).sort(), [["ana", "x", 1], ["ana", "y", 1]]);
});

test("a folder that now holds a different GitHub repo is not opened as the old project", async (t) => {
  const hq = await makeHq(t);
  const site = join(hq.scratch, "site");
  mkdirSync(site);
  git(site, "init", "-q");
  git(site, "remote", "add", "origin", "https://github.com/acme/site.git");
  await hq.enroll();
  assert.deepEqual(await hq.dashboard.dispatch(ownerCtx(hq.slug), { cmd: "addProject", args: [site], pin: OWNER_PIN }), { ok: true });
  hq.company.settings.create("site", { github: "acme/site", workflow: hq.hub.snap.config.workflow }, { via: "pin", humanId: "owner" });
  // HQ stops; the folder is deleted and re-cloned from another repo; HQ starts again.
  git(site, "remote", "set-url", "origin", "https://github.com/acme/other.git");
  const restarted = new Projects(hq.company, (r, s) => openTestRuntime(hq.company, r, s));
  t.after(() => restarted.stopAll());
  await restarted.openAll();
  assert.equal(restarted.get("site"), null);
  assert.equal(restarted.list().find((p) => p.id === "site")?.state, "missing");
});

test("HQ's own tracked files are found through a Windows short (8.3) path too", { skip: process.platform !== "win32" && "short paths exist only on Windows" }, async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "hq long name "));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "sub"));
  git(repo, "init", "-q");
  writeFileSync(join(repo, ".jsmhq-role.md"), "x");
  writeFileSync(join(repo, "sub", ".jsmhq-role.md"), "x");
  git(repo, "add", ".");
  const short = execFileSync("powershell", ["-NoProfile", "-Command", `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${repo}').ShortPath`], { encoding: "utf8" }).trim();
  if (!short || short.toLowerCase() === repo.toLowerCase()) {
    t.skip("this volume has no short names");
    return;
  }
  assert.deepEqual(await trackedHqFiles(short), [".jsmhq-role.md"]);
  assert.deepEqual(await trackedHqFiles(join(short, "sub")), [".jsmhq-role.md"]);
});

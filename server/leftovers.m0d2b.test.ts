// The M0-D2 follow-ups that M0-E Task 8 closes (PR #10 review and deferred minors).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openCompany } from "./company";
import type { CommandCtx } from "./dashboard";
import { githubOf } from "./hqSource";
import { Projects } from "./projects";
import { readImport } from "./repoConfigImport";
import type { RepoInfo } from "./repo";
import { Sessions } from "./sessions";
import { startHq } from "./startHq";
import { makeHq, openTestRuntime, openWs, OWNER_PIN } from "./testing/hqFixture";

const owner = (projectId: string | null): CommandCtx => ({ actor: { kind: "human", id: "owner" }, role: "owner", remote: false, sessionId: "s1", projectId });
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir });

test("a renamed repo can be confirmed with the PIN, and only with it", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  const site = join(hq.scratch, "site");
  mkdirSync(site);
  git(site, "init", "-q");
  git(site, "remote", "add", "origin", "https://github.com/acme/site.git");
  await hq.dashboard.dispatch(owner(hq.slug), { cmd: "addProject", args: [site], pin: OWNER_PIN });
  hq.company.settings.create("site", { github: "acme/site", workflow: hq.hub.snap.config.workflow }, { via: "pin", humanId: "owner" });
  // The repo was renamed on GitHub and its origin updated; HQ restarts.
  git(site, "remote", "set-url", "origin", "https://github.com/acme/site-renamed.git");
  const restarted = new Projects(hq.company, (r, s) => openTestRuntime(hq.company, r, s));
  t.after(() => restarted.stopAll());
  await restarted.openAll();
  const listed = restarted.list().find((p) => p.id === "site");
  assert.deepEqual([listed?.state, listed?.note], ["missing", "the folder holds a different GitHub repo"]);
  await assert.rejects(restarted.confirmRepo("site", { via: "session", humanId: "owner" }), /PIN/);
  assert.equal(restarted.get("site"), null);
  await restarted.confirmRepo("site", { via: "pin", humanId: "owner" });
  assert.ok(restarted.get("site"));
  assert.equal(hq.company.db.prepare("SELECT github FROM project_settings WHERE project_id = 'site'").get<{ github: string }>()?.github, "acme/site-renamed");
  assert.equal(hq.company.audit.query({ action: "project.repo-confirmed" }).length, 1);
});

test("githubKeyFor is unknown until wired", async () => {
  // A runtime that forgets to wire it refuses a company-level start (keys-unread) instead of passing it.
  const s = new Sessions({ slug: "x", snap: {} } as never, {} as never);
  assert.equal(await s.githubKeyFor("ana"), "unknown");
});

test("a linked .jsmhq folder is not read", async (t) => {
  const hq = await makeHq(t, { unseeded: true });
  const outside = mkdtempSync(join(tmpdir(), "hq outside "));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "config.json"), JSON.stringify({ team: [] }));
  try {
    symlinkSync(outside, join(hq.repoRoot, ".jsmhq"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    return t.skip("this machine cannot create folder links");
  }
  assert.throws(() => readImport(hq.repoRoot, hq.company, hq.slug), /outside the repo|is a link/);
});

test("two adds of one path open one runtime", async (t) => {
  const hq = await makeHq(t);
  const site = join(hq.scratch, "site");
  mkdirSync(site);
  git(site, "init", "-q");
  let opened = 0;
  // Opening takes a while (setup checks), so both adds are in flight at once.
  const p = new Projects(hq.company, async (r, s) => {
    opened++;
    await new Promise((res) => setTimeout(res, 100));
    return openTestRuntime(hq.company, r, s);
  });
  t.after(() => p.stopAll());
  const by = { via: "pin", humanId: "owner" } as const;
  const [a, b] = await Promise.all([p.add(site, by), p.add(site, by)]);
  assert.equal(a, b);
  assert.equal(opened, 1);
});

function homes(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "hq start "));
  const saved = { HQ_COMPANY_HOME: process.env.HQ_COMPANY_HOME, HQ_HOME: process.env.HQ_HOME };
  process.env.HQ_COMPANY_HOME = join(dir, "company home");
  process.env.HQ_HOME = join(dir, "hq home");
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("an explicit --repo that is not a repo stops HQ", async (t) => {
  const dir = homes(t);
  const site = join(dir, "site");
  mkdirSync(site);
  git(site, "init", "-q");
  const c = openCompany({ home: process.env.HQ_COMPANY_HOME!, repoRoot: null });
  c.agents.ensureProject({ name: "site", root: site, github: null });
  c.close();
  const typo = join(dir, "no such folder");
  await assert.rejects(
    startHq({ start: typo, explicitRepo: true, port: 0, dev: false, distDir: null, uiOrigin: "http://hq.test", extraOrigins: [], openRuntime: openTestRuntime }),
    /is not a git repository/,
  );
});

test("a project inside HQ's home is labelled so", async (t) => {
  const hq = await makeHq(t);
  const inside = join(process.env.HQ_HOME!, "kept-here");
  mkdirSync(inside, { recursive: true });
  git(inside, "init", "-q");
  hq.company.agents.ensureProject({ slug: "kept", name: "kept", root: inside, github: null });
  await hq.projects.openAll();
  assert.equal(hq.projects.list().find((p) => p.id === "kept")?.note, "inside HQ's home");
});

test("selecting a project that is not open answers with the list", async (t) => {
  const hq = await makeHq(t);
  hq.company.agents.ensureProject({ slug: "gone", name: "gone", root: join(hq.scratch, "gone"), github: null });
  await hq.projects.openAll();
  const { ws, frames } = await openWs(hq, { cookie: await hq.sessionCookie(), origin: "http://hq.test" });
  assert.ok(ws);
  t.after(() => ws.close());
  for (let i = 0; i < 100 && !frames.some((f) => f.type === "snapshot"); i++) await new Promise((r) => setTimeout(r, 10));
  const at = frames.length;
  ws.send(JSON.stringify({ type: "select", projectId: "gone" }));
  let reply: Record<string, unknown> | undefined;
  for (let i = 0; i < 100 && !(reply = frames.slice(at).find((f) => f.type === "projects.updated")); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(reply, "the page hears why nothing changed");
});

test("add and the start repo use the injected detect", async (t) => {
  const hq = await makeHq(t);
  const seen: string[] = [];
  const fakeRoot = join(hq.scratch, "virtual repo");
  mkdirSync(fakeRoot);
  const detect = async (root: string): Promise<RepoInfo> => {
    seen.push(root);
    return { root: fakeRoot, name: "virtual", originUrl: null, github: null, remotes: [], hasCodeRabbit: false, hasInsta: false };
  };
  const p = new Projects(hq.company, (r, s) => openTestRuntime(hq.company, r, s), { detect });
  t.after(() => p.stopAll());
  await p.registerStart("/start/here");
  await p.add("/added/here", { via: "pin", humanId: "owner" });
  assert.deepEqual(seen, ["/start/here", "/added/here"]);
});

test("githubOf reads www and ssh-443 forms", () => {
  assert.equal(githubOf("https://www.github.com/acme/site.git"), "acme/site");
  assert.equal(githubOf("ssh://git@ssh.github.com:443/acme/site.git"), "acme/site");
  assert.equal(githubOf("https://www.gitlab.com/acme/site"), null);
});

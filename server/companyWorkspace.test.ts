// SR-D-06: company-level agents (CEO, CIO, Security & Audit) work in a folder
// that holds no repo, and their sandbox does not start while a GitHub
// credential can reach it (M0-D2 Task 5).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { COMPANY_ROLES, companyWorkspaceFor, ensureCompanyWorkspace, githubCredentialIn, workspaceKind } from "./companyWorkspace";
import { run } from "./lib/exec";
import { sessionName } from "./paths";
import { Sbx } from "./sbx";
import { makeHq, type Hq } from "./testing/hqFixture";
import { withSessions } from "./testing/sessionFixture";
import { WorkspaceRefusedError } from "./workspace";

const OWNER = { kind: "human", id: "owner" } as const;

/** A fake sbx: `secret ls` lists the given keys (scope "SANDBOX" is ana's sandbox); every call is recorded. */
function fakeSbx(hq: Hq, given: { scope: string; name: string }[]) {
  const keys = given.map((k) => ({ ...k, scope: k.scope === "SANDBOX" ? sessionName(hq.slug, "ana") : k.scope }));
  const calls: string[][] = [];
  const exec = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (args[0] === "secret" && args[1] === "ls") return { ok: true, code: 0, stdout: JSON.stringify({ secrets: keys.map((k) => ({ ...k, type: "service" })) }), stderr: "" };
    return { ok: true, code: 0, stdout: "", stderr: "" };
  }) as unknown as typeof run;
  return { sbx: new Sbx(hq.hub, hq.company, { exec }), calls };
}

/** ana as the CEO, in sandbox mode, with sessions whose sbx calls are stubbed. */
async function ceo(t: TestContext, keys: { scope: string; name: string }[] = []) {
  const hq = await makeHq(t);
  const s = withSessions(t, hq);
  hq.hub.snap.setup = { ...hq.hub.snap.setup, sandboxReady: true };
  hq.company.agents.setRole(hq.slug, "ana", "ceo", OWNER);
  const ana = hq.hub.cfg("ana")!;
  ana.mode = "sandbox";
  const { sbx, calls } = fakeSbx(hq, keys);
  s.sessions.envFileFor = (id) => (existsSync(sbx.envFile(id)) ? sbx.envFile(id) : null);
  s.sessions.githubKeyFor = async (id) => {
    await sbx.refresh();
    return sbx.githubKeyFor(id);
  };
  // No real sbx here: the policy is taken as set, and no sandbox exists yet.
  Object.assign(s.sessions as unknown as Record<string, unknown>, {
    policyOk: true,
    sandboxExists: async () => false,
    whenSandboxExists: async () => false,
    refreshSandboxSizes: async () => {},
  });
  return { hq, ...s, sbx, calls, ana };
}

test("company roles and workspace kinds", () => {
  assert.deepEqual([...COMPANY_ROLES], ["ceo", "cio", "security-audit"]);
  for (const r of COMPANY_ROLES) assert.equal(workspaceKind(r), "company");
  for (const r of ["cto", "builder", "qa"] as const) assert.equal(workspaceKind(r), "project");
});

test("SR-D-06 [T-S3.10] a company-level agent's folder has no .git and is not a clone", async (t) => {
  const { hq, sessions, backend, name, ana } = await ceo(t);
  const chosen = ana.workspacePath!; // a git repo the owner chose: ignored for a company role
  await sessions.start("ana", OWNER);
  const dir = companyWorkspaceFor(hq.slug, "ana");
  assert.equal(dir, join(process.env.HQ_HOME!, "_workspaces", hq.slug, "ana"));
  assert.equal(hq.hub.status("ana")?.session.state, "running", hq.hub.status("ana")?.session.detail ?? "");
  assert.equal(hq.hub.status("ana")?.session.workspace, dir);
  assert.ok(backend.live.has(name("ana")));
  assert.equal(existsSync(join(dir, ".git")), false);
  assert.equal((await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir })).ok, false);
  assert.notEqual(dir, chosen);
});

for (const [label, keys, envLine] of [
  ["a global github key", [{ scope: "global", name: "github" }], null],
  ["a sandbox-scoped github key", [{ scope: "SANDBOX", name: "github" }], null],
  ["GH_TOKEN in the env file", [], "GH_TOKEN=ghp_notarealtokenvalue123"],
] as const) {
  test(`SR-D-06 [T-S3.10] a company-level agent does not start while a GitHub credential can reach its sandbox: ${label}`, async (t) => {
    const { hq, sessions, backend, name, sbx, calls } = await ceo(t, [...keys]);
    if (envLine) {
      mkdirSync(join(sbx.envFile("ana"), ".."), { recursive: true });
      writeFileSync(sbx.envFile("ana"), `# app settings\nexport ${envLine}\n`);
    }
    await sessions.start("ana", OWNER);
    assert.equal(hq.hub.status("ana")?.session.state, "failed");
    assert.match(hq.hub.status("ana")?.session.detail ?? "", /GitHub/);
    assert.equal(backend.live.has(name("ana")), false, "no session was created");
    assert.equal(calls.some((c) => c[0] === "sbx" && (c[1] === "run" || c[1] === "create")), false, "no sandbox was created");
    assert.equal(hq.company.secrets.hasLive(`${hq.slug}/ana`), false);
    const rows = hq.company.audit.query({ action: "workspace.refused" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actorId, "owner");
    assert.equal(rows[0].data.reason, "github-credential");
    assert.deepEqual(rows[0].data.names, envLine ? ["GH_TOKEN"] : ["github"]);
    assert.equal(JSON.stringify(rows[0]).includes("ghp_"), false, "no token value in the row");
  });
}

test("SR-D-06 [T-S3.10] a company workspace inside a git work tree is refused", async (t) => {
  const { hq, sessions, backend, name } = await ceo(t);
  const repo = mkdtempSync(join(tmpdir(), "hq dotfiles "));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const saved = process.env.HQ_HOME;
  process.env.HQ_HOME = join(repo, ".jsmhq");
  t.after(() => {
    process.env.HQ_HOME = saved;
    rmSync(repo, { recursive: true, force: true });
  });
  await assert.rejects(ensureCompanyWorkspace(hq.slug, "ana"), (err: unknown) => err instanceof WorkspaceRefusedError && err.reason === "company-git");
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.equal(backend.live.has(name("ana")), false);
  const rows = hq.company.audit.query({ action: "workspace.refused" });
  assert.deepEqual(rows.map((r) => [r.actorId, r.data.reason]), [["owner", "company-git"]]);
});

test("a company-level agent is never started in Local mode", async (t) => {
  const { hq, sessions, backend, name, ana } = await ceo(t);
  ana.mode = "local";
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.equal(backend.live.has(name("ana")), false);
  assert.deepEqual(hq.company.audit.query({ action: "workspace.refused" }).map((r) => [r.actorId, r.data.reason]), [["owner", "local-mode"]]);
});

test("githubCredentialIn names the GitHub variables in an env file, never their values", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hq env "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "agent.env");
  writeFileSync(file, "# GH_TOKEN=commented out\nAPI_URL=https://x\nexport GITHUB_TOKEN=abc\n  GH_ENTERPRISE_TOKEN = def\nGITHUB_ENTERPRISE_TOKEN=\nMY_GH_TOKEN=x\n");
  assert.deepEqual(githubCredentialIn(file), ["GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);
  assert.deepEqual(githubCredentialIn(null), []);
  assert.deepEqual(githubCredentialIn(join(dir, "missing.env")), []);
});

test("a builder still gets a project folder", async (t) => {
  const hq = await makeHq(t);
  const { sessions } = withSessions(t, hq);
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "running");
  assert.equal(hq.hub.status("ana")?.session.workspace, hq.hub.cfg("ana")!.workspacePath);
  assert.equal(existsSync(join(process.env.HQ_HOME!, "_workspaces")), false);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { managedWorkspace } from "./paths";
import type { RepoInfo } from "./repo";
import { newAgent } from "./store";
import { ensureWorkspace, workspaceFor, WorkspaceRefusedError } from "./workspace";

// Point the home folder and the company home at a temporary folder (with a
// space), so these tests never touch the real ~/.jsmhq.
function sandboxHome(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "hq workspace "));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, HQ_COMPANY_HOME: process.env.HQ_COMPANY_HOME, HQ_HOME: process.env.HQ_HOME };
  const company = join(root, "home", ".jsmhq", "_company");
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  process.env.HQ_COMPANY_HOME = company;
  process.env.HQ_HOME = join(root, "home", ".jsmhq");
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, company };
}

const agent = (id: string, workspacePath: string | null = null) => ({ ...newAgent(id, id, "Developer", "#000000", false), workspacePath });

test("managedWorkspace refuses agent ids that are not plain slugs", (t) => {
  sandboxHome(t);
  for (const id of ["../_company", "..", "", "_company", "A", "Builder", "a/b", "a\\b", "-a", "a b", "a.b", "a\0b"]) {
    assert.throws(() => managedWorkspace("demo", id), /agent id/, JSON.stringify(id));
  }
});

test("managedWorkspace accepts slug agent ids", (t) => {
  const { root } = sandboxHome(t);
  for (const id of ["builder", "builder-2", "0a"]) {
    assert.equal(managedWorkspace("demo", id), join(root, "home", ".jsmhq", "demo", id));
  }
});

test("an agent folder at or inside the company store is refused", async (t) => {
  const { root, company } = sandboxHome(t);
  mkdirSync(join(company, "sub"), { recursive: true });
  const repo = { root: join(root, "repo"), originUrl: null } as unknown as RepoInfo;
  for (const dir of [company, join(company, "sub"), join(company, "not yet")]) {
    assert.throws(() => workspaceFor(agent("builder", dir), "demo"), /company store/, dir);
    await assert.rejects(ensureWorkspace(agent("builder", dir), "demo", repo), /company store/, dir);
  }
  const outside = join(root, "elsewhere");
  assert.equal(workspaceFor(agent("builder", outside), "demo"), outside);
  assert.equal(workspaceFor(agent("builder"), "demo"), join(root, "home", ".jsmhq", "demo", "builder"));
});

test("a managed folder that would land in the company store is refused", (t) => {
  const { root } = sandboxHome(t);
  // HQ_COMPANY_HOME set to a project home: every managed folder of that project is inside it.
  process.env.HQ_COMPANY_HOME = join(root, "home", ".jsmhq", "demo");
  assert.throws(() => workspaceFor(agent("builder"), "demo"), /company store/);
});

const REPO: RepoInfo = { root: "unused", name: "demo", originUrl: null, github: null, remotes: [], hasCodeRabbit: false, hasInsta: false };

test("SR-D-04 [T-S7.6] a chosen folder that is, holds, or sits inside the store or HQ's home is refused", async (t) => {
  const { root, company } = sandboxHome(t);
  const hq = join(root, "home", ".jsmhq");
  mkdirSync(company, { recursive: true });
  const candidates = [hq, company, join(root, "home"), join(hq, "demo", "other"), join(company, "inside")];
  for (const [i, target] of [hq, company].entries()) {
    const link = join(root, `link ${i}`);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    candidates.push(link, join(link, "deeper"));
  }
  if (process.platform === "win32") candidates.push(hq.toUpperCase(), company.toLowerCase());
  for (const dir of candidates) {
    mkdirSync(dir, { recursive: true });
    assert.throws(() => workspaceFor(agent("builder", dir), "demo"), /company store|HQ's home/, dir);
    await assert.rejects(ensureWorkspace(agent("builder", dir), "demo", REPO), /company store|HQ's home/, dir);
    assert.equal(existsSync(join(dir, ".git")), false, dir);
  }
  const outside = join(root, "elsewhere");
  mkdirSync(outside);
  assert.equal(workspaceFor(agent("builder", outside), "demo"), outside);
});

test("HQ's own clone inside HQ's home is allowed", (t) => {
  const { root } = sandboxHome(t);
  assert.equal(workspaceFor(agent("builder"), "demo"), join(root, "home", ".jsmhq", "demo", "builder"));
});

test("SR-D-05 [T-S7.5] a chosen agent folder that is a clone of HQ's source is refused", async (t) => {
  const { root } = sandboxHome(t);
  const dir = join(root, "my hq clone");
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/NdururiJr/Canoeney-Labs.git"], { cwd: dir });
  await assert.rejects(ensureWorkspace(agent("builder", dir), "demo", REPO), (err: unknown) => err instanceof WorkspaceRefusedError && err.reason === "hq-source");
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { managedWorkspace } from "./paths";
import type { RepoInfo } from "./repo";
import { newAgent } from "./store";
import { ensureWorkspace, workspaceFor } from "./workspace";

// Point the home folder and the company home at a temporary folder (with a
// space), so these tests never touch the real ~/.jsmhq.
function sandboxHome(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "hq workspace "));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, HQ_COMPANY_HOME: process.env.HQ_COMPANY_HOME };
  const company = join(root, "home", ".jsmhq", "_company");
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  process.env.HQ_COMPANY_HOME = company;
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

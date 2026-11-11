import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { slugify } from "../paths";
import { COMPANY_DIRNAME, companyHome } from "./home";
import { isInside, openCompany } from "./index";

// Temporary folders deliberately contain a space.
function tmp(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "company test "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("reopening keeps the audit chain", (t) => {
  const root = tmp(t);
  const home = join(root, "home dir", "_company");
  const repoRoot = join(root, "repo dir");

  const first = openCompany({ home, repoRoot });
  first.audit.append({ actorKind: "hq", actorId: "hq", action: "hq.started", data: { project: "demo" } });
  first.close();

  const second = openCompany({ home, repoRoot });
  try {
    assert.equal(second.audit.query({ action: "hq.started" }).length, 1);
    assert.equal(second.audit.verify().ok, true);
    assert.deepEqual(Object.keys(second.channels), ["dashboard"]);
  } finally {
    second.close(); // before the temp folder is removed (Windows locks open files)
  }
});

test("refuses a company home inside the repository", (t) => {
  const repo = join(tmp(t), "my repo");
  assert.throws(() => openCompany({ home: join(repo, ".jsmhq", "_company"), repoRoot: repo }), /inside the repository/);
  assert.throws(() => openCompany({ home: repo, repoRoot: repo }), /inside the repository/);
});

test("a sibling folder with the repo name as a prefix is not inside the repository", (t) => {
  const root = tmp(t);
  const company = openCompany({ home: join(root, "repo-company"), repoRoot: join(root, "repo") });
  company.close();
});

test("the company folder can never be a project folder", () => {
  for (const name of ["_company", "company", "_Company!", " _company "]) {
    assert.notEqual(slugify(name), COMPANY_DIRNAME);
  }
});

test("companyHome honours HQ_COMPANY_HOME", (t) => {
  const saved = process.env.HQ_COMPANY_HOME;
  t.after(() => {
    if (saved === undefined) delete process.env.HQ_COMPANY_HOME;
    else process.env.HQ_COMPANY_HOME = saved;
  });
  const dir = join(tmp(t), "elsewhere", "_company");
  process.env.HQ_COMPANY_HOME = dir;
  assert.equal(companyHome(), dir);
});

test("a folder named ..foo inside the repository is inside it", (t) => {
  const repo = join(tmp(t), "repo");
  mkdirSync(repo);
  assert.equal(isInside(join(repo, "..foo"), repo), true);
  assert.equal(isInside(join(repo, "..foo", "_company"), repo), true);
  assert.throws(() => openCompany({ home: join(repo, "..foo"), repoRoot: repo }), /inside the repository/);
});

test("repo2 is not inside repo, and the parent is not inside its child", (t) => {
  const root = tmp(t);
  mkdirSync(join(root, "repo"));
  mkdirSync(join(root, "repo2"));
  assert.equal(isInside(join(root, "repo2"), join(root, "repo")), false);
  assert.equal(isInside(join(root, "repo2", "x"), join(root, "repo")), false);
  assert.equal(isInside(root, join(root, "repo")), false);
  assert.equal(isInside(join(root, "repo"), join(root, "repo")), true);
});

test("a path through a link to the repository is inside it", (t) => {
  const root = tmp(t);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const link = join(root, "link to repo");
  symlinkSync(repo, link, "junction"); // a junction needs no admin rights on Windows; the type is ignored elsewhere
  assert.equal(isInside(link, repo), true);
  assert.equal(isInside(join(link, "_company"), repo), true); // the tail does not exist yet
  assert.equal(isInside(join(repo, "x"), link), true);
});

test("on Windows, paths compare without case", { skip: process.platform !== "win32" }, () => {
  assert.equal(isInside("C:\\Repo", "c:\\repo"), true);
  assert.equal(isInside("C:\\Repo\\Sub", "c:\\repo"), true);
  assert.equal(isInside("C:\\Repo2", "c:\\repo"), false);
});

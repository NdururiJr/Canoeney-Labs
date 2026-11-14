import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeClock } from "./company/clock";
import { openCompany, type Company } from "./company";
import { githubOf, hqSourceReason, hqSourceRoot, ProjectRefusedError, refuseHqSource } from "./hqSource";

const OWNER = { kind: "human", id: "owner" } as const;

function tempDir(t: { after(fn: () => void): void }, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hq ${label} `));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A git repo with the given remotes, outside HQ's own folder. */
function repoWith(t: { after(fn: () => void): void }, remotes: Record<string, string>): string {
  const dir = tempDir(t, "repo");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, url] of Object.entries(remotes)) execFileSync("git", ["remote", "add", name, url], { cwd: dir });
  return dir;
}

function company(t: { after(fn: () => void): void }): Company {
  const home = mkdtempSync(join(tmpdir(), "hq company "));
  const c = openCompany({ home, repoRoot: null, clock: new FakeClock("2026-11-14T08:00:00.000Z") });
  t.after(() => {
    c.close(); // before the folder goes: Windows will not delete an open database
    rmSync(home, { recursive: true, force: true });
  });
  return c;
}

test("githubOf reads owner/name from every GitHub URL form", () => {
  for (const url of [
    "https://github.com/acme/site.git",
    "https://github.com/acme/site",
    "https://github.com/acme/site/",
    "https://user:token@github.com/acme/site.git",
    "git@github.com:acme/site.git",
    "ssh://git@github.com/acme/site",
    "ssh://git@github.com:22/acme/site.git",
    "HTTPS://GITHUB.COM/acme/site",
  ]) {
    assert.equal(githubOf(url), "acme/site", url);
  }
  for (const url of ["https://gitlab.com/acme/site", "https://evilgithub.com/acme/site", "/home/me/site", "C:\\repos\\site", ""]) {
    assert.equal(githubOf(url), null, url);
  }
});

test("SR-D-05 [T-S7.5] a repo with HQ's source as any remote, in any URL form, is refused", async (t) => {
  const repos = [
    repoWith(t, { origin: "https://github.com/NdururiJr/Canoeney-Labs.git" }),
    repoWith(t, { origin: "https://github.com/acme/site.git", upstream: "git@github.com:jsmastery-pro/jsm-hq" }),
    repoWith(t, { origin: "SSH://GIT@GITHUB.COM/NDURURIJR/CANOENEY-LABS" }),
  ];
  for (const r of repos) assert.equal(await hqSourceReason(r), "hq-remote", r);

  const c = company(t);
  const before = JSON.stringify(c.db.prepare("SELECT * FROM projects").all());
  await assert.rejects(refuseHqSource(c, repos[1], OWNER), (err: unknown) => err instanceof ProjectRefusedError && err.reason === "hq-remote");
  const rows = c.audit.query({ action: "project.refused" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorKind, "human");
  assert.equal(rows[0].actorId, "owner");
  assert.equal(rows[0].data.reason, "hq-remote");
  assert.equal(JSON.stringify(c.db.prepare("SELECT * FROM projects").all()), before);
});

test("SR-D-05 [T-S7.5] a folder holding HQ's package identity, or HQ's own folder, is refused", async (t) => {
  const hqName = JSON.parse(readFileSync(join(hqSourceRoot(), "package.json"), "utf8")).name as string;
  const copy = repoWith(t, { origin: "https://github.com/acme/copy.git" });
  writeFileSync(join(copy, "package.json"), JSON.stringify({ name: hqName }));
  assert.equal(await hqSourceReason(copy), "hq-package");

  assert.equal(await hqSourceReason(hqSourceRoot()), "hq-folder");
  assert.equal(await hqSourceReason(join(hqSourceRoot(), "server")), "hq-folder");

  const other = repoWith(t, { origin: "https://github.com/acme/site.git" });
  writeFileSync(join(other, "package.json"), JSON.stringify({ name: "acme-site" }));
  assert.equal(await hqSourceReason(other), null);
  const plain = tempDir(t, "plain");
  mkdirSync(join(plain, "sub"));
  assert.equal(await hqSourceReason(join(plain, "sub")), null);
});

test("refuseHqSource lets an unrelated repo through and writes nothing", async (t) => {
  const c = company(t);
  await refuseHqSource(c, repoWith(t, { origin: "https://github.com/acme/site.git" }), OWNER);
  assert.equal(c.audit.query({ action: "project.refused" }).length, 0);
});

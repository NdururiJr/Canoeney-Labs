import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { canonicalJson } from "./company/canonicalJson";
import { fetchCommit, hashFolder, lockHash, readCommit, safeSkillPath, skillHash, vendorGit, writeStore } from "./skillVendor";
import { makeSkillsRepo } from "./testing/skillsRepo";

const posix = process.platform !== "win32";
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

function scratch(t: TestContext): string {
  const d = mkdtempSync(join(tmpdir(), "skill vendor "));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

const hasObject = (bare: string, sha: string) => spawnSync("git", ["--git-dir", bare, "cat-file", "-e", sha]).status === 0;

// --- fetch ---------------------------------------------------------------

test("SR-F-01 [T-S12.1] a commit that is not on the skills repo's default branch is refused", async (t) => {
  const d = scratch(t);
  const origin = makeSkillsRepo(d);
  const main = origin.commit({ "skills/a/SKILL.md": "the reviewed skill" });
  const pr = origin.commit({ "skills/a/SKILL.md": "a stranger's skill" }, { ref: "refs/pull/1/head", parent: main });
  const bare = join(d, "repo.git");

  assert.deepEqual(await fetchCommit({ url: origin.url, sha: pr, bare, allowFile: true }), { ok: false, reason: "not-on-default-branch" });
  assert.equal(hasObject(bare, pr), false, "the stranger's commit was never fetched");

  // A commit the repo does not hold at all is refused the same way.
  assert.deepEqual(await fetchCommit({ url: origin.url, sha: "0".repeat(40), bare, allowFile: true }), { ok: false, reason: "not-on-default-branch" });
  // The default branch's own commit still passes.
  assert.deepEqual(await fetchCommit({ url: origin.url, sha: main, bare, allowFile: true }), { ok: true, branch: "main" });
  assert.equal(hasObject(bare, pr), false);

  // The default branch moves to a history without `main`'s commit. The bare repo
  // still holds that commit from the earlier fetch, but it is refused now.
  origin.commit({ "skills/a/SKILL.md": "a new history" }, { ref: "refs/heads/trunk" });
  assert.equal(spawnSync("git", ["--git-dir", origin.dir, "symbolic-ref", "HEAD", "refs/heads/trunk"]).status, 0);
  assert.deepEqual(await fetchCommit({ url: origin.url, sha: main, bare, allowFile: true }), { ok: false, reason: "not-on-default-branch" });
  assert.equal(hasObject(bare, main), true, "present in the bare repo, but not on the default branch");
});

test("fetchCommit accepts an older commit of the default branch", async (t) => {
  const d = scratch(t);
  const origin = makeSkillsRepo(d, "trunk-origin.git", "trunk");
  const older = origin.commit({ "skills/a/SKILL.md": "v1" });
  const newer = origin.commit({ "skills/a/SKILL.md": "v2" });
  const bare = join(d, "repo.git");
  assert.deepEqual(await fetchCommit({ url: origin.url, sha: older, bare, allowFile: true }), { ok: true, branch: "trunk" });
  assert.deepEqual(await fetchCommit({ url: origin.url, sha: newer, bare, allowFile: true }), { ok: true, branch: "trunk" });
});

test("fetchCommit refuses a commit that is not 40 hex before running git", async (t) => {
  const d = scratch(t);
  const origin = makeSkillsRepo(d);
  origin.commit({ "skills/a/SKILL.md": "a" });
  const bare = join(d, "repo.git");
  for (const sha of ["HEAD", "main", "A".repeat(40), "a".repeat(39), "a".repeat(41), "--upload-pack=touch x", ""]) {
    assert.deepEqual(await fetchCommit({ url: origin.url, sha, bare, allowFile: true }), { ok: false, reason: "bad-sha" }, sha);
  }
  assert.equal(existsSync(bare), false, "no git call made the bare repo");
});

test("fetchCommit answers fetch-failed for a repo it cannot reach, and a local path needs allowFile", async (t) => {
  const d = scratch(t);
  const origin = makeSkillsRepo(d);
  const sha = origin.commit({ "skills/a/SKILL.md": "a" });
  const bare = join(d, "repo.git");
  assert.deepEqual(await fetchCommit({ url: join(d, "missing.git"), sha, bare, allowFile: true }), { ok: false, reason: "fetch-failed" });
  // Only https is allowed unless the test opens the file protocol.
  assert.deepEqual(await fetchCommit({ url: origin.url, sha, bare }), { ok: false, reason: "fetch-failed" });
  assert.equal(hasObject(bare, sha), false);
});

test("fetching uses no credential helper and no prompt", async (t) => {
  const d = scratch(t);
  const origin = makeSkillsRepo(d);
  const sha = origin.commit({ "skills/a/SKILL.md": "a" });
  const marker = join(d, "helper-was-called").replace(/\\/g, "/");
  const cfg = join(d, "global.gitconfig");
  writeFileSync(cfg, "");
  assert.equal(spawnSync("git", ["config", "--file", cfg, "credential.helper", `!f() { echo called > '${marker}'; }; f`]).status, 0);

  // No system config: Git for Windows names a helper there that can open a
  // window, so a regression would hang the test instead of failing it.
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  t.after(() => {
    if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved.global;
    if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
  });
  const quiet = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
  const ask = "protocol=https\nhost=example.com\npath=o/r.git\n\n";

  // The fixture helper works: plain git calls it when it wants a credential.
  spawnSync("git", ["credential", "fill"], { input: ask, env: quiet, timeout: 20_000 });
  assert.equal(existsSync(marker), true, "the fixture helper is reachable");
  rmSync(marker);

  // HQ's git calls never do: the fetch passes, and a credential request fails without the helper or a prompt.
  assert.deepEqual(await fetchCommit({ url: origin.url, sha, bare: join(d, "repo.git"), allowFile: true }), { ok: true, branch: "main" });
  const r = await vendorGit(["credential", "fill"], { input: ask, timeoutMs: 20_000 });
  assert.equal(r.ok, false);
  assert.equal(existsSync(marker), false, "the helper was not called");
});

// --- reading a commit ----------------------------------------------------

test("SR-F-01 [T-S12.5] the hash covers every file, not only SKILL.md", async (t) => {
  const d = scratch(t);
  const origin = makeSkillsRepo(d);
  const base = { "skills/tool/SKILL.md": "# tool\n", "skills/tool/scripts/run.sh": { data: "echo one\n", mode: "100755" as const } };
  const c1 = origin.commit(base);
  const c2 = origin.commit({ ...base, "skills/tool/scripts/run.sh": { data: "echo onf\n", mode: "100755" } });
  const c3 = origin.commit({ ...base, "skills/tool/scripts/run.sh": { data: "echo one\n", mode: "100644" } });

  const bare = join(d, "repo.git");
  assert.deepEqual(await fetchCommit({ url: origin.url, sha: c3, bare, allowFile: true }), { ok: true, branch: "main" });
  const [s1, s2, s3] = await Promise.all([c1, c2, c3].map(async (c) => (await readCommit(bare, c)).skills[0]));

  assert.deepEqual(s1.files, [
    { path: "SKILL.md", mode: "100644", sha256: sha256("# tool\n") },
    { path: "scripts/run.sh", mode: "100755", sha256: sha256("echo one\n") },
  ]);
  assert.equal(s1.hash, skillHash(s1.files));
  assert.equal(s1.files[0].sha256, s2.files[0].sha256, "SKILL.md did not change");
  assert.notEqual(s2.hash, s1.hash, "one byte in a script changes the hash");
  assert.notEqual(s3.hash, s1.hash, "a mode change changes the hash");
});

test("skillHash follows the plan's line format, sorted bytewise by path", () => {
  const files = [
    { path: "b.md", mode: "100644", sha256: "b".repeat(64) },
    { path: "SKILL.md", mode: "100755", sha256: "a".repeat(64) },
  ];
  const expected = sha256(`100755 SKILL.md\0${"a".repeat(64)}\n100644 b.md\0${"b".repeat(64)}\n`);
  assert.equal(skillHash(files), expected);
  assert.equal(skillHash([...files].reverse()), expected);
});

test("lockHash is the sha256 of the canonical JSON, skills sorted by name", () => {
  const skills = [
    { name: "zeta", hash: "1".repeat(64) },
    { name: "alpha", hash: "2".repeat(64) },
  ];
  const sorted = [skills[1], skills[0]];
  const expected = sha256(canonicalJson({ repo: "o/r", commit: "c".repeat(40), skills: sorted }));
  assert.equal(lockHash("o/r", "c".repeat(40), skills), expected);
  assert.equal(lockHash("o/r", "c".repeat(40), sorted), expected);
  assert.notEqual(lockHash("o/r", "d".repeat(40), skills), expected);
});

test("SR-F-06 [T-S12.5] a skill holding a link is refused, and a submodule is refused", async (t) => {
  const d = scratch(t);
  const origin = makeSkillsRepo(d);
  const sha = origin.commit({
    "skills/linked/SKILL.md": "x",
    "skills/linked/notes": { link: "../../../etc/passwd" },
    "skills/nested/SKILL.md": "x",
    "skills/nested/vendor": { submodule: "a".repeat(40) },
    "skills/plain/SKILL.md": "x",
  });
  const r = await readCommit(origin.dir, sha);
  assert.deepEqual(r.refused, [
    { skill: "linked", reason: "link" },
    { skill: "nested", reason: "submodule" },
  ]);
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["plain"],
  );
});

test("SR-F-06 [T-S12.5] a skill with a path that leaves its folder is refused", async (t) => {
  for (const p of ["../x", "a/../../x", "/etc/x", "a\\b", "a\0b", "a//b", "./x", "a/", "", "a/./b", "a/.."]) {
    assert.equal(safeSkillPath(p), false, JSON.stringify(p));
  }
  for (const p of ["scripts/run.sh", "SKILL.md", ".hidden", "a..b", "docs/v1.2/x.md"]) assert.equal(safeSkillPath(p), true, p);

  const d = scratch(t);
  const origin = makeSkillsRepo(d);
  const sha = origin.commit({
    "skills/escape/SKILL.md": "x",
    "skills/escape/../evil.md": "planted next to the skill",
    "skills/backslash/SKILL.md": "x",
    "skills/backslash/a\\b": "x",
    "skills/good/SKILL.md": "x",
  });
  const r = await readCommit(origin.dir, sha);
  assert.deepEqual(r.refused, [
    { skill: "backslash", reason: "path" },
    { skill: "escape", reason: "path" },
  ]);
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["good"],
    "the other skills in the commit are still read",
  );
});

test("a path Windows cannot hold is refused at pin", async (t) => {
  for (const p of ["aux", "AUX.txt", "docs/con.md", "com1", "LPT9.log", "notes.", "notes ", "Nul.tar.gz", "prn", "com0", "lpt1/x.md", "a:b", "a?b", "a*b", 'a"b', "a<b", "a>b", "a|b", "a\nb", "a\tb"]) {
    assert.equal(safeSkillPath(p), false, JSON.stringify(p));
  }
  for (const p of ["auxiliary.md", "com10.md", "console.md", "lpt.md", "docs/nul-handling.md"]) assert.equal(safeSkillPath(p), true, p);

  const d = scratch(t);
  const origin = makeSkillsRepo(d);
  const sha = origin.commit({
    "skills/aux/SKILL.md": "x",
    "skills/con-ok/SKILL.md": "x",
    "skills/devices/SKILL.md": "x",
    "skills/devices/docs/con.md": "x",
  });
  const r = await readCommit(origin.dir, sha);
  assert.deepEqual(r.refused, [
    { skill: "aux", reason: "name" },
    { skill: "devices", reason: "path" },
  ]);
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["con-ok"],
  );
});

test("two paths that differ only in case are refused at pin", async (t) => {
  const d = scratch(t);
  const origin = makeSkillsRepo(d);
  const sha = origin.commit({
    "skills/files/SKILL.md": "x",
    "skills/files/README.md": "one",
    "skills/files/readme.md": "two",
    "skills/folders/SKILL.md": "x",
    "skills/folders/Docs/a.md": "x",
    "skills/folders/docs/b.md": "x",
    "skills/fine/SKILL.md": "x",
    "skills/fine/docs/a.md": "x",
    "skills/fine/docs/b.md": "x",
  });
  const r = await readCommit(origin.dir, sha);
  assert.deepEqual(r.refused, [
    { skill: "files", reason: "case-collision" },
    { skill: "folders", reason: "case-collision" },
  ]);
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["fine"],
  );
});

test("SR-F-06 [T-S12.6] bundled scripts are listed", async (t) => {
  const d = scratch(t);
  const origin = makeSkillsRepo(d);
  const sha = origin.commit({
    "skills/tool/SKILL.md": "x",
    "skills/tool/scripts/run": { data: "#!/bin/sh\n", mode: "100755" },
    "skills/tool/tools/check.py": "print(1)\n",
    "skills/tool/tools/Setup.PS1": "Write-Host 1\n",
    "skills/tool/docs/guide.md": "x",
  });
  const r = await readCommit(origin.dir, sha);
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.skills[0].scripts, ["scripts/run", "tools/Setup.PS1", "tools/check.py"]);
});

test("a skill without SKILL.md, with a bad name, or over 256 files is refused", async (t) => {
  const d = scratch(t);
  const origin = makeSkillsRepo(d);
  const many: Record<string, string> = { "skills/crowded/SKILL.md": "x" };
  for (let i = 0; i < 256; i++) many[`skills/crowded/f${i}.md`] = "x";
  const sha = origin.commit({
    ...many,
    "skills/heavy/SKILL.md": "x",
    "skills/heavy/blob.bin": Buffer.alloc(2 * 1024 * 1024),
    "skills/no-entry/README.md": "x",
    "skills/Bad_Name/SKILL.md": "x",
    "skills/-dash/SKILL.md": "x",
    "skills/full/SKILL.md": "x",
    "skills/full/f.md": Buffer.alloc(1024),
    "skills/README.md": "a file beside the skills is not a skill",
  });
  const r = await readCommit(origin.dir, sha);
  assert.deepEqual(r.refused, [
    { skill: "-dash", reason: "name" },
    { skill: "Bad_Name", reason: "name" },
    { skill: "crowded", reason: "too-big" },
    { skill: "heavy", reason: "too-big" },
    { skill: "no-entry", reason: "no-skill-md" },
  ]);
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["full"],
  );
});

// --- the content store and checking a folder -----------------------------

async function storedSkill(t: TestContext) {
  const d = scratch(t);
  const origin = makeSkillsRepo(d);
  const sha = origin.commit({
    "skills/tool/SKILL.md": "# tool\n",
    "skills/tool/scripts/run.sh": { data: "echo hi\n", mode: "100755" },
  });
  const { skills } = await readCommit(origin.dir, sha);
  const store = join(d, "store");
  writeStore(origin.dir, sha, skills[0], store);
  return { d, origin, sha, skill: skills[0], store, dir: join(store, skills[0].hash) };
}

test("hashFolder matches skillHash for the same files", async (t) => {
  const { skill, dir } = await storedSkill(t);
  assert.deepEqual(hashFolder(dir, skill.files), { hash: skill.hash });
  if (posix) {
    assert.equal(statSync(join(dir, "scripts/run.sh")).mode & 0o777, 0o755);
    assert.equal(statSync(join(dir, "SKILL.md")).mode & 0o777, 0o644);
  }
  // A changed byte gives a different hash, which the caller compares with the lock's.
  writeFileSync(join(dir, "SKILL.md"), "# tool!\n");
  assert.notEqual((hashFolder(dir, skill.files) as { hash: string }).hash, skill.hash);
});

test("writeStore refuses a lock entry the commit does not match, and writes nothing", async (t) => {
  const { origin, sha, skill, store } = await storedSkill(t);
  const forged = { ...skill, files: skill.files.map((f) => (f.path === "SKILL.md" ? { ...f, sha256: "0".repeat(64) } : f)) };
  forged.hash = skillHash(forged.files);
  assert.throws(() => writeStore(origin.dir, sha, forged, store));
  assert.equal(existsSync(join(store, forged.hash)), false);
});

test("hashFolder refuses a folder with a path the lock does not list, or missing one it lists", async (t) => {
  const { skill, dir } = await storedSkill(t);
  writeFileSync(join(dir, "extra.md"), "x");
  assert.deepEqual(hashFolder(dir, skill.files), { refused: "paths" });
  rmSync(join(dir, "extra.md"));
  mkdirSync(join(dir, "empty"));
  assert.deepEqual(hashFolder(dir, skill.files), { refused: "paths" });
  rmSync(join(dir, "empty"), { recursive: true });
  rmSync(join(dir, "scripts/run.sh"));
  assert.deepEqual(hashFolder(dir, skill.files), { refused: "paths" });
});

test("on POSIX, a file whose executable bit differs from the lock is refused", { skip: !posix && "NTFS keeps no executable bit" }, async (t) => {
  const { skill, dir } = await storedSkill(t);
  chmodSync(join(dir, "scripts/run.sh"), 0o644);
  assert.deepEqual(hashFolder(dir, skill.files), { refused: "mode" });
  chmodSync(join(dir, "scripts/run.sh"), 0o755);
  chmodSync(join(dir, "SKILL.md"), 0o755);
  assert.deepEqual(hashFolder(dir, skill.files), { refused: "mode" });
});

test("hashFolder refuses a folder holding a link", async (t) => {
  const { d, skill, dir } = await storedSkill(t);
  const outside = join(d, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "run.sh"), "echo hi\n");
  rmSync(join(dir, "scripts"), { recursive: true });
  try {
    symlinkSync(outside, join(dir, "scripts"), "junction"); // a junction needs no admin rights on Windows; the type is ignored elsewhere
  } catch {
    t.skip("this machine cannot create links");
    return;
  }
  assert.deepEqual(hashFolder(dir, skill.files), { refused: "link" });
  // A link given as the folder itself is refused too.
  const linkedRoot = join(d, "linked-root");
  symlinkSync(join(dir), linkedRoot, "junction");
  assert.deepEqual(hashFolder(linkedRoot, skill.files), { refused: "link" });
});

// --- hashFolder in the agent's folder (the agent controls it) -------------------

/** A lock entry for `data` at `path`, so a test can build any folder and its lock. */
const entry = (path: string, data: string | Buffer, mode = "100644") => ({ path, mode, sha256: sha256(data) });

test("hashFolder refuses a file over the 2 MiB cap without reading it", async (t) => {
  const d = scratch(t);
  const dir = join(d, "big");
  mkdirSync(dir);
  writeFileSync(join(dir, "SKILL.md"), "x");
  const big = Buffer.alloc(3 * 1024 * 1024, 1);
  writeFileSync(join(dir, "big.bin"), big);
  const files = [entry("SKILL.md", "x"), entry("big.bin", big)];
  const read: string[] = [];
  assert.deepEqual(hashFolder(dir, files, { onRead: (p) => read.push(p) }), { refused: "too-big" });
  assert.deepEqual(read, [join(dir, "SKILL.md")], "the big file was refused from its size, before any byte was read");
});

test("hashFolder refuses files that together pass 2 MiB, and a lock of more than 256 files", async (t) => {
  const d = scratch(t);
  const dir = join(d, "two");
  mkdirSync(dir);
  const half = Buffer.alloc(1024 * 1024 + 1, 2);
  writeFileSync(join(dir, "a.bin"), half);
  writeFileSync(join(dir, "b.bin"), half);
  assert.deepEqual(hashFolder(dir, [entry("a.bin", half), entry("b.bin", half)]), { refused: "too-big" });

  const many = Array.from({ length: 257 }, (_, i) => entry(`f${i}.md`, "x"));
  assert.deepEqual(hashFolder(dir, many), { refused: "too-big" });
});

test("hashFolder stops walking at the first entry the lock does not list", async (t) => {
  const d = scratch(t);
  const dir = join(d, "crowded");
  mkdirSync(dir);
  writeFileSync(join(dir, "SKILL.md"), "x");
  for (let i = 0; i < 2000; i++) writeFileSync(join(dir, `junk${i}`), "");
  let visited = 0;
  assert.deepEqual(hashFolder(dir, [entry("SKILL.md", "x")], { onVisit: () => visited++ }), { refused: "paths" });
  assert.ok(visited >= 1 && visited <= 2, `visited ${visited} entries`);
});

test("hashFolder refuses a FIFO swapped in after the walk, without hanging", { skip: !posix && "no FIFOs on Windows" }, async (t) => {
  const d = scratch(t);
  const dir = join(d, "fifo");
  mkdirSync(dir);
  writeFileSync(join(dir, "SKILL.md"), "x");
  // A child process, so a hang fails the test instead of stopping the run. The hook
  // swaps SKILL.md for a FIFO between the lstat walk and the open.
  const script = `
    const { hashFolder } = await import(${JSON.stringify(join(import.meta.dirname, "skillVendor.ts"))});
    const { rmSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const dir = ${JSON.stringify(dir)};
    const r = hashFolder(dir, [{ path: "SKILL.md", mode: "100644", sha256: ${JSON.stringify(sha256("x"))} }], {
      beforeOpen: (p) => { rmSync(p); execFileSync("mkfifo", [p]); },
    });
    console.log(JSON.stringify(r));
  `;
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.error, undefined, "the child finished in time");
  assert.deepEqual(JSON.parse(r.stdout.trim()), { refused: "not-file" });
});

test("hashFolder refuses a FIFO found by the walk", { skip: !posix && "no FIFOs on Windows" }, async (t) => {
  const d = scratch(t);
  const dir = join(d, "fifo2");
  mkdirSync(dir);
  spawnSync("mkfifo", [join(dir, "SKILL.md")]);
  assert.deepEqual(hashFolder(dir, [entry("SKILL.md", "x")]), { refused: "not-file" });
});

// Each start installs exactly the agent's pinned skills from HQ's store (M0-F
// Task 5; threat model SR-F-01, SR-F-02, SR-F-04, SR-F-05).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { companyAgentId, type Actor } from "./company/agents";
import type { LockedSkill } from "./company/companySkills";
import { isInside } from "./company/home";
import { managedWorkspace, projectHome } from "./paths";
import type { RepoInfo } from "./repo";
import { effectiveSkills, installSkills, MOVES_DIRNAME, overCap, skillMovesDir, skillsBlockedText } from "./skills";
import { lockHash, readCommit, writeStore } from "./skillVendor";
import { newAgent } from "./store";
import { makeHq, SEED_AUTHORITY, type Hq } from "./testing/hqFixture";
import { withSessions } from "./testing/sessionFixture";
import { makeSkillsRepo } from "./testing/skillsRepo";
import { ensureWorkspace } from "./workspace";

const OWNER: Actor = { kind: "human", id: "owner" };
const TDD = "test-driven-development";
const CLAUDE = ".claude/skills";

/** The pinned skills: the builder role's starting set, plus writing-plans. */
const SKILLS = {
  [`skills/${TDD}/SKILL.md`]: "# tdd, as pinned\n",
  [`skills/${TDD}/scripts/check.sh`]: { data: "echo check\n", mode: "100755" as const },
  "skills/systematic-debugging/SKILL.md": "# debugging, as pinned\n",
  "skills/verification-before-completion/SKILL.md": "# verify, as pinned\n",
  "skills/executing-plans/SKILL.md": "# executing plans, as pinned\n",
  "skills/writing-plans/SKILL.md": "# writing plans, as pinned\n",
};

function scratch(t: TestContext): string {
  const d = mkdtempSync(join(tmpdir(), "hq skills "));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A skills repo with SKILLS at one commit, read and written into `storeDir`. */
async function pinnedStore(dir: string, storeDir = join(dir, "store")) {
  const origin = makeSkillsRepo(dir);
  const sha = origin.commit(SKILLS);
  const { skills } = await readCommit(origin.dir, sha);
  for (const s of skills) writeStore(origin.dir, sha, s, storeDir);
  return { origin, sha, lock: skills, storeDir };
}

/** The moves folder of the `n`th start of agent ana, under HQ's home in `d`. */
const movesAt = (d: string, n: number) => skillMovesDir(join(d, "hq home"), "ana", new Date(Date.UTC(2026, 10, 16, 8, 0, n)));

const pick = (lock: LockedSkill[], ...names: string[]) => names.map((n) => lock.find((s) => s.name === n)!);

/** Makes a link to a folder: a junction on Windows (no admin rights needed). Null when the machine cannot. */
function linkFolder(target: string, at: string): boolean {
  try {
    symlinkSync(target, at, "junction");
    return true;
  } catch {
    return false;
  }
}

/** Every file under `dir` with its content, for "unchanged" checks. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out[r] = readFileSync(join(d, e.name), "utf8");
    }
  };
  walk(dir, "");
  return out;
}

function put(root: string, rel: string, data: string | Buffer) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), data);
}

/** A whole HQ whose company has SKILLS pinned, with sessions on a fake backend. Ana is a builder. */
async function pinnedHq(t: TestContext) {
  const hq = await makeHq(t);
  const s = withSessions(t, hq);
  const storeDir = hq.company.skills.storeDir();
  const { sha, lock } = await pinnedStore(join(hq.scratch, "skills origin"), storeDir);
  hq.company.skills.writePin({ repo: "owner/skills", commit: sha, lockHash: lockHash("owner/skills", sha, lock), skills: lock }, SEED_AUTHORITY);
  const ana = hq.hub.cfg("ana")!;
  const work = ana.workspacePath!;
  const moves = join(projectHome(hq.slug), MOVES_DIRNAME, "ana");
  return { hq, ...s, storeDir, lock, work, moves };
}

const refusedRows = (hq: Hq) => hq.company.audit.query({ action: "skill.refused" });
const driftRows = (hq: Hq) => hq.company.audit.query({ action: "skill.drift" });
const lastActivity = (hq: Hq, re: RegExp) => hq.hub.snap.activity.filter((a) => re.test(a.text)).map((a) => a.text);

// --- SR-F-01: HQ's copy is checked before every install ---------------------------------

test("SR-F-01 [T-S12.5] a store copy changed after the pin is refused at install", async (t) => {
  const { hq, sessions, storeDir, lock, work } = await pinnedHq(t);
  const tdd = pick(lock, TDD)[0];
  // One byte of a bundled script, not SKILL.md.
  writeFileSync(join(storeDir, tdd.hash, "scripts", "check.sh"), "echo check!\n");

  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "running", hq.hub.status("ana")?.session.detail ?? "");
  assert.equal(existsSync(join(work, CLAUDE, TDD)), false, "the agent's folder holds no copy");
  const rows = refusedRows(hq).filter((r) => r.data.reason === "hash");
  assert.deepEqual(
    rows.map((r) => [r.actorId, r.target, r.data.skill]),
    [["owner", companyAgentId(hq.slug, "ana"), TDD]],
  );
  // The other skills of the set are installed.
  for (const n of ["systematic-debugging", "verification-before-completion", "executing-plans"]) {
    assert.equal(readFileSync(join(work, CLAUDE, n, "SKILL.md"), "utf8"), (SKILLS as Record<string, unknown>)[`skills/${n}/SKILL.md`]);
  }
  assert.ok(lastActivity(hq, /starts without/).some((l) => l.includes(TDD)));
});

test("a skill refused at install is also taken out of the agent's folder", async (t) => {
  const { hq, sessions, storeDir, lock, work } = await pinnedHq(t);
  await sessions.start("ana", OWNER);
  assert.equal(readFileSync(join(work, CLAUDE, TDD, "SKILL.md"), "utf8"), "# tdd, as pinned\n");
  await sessions.stop("ana");

  writeFileSync(join(storeDir, pick(lock, TDD)[0].hash, "SKILL.md"), "# tdd, changed in the store\n");
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "running");
  assert.equal(existsSync(join(work, CLAUDE, TDD)), false, "the earlier copy is gone from the agent's folder");
  assert.deepEqual(refusedRows(hq).filter((r) => r.data.reason === "hash").map((r) => r.data.skill), [TDD]);
  const drift = driftRows(hq);
  assert.equal(drift.length, 2, "the first install (all missing) and this start");
  assert.deepEqual(drift[1].data.changed, [`${CLAUDE}/${TDD}`]);
  const movedTo = drift[1].data.movedTo as string;
  assert.equal(readFileSync(join(movedTo, CLAUDE, TDD, "SKILL.md"), "utf8"), "# tdd, as pinned\n", "the earlier copy is in movedTo");
});

// --- SR-F-02: a start fetches nothing ------------------------------------------------------

test("SR-F-02 [T-S12.2] a session start fetches nothing", async (t) => {
  const d = scratch(t);
  const { origin, lock, storeDir } = await pinnedStore(d);
  rmSync(origin.dir, { recursive: true, force: true }); // the skills repo is gone
  const work = join(d, "work");
  mkdirSync(work);
  const saved = process.env.PATH;
  process.env.PATH = ""; // no git, npx or npm could run
  let r;
  try {
    r = installSkills({ workspace: work, cli: "claude", want: lock, storeDir, movedDir: movesAt(d, 1) });
  } finally {
    process.env.PATH = saved;
  }
  assert.ok("installed" in r);
  assert.deepEqual(r.installed, lock.map((s) => s.name).sort());
  assert.deepEqual(r.refused, []);
  for (const s of lock) assert.ok(existsSync(join(work, CLAUDE, s.name, "SKILL.md")), s.name);
});

// --- SR-F-04: drift is moved aside and recorded ---------------------------------------------

test("SR-F-04 [T-S12.3] an edited skill and an added one are both gone after the next start, with one drift row", async (t) => {
  const { hq, sessions, work, moves } = await pinnedHq(t);
  await sessions.start("ana", OWNER);
  const first = driftRows(hq);
  assert.equal(first.length, 1, "a first install is recorded: every skill was missing");
  assert.deepEqual([first[0].data.changed, first[0].data.extra, first[0].data.movedTo], [[], [], null]);
  assert.deepEqual(first[0].data.missing, ["executing-plans", "systematic-debugging", TDD, "verification-before-completion"]);
  await sessions.stop("ana");

  writeFileSync(join(work, CLAUDE, TDD, "SKILL.md"), "# tdd, as pinned!\n"); // one byte
  put(work, `${CLAUDE}/stray/SKILL.md`, "# a skill the agent added\n");
  await sessions.start("ana", OWNER);

  assert.equal(hq.hub.status("ana")?.session.state, "running");
  assert.equal(readFileSync(join(work, CLAUDE, TDD, "SKILL.md"), "utf8"), "# tdd, as pinned\n");
  assert.equal(existsSync(join(work, CLAUDE, "stray")), false);
  const rows = driftRows(hq).slice(first.length);
  assert.equal(rows.length, 1, "this start wrote one drift row");
  assert.equal(rows[0].actorId, "owner");
  assert.equal(rows[0].target, companyAgentId(hq.slug, "ana"));
  assert.deepEqual(rows[0].data.missing, []);
  assert.deepEqual(rows[0].data.changed, [`${CLAUDE}/${TDD}`]);
  assert.deepEqual(rows[0].data.extra, [`${CLAUDE}/stray`]);
  const movedTo = rows[0].data.movedTo as string;
  assert.equal(dirname(movedTo), moves);
  assert.equal(readFileSync(join(movedTo, CLAUDE, TDD, "SKILL.md"), "utf8"), "# tdd, as pinned!\n");
  assert.equal(readFileSync(join(movedTo, CLAUDE, "stray", "SKILL.md"), "utf8"), "# a skill the agent added\n");
});

test("SR-F-04 [T-S12.3] a pinned skill the agent deleted is drift, and the next start puts it back", async (t) => {
  const { hq, sessions, work } = await pinnedHq(t);
  await sessions.start("ana", OWNER);
  await sessions.stop("ana");
  const before = driftRows(hq).length;
  rmSync(join(work, CLAUDE, TDD), { recursive: true });
  await sessions.start("ana", OWNER);
  const rows = driftRows(hq).slice(before);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorId, "owner");
  assert.deepEqual([rows[0].data.changed, rows[0].data.extra, rows[0].data.missing, rows[0].data.movedTo], [[], [], [TDD], null]);
  assert.equal(readFileSync(join(work, CLAUDE, TDD, "SKILL.md"), "utf8"), "# tdd, as pinned\n");
});

test("a start with nothing changed writes no drift row", async (t) => {
  const { hq, sessions } = await pinnedHq(t);
  await sessions.start("ana", OWNER);
  await sessions.stop("ana");
  const before = driftRows(hq).length;
  await sessions.start("ana", OWNER);
  assert.equal(driftRows(hq).length, before);
});

test("SR-F-04 [T-S12.3] an extra skill in a chosen folder is moved to HQ's home, not deleted", async (t) => {
  const { hq, sessions, work, moves } = await pinnedHq(t);
  put(work, `${CLAUDE}/owner-notes/notes.md`, "the owner's own notes\n");
  put(work, `${CLAUDE}/owner-notes/deep/more.md`, "more\n");
  await sessions.start("ana", OWNER);

  assert.equal(hq.hub.status("ana")?.session.state, "running");
  assert.equal(existsSync(join(work, CLAUDE, "owner-notes")), false);
  const rows = driftRows(hq);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorId, "owner");
  assert.deepEqual(rows[0].data.extra, [`${CLAUDE}/owner-notes`]);
  const movedTo = rows[0].data.movedTo as string;
  assert.ok(movedTo.startsWith(moves));
  assert.deepEqual(snapshot(join(movedTo, CLAUDE, "owner-notes")), { "deep/more.md": "more\n", "notes.md": "the owner's own notes\n" });
});

// --- SR-F-05: a skill the repo tracks ----------------------------------------------------------

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });

/** HQ's homes in `d`, an upstream repo tracking `files`, and HQ's own clone of it (sparse, as every start makes it). */
async function hqClone(t: TestContext, files: Record<string, string>) {
  const d = scratch(t);
  const saved = { HQ_HOME: process.env.HQ_HOME, HQ_COMPANY_HOME: process.env.HQ_COMPANY_HOME };
  process.env.HQ_HOME = join(d, "hq home");
  process.env.HQ_COMPANY_HOME = join(d, "hq home", "_company");
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  });
  const upstream = join(d, "upstream");
  mkdirSync(upstream);
  gitIn(upstream, "init", "-q", "-b", "main");
  for (const [rel, text] of Object.entries({ "src/a.ts": "export {};\n", ...files })) put(upstream, rel, text);
  gitIn(upstream, "add", "-A");
  gitIn(upstream, "commit", "-qm", "init");
  const repo: RepoInfo = { root: upstream, name: "demo", originUrl: null, github: null, remotes: [], hasCodeRabbit: false, hasInsta: false };
  const agent = newAgent("ana", "Ana", "Developer", "#29adff", false);
  const dir = await ensureWorkspace(agent, "demo", repo);
  const { lock, storeDir } = await pinnedStore(join(d, "skills"));
  return { d, dir, lock, storeDir, again: () => ensureWorkspace(agent, "demo", repo) };
}

test("SR-F-05 [T-S12.3] a skill the repo tracks gets HQ's copy, and git does not see it", async (t) => {
  const { d, dir, lock, storeDir, again } = await hqClone(t, { [`${CLAUDE}/${TDD}/SKILL.md`]: "the repo's own tdd\n" });
  const r = installSkills({ workspace: dir, cli: "claude", want: pick(lock, TDD), storeDir, movedDir: movesAt(d, 1) });
  assert.ok("installed" in r);
  assert.deepEqual(r.installed, [TDD]);
  assert.equal(readFileSync(join(dir, CLAUDE, TDD, "SKILL.md"), "utf8"), "# tdd, as pinned\n");
  assert.equal(gitIn(dir, "status", "--porcelain"), "");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", "the agent commits everything", "--allow-empty");
  assert.equal(gitIn(dir, "show", `HEAD:${CLAUDE}/${TDD}/SKILL.md`), "the repo's own tdd\n", "HEAD still holds the repo's text");
  assert.equal(gitIn(dir, "ls-files", "--", `${CLAUDE}/${TDD}/scripts/check.sh`), "", "HQ's copy was not committed");

  // The next start: the clone is isolated again, and HQ's copy stays without drift.
  await again();
  const next = installSkills({ workspace: dir, cli: "claude", want: pick(lock, TDD), storeDir, movedDir: movesAt(d, 2) });
  assert.ok("installed" in next);
  assert.deepEqual([next.installed, next.drift.changed, next.drift.extra, next.drift.movedTo], [[TDD], [], [], null]);
  assert.equal(readFileSync(join(dir, CLAUDE, TDD, "SKILL.md"), "utf8"), "# tdd, as pinned\n");
  assert.equal(gitIn(dir, "status", "--porcelain"), "");
});

test("SR-F-05 [T-S12.3] a skill the repo tracks that is not in the set is absent", async (t) => {
  const { d, dir, lock, storeDir } = await hqClone(t, { [`${CLAUDE}/rogue/SKILL.md`]: "a skill the repo commits\n" });
  const r = installSkills({ workspace: dir, cli: "claude", want: pick(lock, TDD), storeDir, movedDir: movesAt(d, 1) });
  assert.ok("installed" in r);
  assert.equal(existsSync(join(dir, CLAUDE, "rogue")), false);
  // Even when the agent puts the repo's copy back on disk, the next start moves it out.
  gitIn(dir, "show", `HEAD:${CLAUDE}/rogue/SKILL.md`);
  put(dir, `${CLAUDE}/rogue/SKILL.md`, gitIn(dir, "show", `HEAD:${CLAUDE}/rogue/SKILL.md`));
  const next = installSkills({ workspace: dir, cli: "claude", want: pick(lock, TDD), storeDir, movedDir: movesAt(d, 2) });
  assert.ok("installed" in next);
  assert.deepEqual(next.drift.extra, [`${CLAUDE}/rogue`]);
  assert.equal(existsSync(join(dir, CLAUDE, "rogue")), false);
});

test("git status is clean with one tracked and one untracked skill installed", async (t) => {
  const { d, dir, lock, storeDir } = await hqClone(t, { [`${CLAUDE}/${TDD}/SKILL.md`]: "the repo's own tdd\n" });
  const r = installSkills({ workspace: dir, cli: "claude", want: pick(lock, TDD, "systematic-debugging"), storeDir, movedDir: movesAt(d, 1) });
  assert.ok("installed" in r);
  assert.deepEqual(r.installed, ["systematic-debugging", TDD]);
  assert.equal(gitIn(dir, "status", "--porcelain"), "");
});

// --- links and big folders in the agent's folder ---------------------------------------------

test("an agent's link at .claude/skills is refused and nothing is moved", async (t) => {
  const { hq, sessions, work, moves } = await pinnedHq(t);
  const outside = join(hq.scratch, "outside skills");
  put(outside, "one/SKILL.md", "outside\n");
  mkdirSync(join(work, ".claude"));
  if (!linkFolder(outside, join(work, CLAUDE))) return t.skip("this machine cannot create links");
  const before = snapshot(outside);

  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  const rows = hq.company.audit.query({ action: "workspace.refused" });
  assert.deepEqual(
    rows.map((r) => [r.actorId, r.data.reason, r.data.path]),
    [["owner", "skills-link", join(work, ".claude", "skills")]],
  );
  assert.deepEqual(snapshot(outside), before, "the outside folder is unchanged");
  assert.equal(existsSync(moves), false, "nothing was moved");
  const line = lastActivity(hq, /is a link/)[0] ?? "";
  assert.ok(line.includes(join(work, ".claude", "skills")), line);
  assert.match(line, /Delete that link .*, then start Ana again\.$/);
  assert.equal(hq.company.secrets.hasLive(companyAgentId(hq.slug, "ana")), false, "the refused start leaves no live secret");
});

test("a linked skill folder is removed as a link, and its target is unchanged", async (t) => {
  const d = scratch(t);
  const { lock, storeDir } = await pinnedStore(d);
  const work = join(d, "work");
  const outside = join(d, "outside");
  put(outside, "SKILL.md", "not HQ's\n");
  put(outside, "keep.md", "the target's own file\n");
  mkdirSync(join(work, CLAUDE), { recursive: true });
  if (!linkFolder(outside, join(work, CLAUDE, TDD))) return t.skip("this machine cannot create links");
  const before = snapshot(outside);

  const r = installSkills({ workspace: work, cli: "claude", want: pick(lock, TDD), storeDir, movedDir: movesAt(d, 1) });
  assert.ok("installed" in r);
  assert.deepEqual(r.drift.changed, [`${CLAUDE}/${TDD}`]);
  const st = lstatSync(join(work, CLAUDE, TDD));
  assert.equal(st.isSymbolicLink(), false);
  assert.equal(st.isDirectory(), true);
  assert.equal(readFileSync(join(work, CLAUDE, TDD, "SKILL.md"), "utf8"), "# tdd, as pinned\n");
  assert.deepEqual(snapshot(outside), before);
});

test("a move across drives copies without following links", async (t) => {
  const d = scratch(t);
  const { lock, storeDir } = await pinnedStore(d);
  const work = join(d, "work");
  const outside = join(d, "outside");
  put(outside, "secret.txt", "a host file\n");
  put(work, `${CLAUDE}/stray/SKILL.md`, "# stray\n");
  put(work, `${CLAUDE}/stray/sub/note.md`, "note\n");
  let link = `${CLAUDE}/stray/secret.txt`;
  try {
    symlinkSync(join(outside, "secret.txt"), join(work, link), "file");
  } catch {
    link = `${CLAUDE}/stray/secret`; // no rights for a file link: a junction to the outside folder
    if (!linkFolder(outside, join(work, link))) return t.skip("this machine cannot create links");
  }
  const before = snapshot(outside);
  const exdev = () => {
    throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
  };

  const r = installSkills({ workspace: work, cli: "claude", want: pick(lock, TDD), storeDir, movedDir: movesAt(d, 1), rename: exdev });
  assert.ok("installed" in r);
  const movedTo = r.drift.movedTo!;
  assert.deepEqual(snapshot(join(movedTo, CLAUDE, "stray")), { "SKILL.md": "# stray\n", "sub/note.md": "note\n" }, "moved without the link");
  assert.deepEqual(r.drift.linksSkipped, [link]);
  assert.equal(existsSync(join(work, CLAUDE, "stray")), false, "the source is gone");
  assert.deepEqual(snapshot(outside), before, "the outside file is unchanged");
});

test("an extra folder over 256 files refuses the start, and nothing is moved or deleted", async (t) => {
  for (const [label, fill] of [
    ["300 files", (root: string) => Array.from({ length: 300 }, (_, i) => put(root, `f${i}.md`, "x"))],
    ["one 3 MiB file", (root: string) => put(root, "the owner's document.pdf", Buffer.alloc(3 * 1024 * 1024, 7))],
  ] as const) {
    await t.test(label, async (t) => {
      const { hq, sessions, work, moves } = await pinnedHq(t);
      const big = join(work, ".claude", "skills", "big-folder");
      fill(big);
      put(work, `${CLAUDE}/small/x.md`, "small\n");
      const before = { big: readdirSync(big).sort(), small: snapshot(join(work, CLAUDE, "small")) };

      await sessions.start("ana", OWNER);
      assert.equal(hq.hub.status("ana")?.session.state, "failed");
      const rows = hq.company.audit.query({ action: "workspace.refused" });
      assert.deepEqual(
        rows.map((r) => [r.actorId, r.data.reason, r.data.path]),
        [["owner", "skills-too-big", big]],
      );
      const line = lastActivity(hq, /not one of its skills/)[0] ?? "";
      assert.ok(line.includes(big), line);
      assert.match(line, /then start Ana again\.$/);
      assert.deepEqual(readdirSync(big).sort(), before.big, "every file of that folder is in place");
      assert.deepEqual(snapshot(join(work, CLAUDE, "small")), before.small, "the other folders are untouched");
      assert.equal(existsSync(moves), false, "nothing was moved");
    });
  }
});

test("an install folder of more than 256 entries refuses the start with its own text, and nothing is moved", async (t) => {
  const d = scratch(t);
  const { lock, storeDir } = await pinnedStore(d);
  const work = join(d, "work");
  for (let i = 0; i < 300; i++) put(work, `${CLAUDE}/e${i}/SKILL.md`, "x");
  const r = installSkills({ workspace: work, cli: "claude", want: pick(lock, TDD), storeDir, movedDir: movesAt(d, 1) });
  const folder = join(work, ".claude", "skills");
  assert.deepEqual(r, { blocked: { reason: "skills-too-big", path: folder } });
  assert.equal(readdirSync(folder).length, 300);
  assert.equal(existsSync(join(d, "hq home", MOVES_DIRNAME)), false);
  const blocked = { reason: "skills-too-big" as const, path: folder };
  assert.equal(
    skillsBlockedText("Ana", work, blocked),
    "Ana's `.claude/skills` holds more than 256 entries, so HQ won't sort it. Move the extra folders out of the agent's folder (`" + folder + "`), then start Ana again.",
  );
  // An extra folder keeps the values table's text.
  assert.ok(skillsBlockedText("Ana", work, { ...blocked, path: join(folder, "big") }).startsWith("Ana's `.claude/skills/big` is not one of its skills and holds more than 256 files or 2 MiB"));
});

test("no agent's clone can be the moves folder or hold it", (t) => {
  const saved = process.env.HQ_HOME;
  process.env.HQ_HOME = scratch(t);
  t.after(() => (saved === undefined ? delete process.env.HQ_HOME : (process.env.HQ_HOME = saved)));
  // `_` is outside the agent-id alphabet, as with `_company`.
  assert.throws(() => managedWorkspace("demo", MOVES_DIRNAME));
  assert.throws(() => companyAgentId("demo", MOVES_DIRNAME));
  const moves = join(projectHome("demo"), MOVES_DIRNAME);
  for (const id of ["ana", "skills-removed", "skills", "a", "0"]) {
    const clone = managedWorkspace("demo", id);
    assert.notEqual(clone, moves);
    assert.equal(isInside(moves, clone), false, id);
    assert.equal(isInside(clone, moves), false, id);
  }
  assert.equal(dirname(skillMovesDir(projectHome("demo"), "ana", new Date(0))), join(moves, "ana"));
});

test("the size walk stops as soon as a folder passes the cap", async (t) => {
  const d = scratch(t);
  const crowded = join(d, "crowded");
  mkdirSync(crowded);
  for (let i = 0; i < 3000; i++) writeFileSync(join(crowded, `f${i}`), "");
  let visited = 0;
  assert.equal(overCap(crowded, { onVisit: () => visited++ }), true);
  assert.ok(visited <= 258, `visited ${visited} entries`);
  // Many empty folders end the walk too.
  const hollow = join(d, "hollow");
  for (let i = 0; i < 600; i++) mkdirSync(join(hollow, `d${i}`), { recursive: true });
  visited = 0;
  assert.equal(overCap(hollow, { onVisit: () => visited++ }), true);
  assert.ok(visited <= 258, `visited ${visited} entries`);
  // A folder within the cap is not over it.
  put(d, "fine/SKILL.md", "x");
  assert.equal(overCap(join(d, "fine")), false);
});

// --- which skills, and where -------------------------------------------------------------------

test("a Codex agent gets its skills in .agents/skills and none in .claude/skills", async (t) => {
  const d = scratch(t);
  const { lock, storeDir } = await pinnedStore(d);
  const work = join(d, "work");
  put(work, `${CLAUDE}/systematic-debugging/SKILL.md`, "# debugging, as pinned\n"); // a Claude Code copy left from before
  const r = installSkills({ workspace: work, cli: "codex", want: pick(lock, TDD, "systematic-debugging"), storeDir, movedDir: movesAt(d, 1) });
  assert.ok("installed" in r);
  assert.deepEqual(r.installed, ["systematic-debugging", TDD]);
  assert.deepEqual(readdirSync(join(work, ".agents", "skills")).sort(), ["systematic-debugging", TDD]);
  assert.deepEqual(readdirSync(join(work, CLAUDE)), [], "the folder Codex does not read is kept empty");
  assert.deepEqual(r.drift.extra, [`${CLAUDE}/systematic-debugging`]);
});

test("a stack skill that is not pinned is named in the start line, and the agent starts", async (t) => {
  const { hq, sessions, work } = await pinnedHq(t);
  hq.hub.snap.config.stack = { frameworks: [{ id: "nextjs" }], tools: {} };
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "running", hq.hub.status("ana")?.session.detail ?? "");
  const line = lastActivity(hq, /starts without/)[0] ?? "";
  assert.match(line, /next-dev-loop \(not pinned\)/);
  assert.deepEqual(
    refusedRows(hq)
      .filter((r) => r.data.skill === "next-dev-loop")
      .map((r) => [r.actorId, r.data.reason]),
    [["owner", "missing"]],
  );
  assert.ok(existsSync(join(work, CLAUDE, TDD, "SKILL.md")), "the pinned skills still install");
});

test("a company-level agent's start installs its role's set too", async (t) => {
  const { hq, sessions, work } = await pinnedHq(t);
  hq.company.agents.setRole(hq.slug, "ana", "ceo", OWNER);
  hq.hub.snap.config.stack = { frameworks: [{ id: "nextjs" }], tools: {} };
  sessions.githubKeyFor = async () => null;
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "running", hq.hub.status("ana")?.session.detail ?? "");
  const dir = hq.hub.status("ana")!.session.workspace!;
  assert.notEqual(dir, work);
  assert.deepEqual(readdirSync(join(dir, CLAUDE)), ["verification-before-completion"]);
  assert.equal(lastActivity(hq, /next-dev-loop/).length, 0, "no stack skills for a company-level agent");
});

test("the moves keep the newest 5 per agent", async (t) => {
  const d = scratch(t);
  const { lock, storeDir } = await pinnedStore(d);
  const work = join(d, "work");
  const base = join(d, "hq home");
  const stamps: string[] = [];
  for (let i = 0; i < 7; i++) {
    put(work, `${CLAUDE}/stray-${i}/SKILL.md`, `# stray ${i}\n`);
    const movedDir = skillMovesDir(base, "ana", new Date(Date.UTC(2026, 10, 16, 8, 0, i)));
    stamps.push(movedDir.split(/[\\/]/).pop()!);
    const r = installSkills({ workspace: work, cli: "claude", want: pick(lock, TDD), storeDir, movedDir });
    assert.ok("installed" in r);
    assert.equal(r.drift.movedTo, movedDir);
  }
  assert.deepEqual(readdirSync(join(base, MOVES_DIRNAME, "ana")).sort(), stamps.slice(2));
  assert.equal(stamps[0], "2026-11-16T08-00-00-000Z");
});

test("a link in HQ's moves folder is refused before anything is moved through it", async (t) => {
  const d = scratch(t);
  const { lock, storeDir } = await pinnedStore(d);
  const work = join(d, "work");
  const base = join(d, "hq home");
  const elsewhere = join(d, "elsewhere");
  mkdirSync(elsewhere);
  mkdirSync(join(base, MOVES_DIRNAME), { recursive: true });
  if (!linkFolder(elsewhere, join(base, MOVES_DIRNAME, "ana"))) return t.skip("this machine cannot create links");
  put(work, `${CLAUDE}/stray/SKILL.md`, "# stray\n");
  const movedDir = skillMovesDir(base, "ana", new Date(Date.UTC(2026, 10, 16)));
  assert.throws(() => installSkills({ workspace: work, cli: "claude", want: pick(lock, TDD), storeDir, movedDir }), /not a plain folder/);
  assert.deepEqual(readdirSync(elsewhere), [], "nothing was made through the link");
  assert.equal(readFileSync(join(work, CLAUDE, "stray", "SKILL.md"), "utf8"), "# stray\n");
});

test("effectiveSkills: role set, grants and stack; only pinned skills install", async (t) => {
  const d = scratch(t);
  const { lock } = await pinnedStore(d);
  const r = effectiveSkills({ roleSet: [TDD, "not-in-the-lock"], grants: ["writing-plans", TDD], stack: ["next-dev-loop", "systematic-debugging"], companyLevel: false, lock });
  assert.deepEqual(
    r.install.map((s) => s.name),
    ["systematic-debugging", TDD, "writing-plans"],
  );
  assert.deepEqual(r.missing, ["next-dev-loop", "not-in-the-lock"]);
  const company = effectiveSkills({ roleSet: ["verification-before-completion"], grants: [], stack: ["next-dev-loop", "systematic-debugging"], companyLevel: true, lock });
  assert.deepEqual([company.install.map((s) => s.name), company.missing], [["verification-before-completion"], []]);
});

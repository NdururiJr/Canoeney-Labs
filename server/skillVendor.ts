// Reads a pinned commit of the company's skills repo with plain git (M0-F;
// threat model SR-F-01, SR-F-06; docs/adr/0011). Nothing is checked out and
// nothing a skill holds is ever run: the only process started here is git, and
// file bytes come from `git cat-file --batch`.
//
// - fetchCommit: fetches the repo's default branch (never a commit by its SHA)
//   and accepts the commit only if that branch holds it.
// - readCommit: lists `skills/<name>/` in the commit and refuses any skill with a
//   link, a submodule, an odd mode, a path that leaves its folder or that Windows
//   cannot hold, two paths differing only in case, a bad name, no SKILL.md, or
//   more than 256 files or 2 MiB. The rest are hashed for the lock.
// - writeStore / hashFolder: the content store, and checking a folder on disk
//   against the lock without following a link.
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix as posixPath } from "node:path";
import { canonicalJson } from "./company/canonicalJson";
import { SKILL_NAME, type LockedSkill } from "./company/companySkills";

const COMMIT = /^[0-9a-f]{40}$/;
const SKILL_HASH = /^[0-9a-f]{64}$/;
const REGULAR = new Set(["100644", "100755"]);
const MAX_FILES = 256;
const MAX_BYTES = 2 * 1024 * 1024;
const SCRIPT_EXT = new Set([".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".ps1", ".rb", ".pl"]);
const GIT_TIMEOUT_MS = 120_000;

export type SkillRefusal = "link" | "submodule" | "mode" | "path" | "case-collision" | "name" | "no-skill-md" | "too-big";
type SkillFile = LockedSkill["files"][number];

// --- running git ----------------------------------------------------------

/** No credential helper, https only (file too when a test asks), and never a prompt. */
function gitFlags(allowFile: boolean): string[] {
  return ["-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", ...(allowFile ? ["-c", "protocol.file.allow=always"] : [])];
}

function gitEnv(): NodeJS.ProcessEnv {
  // An empty askpass stops git from asking a program for a password as well.
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
}

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Runs git with this module's flags and environment. Never throws; check `ok`. */
export function vendorGit(args: string[], o: { allowFile?: boolean; input?: string; timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      [...gitFlags(o.allowFile ?? false), ...args],
      { encoding: "buffer", env: gitEnv(), timeout: o.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? Number((err as NodeJS.ErrnoException).code) : null) : 0;
        resolve({ ok: !err, code, stdout, stderr: stderr.toString() || (err ? err.message : "") });
      },
    );
    // A git that exits before reading its input closes the pipe (EPIPE): the result above still reports it.
    child.stdin?.on("error", () => {});
    child.stdin?.end(o.input ?? "");
  });
}

function vendorGitSync(args: string[], input = ""): Buffer {
  return execFileSync("git", [...gitFlags(false), ...args], { input, env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}

// --- fetching -----------------------------------------------------------------

/**
 * Fetches the default branch of `url` into `refs/hq/default` of the bare repo
 * `bare` (made if missing) and accepts `sha` only when that branch holds it. A
 * commit is never fetched by its SHA, so a commit only on a pull-request ref
 * never reaches the bare repo.
 */
export async function fetchCommit(o: {
  url: string;
  sha: string;
  bare: string;
  allowFile?: boolean;
}): Promise<{ ok: true; branch: string } | { ok: false; reason: "bad-sha" | "fetch-failed" | "not-on-default-branch" }> {
  if (!COMMIT.test(o.sha)) return { ok: false, reason: "bad-sha" };
  const failed = { ok: false, reason: "fetch-failed" } as const;
  if (o.url.startsWith("-")) return failed;
  const git = (args: string[]) => vendorGit([`--git-dir=${o.bare}`, ...args], { allowFile: o.allowFile });

  if (!existsSync(join(o.bare, "HEAD"))) {
    mkdirSync(o.bare, { recursive: true });
    if (!(await vendorGit(["init", "-q", "--bare", o.bare])).ok) return failed;
  }

  const head = await git(["ls-remote", "--symref", o.url, "HEAD"]);
  if (!head.ok) return failed;
  const m = /^ref: refs\/heads\/([^\t\n]+)\tHEAD$/m.exec(head.stdout.toString("utf8"));
  if (!m) return failed;
  const branch = m[1];
  if (!(await git(["check-ref-format", `refs/heads/${branch}`])).ok) return failed;

  // Full history: the repo is small, and the ancestry check needs it.
  const fetched = await git(["fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", o.url, `+refs/heads/${branch}:refs/hq/default`]);
  if (!fetched.ok) return failed;

  // Missing from the bare repo, or not an ancestor of the default branch.
  const onBranch = await git(["merge-base", "--is-ancestor", o.sha, "refs/hq/default"]);
  if (!onBranch.ok) return { ok: false, reason: "not-on-default-branch" };
  return { ok: true, branch };
}

// --- the path and name rules ---------------------------------------------------

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
// Characters Windows refuses in a name; `:` would write an NTFS stream.
const NOT_ON_WINDOWS = /[\u0000-\u001f<>:"|?*\\]/;

/** A path segment or folder name Windows can hold. */
function windowsSafeName(seg: string): boolean {
  if (seg === "" || /[. ]$/.test(seg) || NOT_ON_WINDOWS.test(seg)) return false;
  const base = seg.split(".")[0].replace(/ +$/, "");
  return !RESERVED.test(base);
}

/** The plan's skill folder rule, plus a name Windows can hold (so not `aux`). */
export function validSkillName(name: string): boolean {
  return SKILL_NAME.test(name) && windowsSafeName(name);
}

/**
 * True for a relative path, with `/` between segments, that stays in its skill
 * folder and that Windows can hold: no `.` or `..` or empty segment, no leading
 * `/`, no `\` or NUL, no reserved device name, no segment ending in `.` or a space.
 */
export function safeSkillPath(path: string): boolean {
  if (typeof path !== "string" || path === "" || path.startsWith("/")) return false;
  return path.split("/").every((s) => s !== "." && s !== ".." && windowsSafeName(s));
}

// --- hashing --------------------------------------------------------------------

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const bytewise = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/** sha256 over `"<mode> <path>\0<sha256>\n"` per file, sorted bytewise by path. */
export function skillHash(files: { path: string; mode: string; sha256: string }[]): string {
  return sha256(
    [...files]
      .sort((a, b) => bytewise(a.path, b.path))
      .map((f) => `${f.mode} ${f.path}\0${f.sha256}\n`)
      .join(""),
  );
}

/** sha256 of the canonical JSON of `{ repo, commit, skills }`, skills sorted by name. */
export function lockHash(repo: string, commit: string, skills: { name: string; hash: string }[]): string {
  const sorted = [...skills].sort((a, b) => bytewise(a.name, b.name)).map((s) => ({ name: s.name, hash: s.hash }));
  return sha256(canonicalJson({ repo, commit, skills: sorted }));
}

function isScript(path: string, mode: string): boolean {
  return mode === "100755" || SCRIPT_EXT.has(posixPath.extname(path).toLowerCase());
}

// --- reading a commit -----------------------------------------------------------

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  size: number;
  path: string;
  /** The path was not valid UTF-8. */
  badBytes: boolean;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Parses `git ls-tree -r -z -l` output (with -l, git does not quote paths under -z). */
function parseLsTree(out: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let start = 0;
  while (start < out.length) {
    let end = out.indexOf(0, start);
    if (end < 0) end = out.length;
    const rec = out.subarray(start, end);
    start = end + 1;
    const tab = rec.indexOf(0x09);
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)$/.exec(rec.subarray(0, tab).toString("latin1"));
    if (tab < 0 || !m) throw new Error("git ls-tree printed a line HQ cannot read.");
    const raw = rec.subarray(tab + 1);
    let path: string;
    let badBytes = false;
    try {
      path = utf8.decode(raw);
    } catch {
      path = raw.toString("utf8");
      badBytes = true;
    }
    entries.push({ mode: m[1], type: m[2], oid: m[3], size: m[4] === "-" ? 0 : Number(m[4]), path, badBytes });
  }
  return entries;
}

async function lsTree(bare: string, sha: string, prefix: string): Promise<TreeEntry[]> {
  const r = await vendorGit(["--literal-pathspecs", `--git-dir=${bare}`, "ls-tree", "-r", "-z", "-l", sha, "--", prefix]);
  if (!r.ok) throw new Error(`git could not list commit ${sha}: ${r.stderr.trim()}`);
  // Byte-exact prefix: a case-insensitive repo must not match `Skills/`.
  return parseLsTree(r.stdout).filter((e) => e.path.startsWith(prefix));
}

/** The first reason a skill's entries are refused, or null. Paths are relative to the skill folder. */
function refusal(name: string, entries: TreeEntry[]): SkillRefusal | null {
  if (!validSkillName(name)) return "name";
  if (entries.some((e) => e.mode === "120000")) return "link";
  if (entries.some((e) => e.mode === "160000")) return "submodule";
  if (entries.some((e) => !REGULAR.has(e.mode) || e.type !== "blob")) return "mode";
  if (entries.some((e) => e.badBytes || !safeSkillPath(e.path))) return "path";

  // Two entries at one path, or a file where another entry needs a folder.
  const paths = new Set<string>();
  const folders = new Set<string>();
  for (const e of entries) {
    if (paths.has(e.path)) return "path";
    paths.add(e.path);
    const segs = e.path.split("/");
    for (let i = 1; i < segs.length; i++) folders.add(segs.slice(0, i).join("/"));
  }
  for (const p of paths) if (folders.has(p)) return "path";

  // Every prefix compared without case: `Docs/a.md` and `docs/b.md` land in one folder on Windows.
  const seen = new Map<string, string>();
  for (const p of [...paths, ...folders]) {
    const key = p.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined && other !== p) return "case-collision";
    seen.set(key, p);
  }

  if (!entries.some((e) => e.path === "SKILL.md")) return "no-skill-md";
  if (entries.length > MAX_FILES || entries.reduce((n, e) => n + e.size, 0) > MAX_BYTES) return "too-big";
  return null;
}

/** Streams `git cat-file --batch` (one process) and hashes each object's bytes. */
function hashObjects(bare: string, oids: string[]): Promise<Map<string, { type: string; size: number; sha256: string }>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, { type: string; size: number; sha256: string }>();
    const child = spawn("git", [...gitFlags(false), `--git-dir=${bare}`, "cat-file", "--batch"], { env: gitEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail("git cat-file took too long."), GIT_TIMEOUT_MS);
    let buf = Buffer.alloc(0);
    let cur: { oid: string; type: string; size: number; left: number; hash: ReturnType<typeof createHash> } | null = null;
    child.stdout.on("data", (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (!cur) {
          const nl = buf.indexOf(0x0a);
          if (nl < 0) return;
          const header = buf.subarray(0, nl).toString("latin1");
          buf = buf.subarray(nl + 1);
          const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(header);
          if (!m) return fail(`git cat-file could not read an object: ${header}`);
          cur = { oid: m[1], type: m[2], size: Number(m[3]), left: Number(m[3]), hash: createHash("sha256") };
        }
        if (cur.left > 0) {
          const take = Math.min(cur.left, buf.length);
          cur.hash.update(buf.subarray(0, take));
          buf = buf.subarray(take);
          cur.left -= take;
          if (cur.left > 0) return;
        }
        if (buf.length === 0) return; // the newline after the object
        buf = buf.subarray(1);
        out.set(cur.oid, { type: cur.type, size: cur.size, sha256: cur.hash.digest("hex") });
        cur = null;
      }
    });
    child.stderr.resume();
    child.on("error", (e) => fail(`git cat-file did not start: ${e.message}`));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0 || cur || oids.some((o) => !out.has(o))) return fail("git cat-file stopped before every object was read.");
      settled = true;
      clearTimeout(timer);
      resolve(out);
    });
    child.stdin.on("error", () => {}); // an early exit is reported by "close"
    child.stdin.end(oids.map((o) => `${o}\n`).join(""));
  });
}

/**
 * Reads every skill under `skills/` in commit `sha` of the bare repo. A refused
 * skill is named with its reason and the others are still read; the caller
 * refuses the whole pin if any is refused.
 */
export async function readCommit(bare: string, sha: string): Promise<{ skills: LockedSkill[]; refused: { skill: string; reason: SkillRefusal }[] }> {
  if (!COMMIT.test(sha)) throw new Error(`"${sha}" is not a 40-character commit id.`);
  const groups = new Map<string, TreeEntry[]>();
  const refused = new Map<string, SkillRefusal>();
  for (const e of await lsTree(bare, sha, "skills/")) {
    const rest = e.path.slice("skills/".length);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      // An entry right under skills/: a file there is not a skill, but a link or submodule in a skill's place is refused.
      if (e.mode === "120000") refused.set(rest, "link");
      else if (e.mode === "160000") refused.set(rest, "submodule");
      continue;
    }
    const name = rest.slice(0, slash);
    const list = groups.get(name) ?? [];
    list.push({ ...e, path: rest.slice(slash + 1) });
    groups.set(name, list);
  }

  const accepted: [string, TreeEntry[]][] = [];
  for (const [name, entries] of groups) {
    if (refused.has(name)) continue;
    const why = refusal(name, entries);
    if (why) refused.set(name, why);
    else accepted.push([name, entries]);
  }

  const oids = [...new Set(accepted.flatMap(([, es]) => es.map((e) => e.oid)))];
  const objects = oids.length ? await hashObjects(bare, oids) : new Map();
  const skills: LockedSkill[] = accepted.map(([name, entries]) => {
    const files: SkillFile[] = entries
      .map((e) => {
        const obj = objects.get(e.oid);
        if (!obj || obj.type !== "blob" || obj.size !== e.size) throw new Error(`git returned an unexpected object for ${name}/${e.path}.`);
        return { path: e.path, mode: e.mode, sha256: obj.sha256 };
      })
      .sort((a, b) => bytewise(a.path, b.path));
    return { name, hash: skillHash(files), files, scripts: files.filter((f) => isScript(f.path, f.mode)).map((f) => f.path) };
  });

  return {
    skills: skills.sort((a, b) => bytewise(a.name, b.name)),
    refused: [...refused].map(([skill, reason]) => ({ skill, reason })).sort((a, b) => bytewise(a.skill, b.skill)),
  };
}

// --- the content store -------------------------------------------------------------

/** Reads whole objects from one `git cat-file --batch` run (one skill: at most 2 MiB). */
function readObjects(bare: string, oids: string[]): Map<string, { type: string; data: Buffer }> {
  const out = vendorGitSync([`--git-dir=${bare}`, "cat-file", "--batch"], oids.map((o) => `${o}\n`).join(""));
  const objects = new Map<string, { type: string; data: Buffer }>();
  let at = 0;
  while (at < out.length) {
    const nl = out.indexOf(0x0a, at);
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(out.subarray(at, nl < 0 ? out.length : nl).toString("latin1"));
    if (nl < 0 || !m) throw new Error("git cat-file could not read an object.");
    const size = Number(m[3]);
    objects.set(m[1], { type: m[2], data: out.subarray(nl + 1, nl + 1 + size) });
    at = nl + 1 + size + 1;
  }
  return objects;
}

function checkLockedSkill(skill: LockedSkill): void {
  if (!validSkillName(skill.name)) throw new Error(`"${skill.name}" is not a skill name.`);
  if (!SKILL_HASH.test(skill.hash)) throw new Error(`The lock's hash for ${skill.name} is not a sha256.`);
  for (const f of skill.files) {
    if (!safeSkillPath(f.path) || !REGULAR.has(f.mode) || !SKILL_HASH.test(f.sha256)) throw new Error(`The lock's entry ${skill.name}/${f.path} is not valid.`);
  }
  if (new Set(skill.files.map((f) => f.path)).size !== skill.files.length) throw new Error(`The lock lists a path of ${skill.name} twice.`);
  if (skillHash(skill.files) !== skill.hash) throw new Error(`The lock's hash for ${skill.name} does not match its files.`);
}

/**
 * Writes `<storeDir>/<skill hash>/` from the git objects of commit `sha` (never
 * a checkout), setting each file's mode on POSIX. Throws, writing nothing, when
 * the commit does not hold exactly the locked files and bytes. A store folder
 * already there is kept if it still matches, and rewritten if not.
 */
export function writeStore(bare: string, sha: string, skill: LockedSkill, storeDir: string): void {
  if (!COMMIT.test(sha)) throw new Error(`"${sha}" is not a 40-character commit id.`);
  checkLockedSkill(skill);

  const prefix = `skills/${skill.name}/`;
  const listed = parseLsTree(vendorGitSync(["--literal-pathspecs", `--git-dir=${bare}`, "ls-tree", "-r", "-z", "-l", sha, "--", prefix])).filter((e) => e.path.startsWith(prefix));
  const inCommit = new Map(listed.map((e) => [e.path.slice(prefix.length), e]));
  if (inCommit.size !== listed.length || inCommit.size !== skill.files.length) throw new Error(`Commit ${sha} does not hold the locked files of ${skill.name}.`);
  for (const f of skill.files) {
    const e = inCommit.get(f.path);
    if (!e || e.mode !== f.mode || e.type !== "blob" || e.badBytes) throw new Error(`Commit ${sha} does not hold ${skill.name}/${f.path} as locked.`);
  }
  const objects = readObjects(bare, [...new Set(listed.map((e) => e.oid))]);
  const data = new Map<string, Buffer>();
  for (const f of skill.files) {
    const obj = objects.get(inCommit.get(f.path)!.oid);
    if (!obj || obj.type !== "blob" || sha256(obj.data) !== f.sha256) throw new Error(`${skill.name}/${f.path} in commit ${sha} does not match the lock.`);
    data.set(f.path, obj.data);
  }

  const final = join(storeDir, skill.hash);
  if (existsSync(final)) {
    const now = hashFolder(final, skill.files);
    if ("hash" in now && now.hash === skill.hash) return;
    rmSync(final, { recursive: true, force: true });
  }
  mkdirSync(storeDir, { recursive: true });
  const tmp = join(storeDir, `.tmp-${skill.hash}-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    mkdirSync(tmp);
    for (const f of skill.files) {
      const target = join(tmp, ...f.path.split("/"));
      const mode = f.mode === "100755" ? 0o755 : 0o644;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data.get(f.path)!, { flag: "wx", mode });
      if (process.platform !== "win32") chmodSync(target, mode); // the umask may have cleared bits
    }
    const check = hashFolder(tmp, skill.files);
    if (!("hash" in check) || check.hash !== skill.hash) throw new Error(`The store copy of ${skill.name} does not match the lock.`);
    renameSync(tmp, final);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

// --- checking a folder on disk -------------------------------------------------------

export type FolderRefusal = "link" | "not-file" | "paths" | "mode" | "too-big";

/** Test seams: see each entry and file the check touches. */
export interface HashFolderHooks {
  /** Called for every entry the walk lstats. */
  onVisit?: (path: string) => void;
  /** Called just before a file is opened (a test swaps the file here). */
  beforeOpen?: (path: string) => void;
  /** Called just before a file's bytes are read. */
  onRead?: (path: string) => void;
}

/** The names in a folder, read one at a time (a folder of millions of entries is never listed whole). */
export function* folderEntries(dir: string): Generator<string> {
  const d = opendirSync(dir);
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) yield e.name;
  } finally {
    d.closeSync();
  }
}

// O_NOFOLLOW: a file swapped for a link since the walk is not followed. O_NONBLOCK: a FIFO
// swapped in is opened without waiting for a writer, then refused by fstat. Windows has neither.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

type FileRefusal = { refused: "link" | "not-file" | "paths" | "too-big" };

/**
 * Opens a regular file without following a link or waiting on a FIFO, and hashes
 * at most `budget` bytes of it. A file larger than the budget is refused from its
 * size before any byte is read. `keep` also returns the bytes.
 */
function readRegular(abs: string, budget: number, hooks: HashFolderHooks, keep: boolean): { sha256: string; bytes: number; mode: number; data: Buffer[] } | FileRefusal {
  let fd: number;
  try {
    fd = openSync(abs, OPEN_FLAGS);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") return { refused: "link" };
    if (code === "ENOENT" || code === "ENOTDIR") return { refused: "paths" };
    if (code === "EISDIR" || code === "ENXIO" || code === "EPERM" || code === "EACCES") return { refused: "not-file" };
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { refused: "not-file" };
    if (st.size > budget) return { refused: "too-big" };
    hooks.onRead?.(abs);
    const hash = createHash("sha256");
    const data: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      bytes += n;
      if (bytes > budget) return { refused: "too-big" }; // it grew since the fstat
      hash.update(buf.subarray(0, n));
      if (keep) data.push(Buffer.from(buf.subarray(0, n)));
    }
    return { sha256: hash.digest("hex"), bytes, mode: st.mode, data };
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads a file in a folder an agent controls: a regular file only, never through
 * a link, never waiting on a FIFO, and at most `budget` bytes (`too-big` past it).
 */
export function readRegularFile(abs: string, budget: number): { data: Buffer; mode: number } | FileRefusal {
  const r = readRegular(abs, budget, {}, true);
  return "refused" in r ? r : { data: Buffer.concat(r.data), mode: r.mode };
}

/**
 * Hashes a skill folder on disk against the locked file list. The folder must
 * hold exactly the locked paths, all regular files; no link is followed. Each
 * mode is taken from the lock, so the hash equals the lock's only when every
 * byte matches. On POSIX the executable bit must also match the mode; NTFS keeps
 * no executable bit, so Windows does not check it. The caller compares `hash`.
 *
 * The folder may be in an agent's folder, which the agent controls: the walk
 * stops at the first entry the lock does not list, a FIFO or a link swapped in
 * after the walk is refused when opened, and no more than 256 files or 2 MiB
 * are read (`too-big`), a file over what is left being refused from its size.
 */
export function hashFolder(dir: string, files: LockedSkill["files"], hooks: HashFolderHooks = {}): { hash: string } | { refused: FolderRefusal } {
  if (files.length > MAX_FILES) return { refused: "too-big" };
  const want = new Map(files.map((f) => [f.path, f]));
  if (want.size !== files.length || files.some((f) => !safeSkillPath(f.path) || !REGULAR.has(f.mode))) return { refused: "paths" };
  const wantFolders = new Set<string>();
  for (const f of files) {
    const segs = f.path.split("/");
    for (let i = 1; i < segs.length; i++) wantFolders.add(segs.slice(0, i).join("/"));
  }

  const root = lstatSync(dir, { throwIfNoEntry: false });
  if (!root) return { refused: "paths" };
  if (root.isSymbolicLink()) return { refused: "link" };
  if (!root.isDirectory()) return { refused: "not-file" };

  // Every entry must be a locked file or a folder on the way to one, so the walk
  // ends at the first that is not: it never visits more entries than the lock names.
  let found = 0;
  const walk = (rel: string): FolderRefusal | null => {
    for (const name of folderEntries(rel ? join(dir, ...rel.split("/")) : dir)) {
      const childRel = rel ? `${rel}/${name}` : name;
      const abs = join(dir, ...childRel.split("/"));
      hooks.onVisit?.(abs);
      const st = lstatSync(abs, { throwIfNoEntry: false });
      if (!st) return "paths";
      if (st.isSymbolicLink()) return "link";
      if (st.isDirectory()) {
        if (!wantFolders.has(childRel)) return "paths";
        const inner = walk(childRel);
        if (inner) return inner;
      } else if (st.isFile()) {
        if (!want.has(childRel)) return "paths";
        found++;
      } else return "not-file";
    }
    return null;
  };
  const bad = walk("");
  if (bad) return { refused: bad };
  if (found !== want.size) return { refused: "paths" };

  const posixHost = process.platform !== "win32";
  const hashed: SkillFile[] = [];
  let budget = MAX_BYTES;
  for (const f of files) {
    const abs = join(dir, ...f.path.split("/"));
    hooks.beforeOpen?.(abs);
    const r = readRegular(abs, budget, hooks, false);
    if ("refused" in r) return { refused: r.refused };
    if (posixHost && ((r.mode & 0o100) !== 0) !== (f.mode === "100755")) return { refused: "mode" };
    budget -= r.bytes;
    hashed.push({ path: f.path, mode: f.mode, sha256: r.sha256 });
  }
  return { hash: skillHash(hashed) };
}

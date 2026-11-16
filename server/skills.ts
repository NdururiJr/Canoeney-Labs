// Each agent's skills (M0-F; threat model SR-F-01, 02, 04, 05; docs/adr/0011).
// At every start HQ installs exactly the agent's pinned skills from its own
// content store into the agent's folder: Claude Code reads .claude/skills/,
// Codex reads .agents/skills/, and the folder the agent's CLI does not read is
// kept empty. Nothing is fetched and nothing a skill holds is run: this file
// starts no process.
//
// The agent controls its folder, so every step there goes through
// lib/agentFs.ts and walks with lstat, never following a link. A link at
// .claude, .agents or either skills folder refuses the start. A changed or extra
// skill is moved out to HQ's home, never deleted (it may be the owner's own
// files in a chosen folder); only a link is removed. A changed or extra folder
// over 256 files or 2 MiB refuses the start instead, with nothing moved.

import { closeSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { excludeFromGit } from "./agentFiles";
import type { LockedSkill } from "./company/companySkills";
import { agentMkdir, agentPath, agentRemove } from "./lib/agentFs";
import { folderEntries, hashFolder, readRegularFile, validSkillName } from "./skillVendor";

/** Where each CLI reads skills, relative to the agent's folder. */
export const INSTALL_FOLDERS = { claude: ".claude/skills", codex: ".agents/skills" } as const;
/** A link at any of these refuses the start. */
const LINK_REFUSED = [".claude", ".claude/skills", ".agents", ".agents/skills"];
/** One skill's cap, the same as at pin: a changed or extra folder over it is not moved. */
export const MAX_FILES = 256;
export const MAX_BYTES = 2 * 1024 * 1024;
/** Moves kept per agent. */
export const KEEP_MOVES = 5;

const SKILL_HASH = /^[0-9a-f]{64}$/;
const posixHost = process.platform !== "win32";

/**
 * The skills an agent gets: its role's set, its own grants and (for a project
 * agent) its project's stack skills. Only pinned skills install; any other name
 * is `missing`. A company-level agent gets no stack skills.
 */
export function effectiveSkills(o: { roleSet: string[]; grants: string[]; stack: string[]; companyLevel: boolean; lock: LockedSkill[] }): { install: LockedSkill[]; missing: string[] } {
  const names = [...new Set([...o.roleSet, ...o.grants, ...(o.companyLevel ? [] : o.stack)])].sort();
  const pinned = new Map(o.lock.map((s) => [s.name, s]));
  const install: LockedSkill[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const s = pinned.get(n);
    if (s) install.push(s);
    else missing.push(n);
  }
  return { install, missing };
}

/** `<base>/skills-removed/<agent id>/<UTC stamp>`: where one start's drift is moved. `agentId` may be `project/agent`. */
export function skillMovesDir(base: string, agentId: string, now: Date): string {
  return join(base, "skills-removed", ...agentId.split("/"), now.toISOString().replace(/[:.]/g, "-"));
}

export interface SkillDrift {
  /** Wanted (or refused) skills whose folder differed from HQ's copy, as `<install folder>/<name>`. */
  changed: string[];
  /** Entries that are not one of the agent's skills. */
  extra: string[];
  /** Wanted skills that were not in the agent's folder (HQ installed them). */
  missing: string[];
  /** Where the changed and extra folders went, or null if nothing was moved. */
  movedTo: string | null;
  /** Links and special files a move across drives did not copy (they were not followed). */
  linksSkipped: string[];
}

export type InstallResult =
  | { installed: string[]; refused: { skill: string; reason: "hash" | "missing" }[]; drift: SkillDrift }
  | { blocked: { reason: "skills-link" | "skills-too-big"; path: string } };

/** The start refusal's text: the absolute path and the one fix (the workspace is a host folder, so recreating the sandbox does not clear it). */
export function skillsBlockedText(agentName: string, workspace: string, blocked: { reason: "skills-link" | "skills-too-big"; path: string }): string {
  const rel = relative(workspace, blocked.path).split(sep).join("/");
  return blocked.reason === "skills-link"
    ? `${agentName}'s \`${rel}\` is a link, so HQ won't install skills through it. Delete that link (\`${blocked.path}\`), then start ${agentName} again.`
    : `${agentName}'s \`${rel}\` is not one of its skills and holds more than 256 files or 2 MiB, so HQ won't move it aside. Move that folder out of the agent's folder (\`${blocked.path}\`), then start ${agentName} again.`;
}

/** The start's activity line for skills it could not install, or null. */
export function skillsMissingText(agentName: string, refused: { skill: string; reason: "hash" | "missing" }[], notPinned: string[]): string | null {
  const parts = [
    ...refused.map((r) => `${r.skill} (${r.reason === "hash" ? "HQ's copy no longer matches the pin" : "HQ's copy is missing"})`),
    ...notPinned.map((n) => `${n} (not pinned)`),
  ];
  return parts.length ? `${agentName} starts without these skills: ${parts.join(", ")}.` : null;
}

/**
 * Measures a changed or extra entry with lstat, links not followed, and stops as
 * soon as it passes the cap: an agent could fill its folder with millions of
 * files, and this runs on the host at every start. Counts regular files and
 * their bytes against the cap; folders, links and special files have their own
 * bound of 256, so a folder of empty folders ends the walk early too.
 */
export function overCap(abs: string, hooks: { onVisit?: (path: string) => void } = {}): boolean {
  let files = 0;
  let others = 0;
  let bytes = 0;
  const over = () => files > MAX_FILES || bytes > MAX_BYTES || others > MAX_FILES;
  const visit = (p: string): boolean => {
    hooks.onVisit?.(p);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) return false;
    if (st.isFile()) {
      files++;
      bytes += st.size;
      return over();
    }
    others++;
    if (over()) return true;
    if (st.isDirectory() && !st.isSymbolicLink()) {
      for (const name of folderEntries(p)) if (visit(join(p, name))) return true;
    }
    return false;
  };
  return visit(abs);
}

/**
 * Copies `src` to `dst` (a move across drives) without following a link: links
 * and special files are not copied and are named in `skipped`. False when the
 * folder grew past the cap since it was measured (nothing is then removed).
 */
function copyNoFollow(src: string, dst: string, rel: string, skipped: string[], budget: { files: number; bytes: number }): boolean {
  const st = lstatSync(src, { throwIfNoEntry: false });
  if (!st) return true;
  if (st.isSymbolicLink()) {
    skipped.push(rel);
    return true;
  }
  if (st.isDirectory()) {
    mkdirSync(dst);
    for (const name of folderEntries(src)) if (!copyNoFollow(join(src, name), join(dst, name), `${rel}/${name}`, skipped, budget)) return false;
    return true;
  }
  if (!st.isFile()) {
    skipped.push(rel);
    return true;
  }
  if (--budget.files < 0) return false;
  const r = readRegularFile(src, budget.bytes);
  if ("refused" in r) {
    if (r.refused === "too-big") return false;
    skipped.push(rel); // swapped for a link or a special file since the lstat
    return true;
  }
  budget.bytes -= r.data.length;
  writeNew(dst, r.data, r.mode & 0o777);
  return true;
}

/** Creates a new file (never through a link: O_EXCL) and sets its mode on the open file. */
function writeNew(abs: string, data: Buffer, mode: number): void {
  const fd = openSync(abs, "wx", mode);
  try {
    let at = 0;
    while (at < data.length) at += writeSync(fd, data, at, data.length - at);
    if (posixHost) fchmodSync(fd, mode); // the umask may have cleared bits
  } finally {
    closeSync(fd);
  }
}

/**
 * Makes the moves folder in HQ's home one level at a time from `skills-removed`
 * down, refusing a link on the way before anything is made through it.
 */
function makeMovesDir(want: string): string {
  const parts: string[] = [];
  let top = want;
  while (basename(top) !== "skills-removed") {
    if (dirname(top) === top) throw new Error(`${want} is not under a skills-removed folder.`);
    parts.unshift(basename(top));
    top = dirname(top);
  }
  mkdirSync(dirname(top), { recursive: true }); // HQ's own home
  let dir = top;
  for (const [i, part] of ["", ...parts].entries()) {
    if (i > 0) dir = join(dir, part);
    const last = i === parts.length;
    if (last) for (let n = 2; existsSync(dir); n++) dir = `${join(dirname(dir), part)}-${n}`; // two starts in one millisecond
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (st?.isSymbolicLink() || (st && !st.isDirectory())) throw new Error(`${dir} is not a plain folder; HQ won't move skills into it.`);
    if (!st) mkdirSync(dir);
  }
  return dir;
}

/** Keeps the newest `keep` moves in an agent's moves folder (stamps sort by time). */
function pruneMoves(agentDir: string, keep: number): void {
  const stamps = [...folderEntries(agentDir)].sort();
  for (const old of stamps.slice(0, Math.max(0, stamps.length - keep))) rmSync(join(agentDir, old), { recursive: true, force: true });
}

/**
 * Installs exactly `want` into the agent's folder for its CLI, from HQ's content
 * store, and moves aside whatever drifted. Runs no process and fetches nothing.
 */
export function installSkills(o: { workspace: string; cli: "claude" | "codex"; want: LockedSkill[]; storeDir: string; movedDir: string; rename?: typeof renameSync }): InstallResult {
  const { workspace } = o;
  const rename = o.rename ?? renameSync;
  const abs = (rel: string) => join(workspace, ...rel.split("/"));

  // 0. A link where the skills go refuses the start before anything is read, moved or copied.
  for (const rel of LINK_REFUSED) {
    if (lstatSync(abs(rel), { throwIfNoEntry: false })?.isSymbolicLink()) return { blocked: { reason: "skills-link", path: abs(rel) } };
  }
  for (const sub of Object.values(INSTALL_FOLDERS)) agentMkdir(workspace, sub);
  const mine = INSTALL_FOLDERS[o.cli];

  // 1. HQ's own copy is checked again before every install (SR-F-01).
  const refused: { skill: string; reason: "hash" | "missing" }[] = [];
  const good = new Map<string, LockedSkill>();
  for (const s of o.want) {
    if (!validSkillName(s.name) || !SKILL_HASH.test(s.hash)) {
      refused.push({ skill: s.name, reason: "hash" });
      continue;
    }
    const store = join(o.storeDir, s.hash);
    const r = hashFolder(store, s.files);
    if ("hash" in r && r.hash === s.hash) good.set(s.name, s);
    else refused.push({ skill: s.name, reason: existsSync(store) ? "hash" : "missing" });
  }
  const wantedNames = new Set(o.want.map((s) => s.name));

  // 2. Compare what is there. A link, a non-folder, a refusal, or a refused skill counts as changed.
  const changed: string[] = [];
  const extra: string[] = [];
  const kept = new Set<string>();
  const links: string[] = [];
  const toMove: string[] = [];
  for (const sub of Object.values(INSTALL_FOLDERS)) {
    let count = 0;
    for (const name of folderEntries(agentPath(workspace, sub))) {
      // A folder of more entries than one skill may hold is not walked any further.
      if (++count > MAX_FILES) return { blocked: { reason: "skills-too-big", path: abs(sub) } };
      const rel = `${sub}/${name}`;
      const st = lstatSync(agentPath(workspace, rel), { throwIfNoEntry: false });
      if (!st) continue;
      const wanted = sub === mine ? good.get(name) : undefined;
      if (wanted && st.isDirectory() && !st.isSymbolicLink()) {
        const h = hashFolder(abs(rel), wanted.files);
        if ("hash" in h && h.hash === wanted.hash) {
          kept.add(name);
          continue;
        }
      }
      (sub === mine && wantedNames.has(name) ? changed : extra).push(rel);
      (st.isSymbolicLink() ? links : toMove).push(rel);
    }
  }
  for (const rel of toMove) if (overCap(agentPath(workspace, rel))) return { blocked: { reason: "skills-too-big", path: abs(rel) } };

  // 3. A link is removed (its target untouched); everything else is moved to HQ's home, never deleted.
  for (const rel of links) agentRemove(workspace, rel);
  let movedTo: string | null = null;
  const linksSkipped: string[] = [];
  if (toMove.length) {
    movedTo = makeMovesDir(o.movedDir);
    for (const rel of toMove) {
      const src = agentPath(workspace, rel);
      const dst = join(movedTo, ...rel.split("/"));
      mkdirSync(dirname(dst), { recursive: true });
      try {
        rename(src, dst);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
        // Another drive: copy file by file without following a link, then remove the source.
        if (!copyNoFollow(src, dst, rel, linksSkipped, { files: MAX_FILES, bytes: MAX_BYTES })) {
          rmSync(dst, { recursive: true, force: true });
          return { blocked: { reason: "skills-too-big", path: src } };
        }
        agentRemove(workspace, rel);
      }
    }
    pruneMoves(dirname(movedTo), KEEP_MOVES);
  }

  // 4. Copy each wanted skill that is not already there, then 5. hash the copy.
  const installed: string[] = [];
  const missing: string[] = [];
  const changedNames = new Set(changed.filter((r) => r.startsWith(`${mine}/`)).map((r) => r.slice(mine.length + 1)));
  for (const s of good.values()) {
    if (kept.has(s.name)) {
      installed.push(s.name);
      continue;
    }
    if (!changedNames.has(s.name)) missing.push(s.name);
    const rel = `${mine}/${s.name}`;
    mkdirSync(agentPath(workspace, rel)); // never over something that appeared since: EEXIST
    for (const f of s.files) {
      const fileRel = `${rel}/${f.path}`;
      mkdirSync(dirname(agentPath(workspace, fileRel)), { recursive: true });
      const mode = f.mode === "100755" ? 0o755 : 0o644;
      writeNew(agentPath(workspace, fileRel), readFileSync(join(o.storeDir, s.hash, ...f.path.split("/"))), mode);
    }
    const h = hashFolder(abs(rel), s.files);
    if (!("hash" in h) || h.hash !== s.hash) {
      agentRemove(workspace, rel);
      refused.push({ skill: s.name, reason: "hash" });
      continue;
    }
    installed.push(s.name);
  }

  // 6. Git does not see HQ's copies.
  excludeFromGit(workspace, installed.map((n) => `${mine}/${n}`));
  return { installed: installed.sort(), refused, drift: { changed: changed.sort(), extra: extra.sort(), missing: missing.sort(), movedTo, linksSkipped } };
}

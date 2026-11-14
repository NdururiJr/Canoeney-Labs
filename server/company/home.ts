import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** HQ's per-user folder name under the home directory. M0-H renames it. */
export const HQ_DIRNAME = ".jsmhq";

/** slugify only emits [a-z0-9-], so no project slug can collide with this. */
export const COMPANY_DIRNAME = "_company";

/** Company-level agents' folders (M0-D2, SR-D-06), under HQ's home. Like _company, no slug can collide with it. */
export const COMPANY_WORKSPACES_DIRNAME = "_workspaces";

/**
 * HQ's per-user folder: ~/.jsmhq, or HQ_HOME when set (tests set it to a
 * temporary folder). Agents' managed clones and HQ's per-project records live
 * here. Not created by this call.
 */
export function hqHome(): string {
  return process.env.HQ_HOME || join(homedir(), HQ_DIRNAME);
}

/**
 * Where the company store lives: ~/.jsmhq/_company, or HQ_COMPANY_HOME when set
 * (tests and scripts/smoke-test.mjs set it to a temporary folder). openCompany
 * refuses a home inside the repository, and workspaceFor refuses an agent
 * folder inside the home. Created on first use, 0700 on POSIX (mode applies to
 * the folders this call creates; Windows ignores it).
 */
export function companyHome(): string {
  const dir = process.env.HQ_COMPANY_HOME || join(homedir(), HQ_DIRNAME, COMPANY_DIRNAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// The real path of p: links and junctions resolved for the part that exists,
// with the part that does not exist yet appended as written.
function realish(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...tail);
    } catch {
      const up = dirname(cur);
      if (up === cur) return abs;
      tail.unshift(basename(cur));
      cur = up;
    }
  }
}

/**
 * True if `child` is `parent` or inside it. Compares real paths (so a link
 * into `parent` counts), case-insensitively on Windows. A folder named "..foo"
 * inside `parent` is inside it.
 */
export function isInside(child: string, parent: string): boolean {
  let a = realish(child);
  let b = realish(parent);
  if (process.platform === "win32") {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  const rel = relative(b, a);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

// HQ's own source can never be a project or an agent's folder (spec M0.12,
// threat model SR-D-05). A repo is HQ's source when any of its remotes is one
// of HQ's repos, when it carries HQ's package name, or when it is, holds or
// sits inside the folder HQ runs from.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Company } from "./company";
import type { Actor } from "./company/agents";
import { isInside } from "./company/home";
import { run } from "./lib/exec";

/** HQ's source repos, as owner/name in lower case. M0-H updates them with the rename. */
export const HQ_SOURCE_REPOS: readonly string[] = ["jsmastery-pro/jsm-hq", "ndururijr/canoeney-labs"];

export type HqSourceReason = "hq-remote" | "hq-package" | "hq-folder";
export type ProjectRefusal = HqSourceReason | "not-a-repo" | "hq-home";

const MESSAGES: Record<ProjectRefusal, string> = {
  "hq-remote": "This repo is HQ's own source (one of its remotes is HQ's repo). HQ never manages its own source as a project.",
  "hq-package": "This repo carries HQ's own package. HQ never manages its own source as a project.",
  "hq-folder": "This folder is, holds or sits inside the folder HQ runs from. HQ never manages its own source as a project.",
  "not-a-repo": "This folder is not a git repository.",
  "hq-home": "This folder is inside HQ's home, where HQ keeps agents' folders and its records. Choose a repo outside it.",
};

export class ProjectRefusedError extends Error {
  constructor(readonly reason: ProjectRefusal) {
    super(MESSAGES[reason]);
    this.name = "ProjectRefusedError";
  }
}

/** The folder HQ runs from: the one above `server/` (source) or `dist-server/` (built). */
export function hqSourceRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** `owner/name` of a GitHub URL in the https, ssh:// or git@ form, with or without .git; otherwise null. */
export function githubOf(url: string): string | null {
  const m = url.trim().match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?github\.com(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The URL of every remote of the repo at `root` (none when it is not a repo). */
export async function remoteUrls(root: string): Promise<string[]> {
  const r = await run("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], { cwd: root });
  if (!r.ok) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).slice(1).join(" "))
    .filter(Boolean);
}

function packageName(dir: string): string | null {
  try {
    const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/** Why the folder at `root` is HQ's own source, or null when it is not. */
export async function hqSourceReason(root: string): Promise<HqSourceReason | null> {
  const hq = hqSourceRoot();
  if (isInside(root, hq) || isInside(hq, root)) return "hq-folder";
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: root });
  const repoRoot = top.ok ? top.stdout.trim() : root;
  const own = packageName(hq);
  if (own && (packageName(repoRoot) === own || packageName(root) === own)) return "hq-package";
  const remotes = await remoteUrls(repoRoot);
  if (remotes.some((u) => HQ_SOURCE_REPOS.includes((githubOf(u) ?? "").toLowerCase()))) return "hq-remote";
  return null;
}

/** Every path that registers a project calls this first: HQ's source is refused, audited with the caller. */
export async function refuseHqSource(company: Company, root: string, actor: Actor): Promise<void> {
  const reason = await hqSourceReason(root);
  if (!reason) return;
  company.audit.append({ actorKind: actor.kind, actorId: actor.id, action: "project.refused", target: root, data: { reason } });
  throw new ProjectRefusedError(reason);
}

// Company-level workspaces (spec M0.14, threat model SR-D-06). The CEO, CIO
// and Security & Audit work above projects: their folder is an empty one under
// HQ's home, not a clone, and their sandbox does not start while a GitHub
// credential can reach it. M1 adds those agents; any agent given one of these
// roles gets this workspace, wherever it is registered.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_WORKSPACES_DIRNAME, hqHome } from "./company/home";
import type { RoleId } from "./company/types";
import { run } from "./lib/exec";
import { WorkspaceRefusedError } from "./workspace";

export const COMPANY_ROLES: readonly RoleId[] = ["ceo", "cio", "security-audit"];

/** Names in an agent's env file that hold a GitHub credential (the values are never read out). */
export const GITHUB_ENV_NAMES: readonly string[] = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

const PLAIN_ID = /^[a-z0-9][a-z0-9-]*$/;

export function workspaceKind(role: RoleId): "company" | "project" {
  return COMPANY_ROLES.includes(role) ? "company" : "project";
}

/** <hqHome>/_workspaces/<project>/<agent>. */
export function companyWorkspaceFor(projectSlug: string, agentId: string): string {
  if (!PLAIN_ID.test(projectSlug) || !PLAIN_ID.test(agentId)) throw new Error(`Invalid agent id ${JSON.stringify(`${projectSlug}/${agentId}`)}.`);
  return join(hqHome(), COMPANY_WORKSPACES_DIRNAME, projectSlug, agentId);
}

/**
 * Creates the agent's company workspace and checks it holds no repo. HQ's home
 * inside a git work tree (a home folder kept in a dotfiles repo) would put the
 * agent inside a repo, so that is refused too.
 */
export async function ensureCompanyWorkspace(projectSlug: string, agentId: string): Promise<string> {
  const dir = companyWorkspaceFor(projectSlug, agentId);
  mkdirSync(dir, { recursive: true });
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
  if (existsSync(join(dir, ".git")) || (inside.ok && inside.stdout.trim() === "true")) {
    throw new WorkspaceRefusedError("company-git", `${dir} is inside a git repository. A company-level agent's folder must hold no repo; move HQ's home (HQ_HOME) out of the repository.`);
  }
  return dir;
}

/** The GitHub credential names set in the env file. Comments are skipped; values are never returned. */
export function githubCredentialIn(envFile: string | null): string[] {
  if (!envFile || !existsSync(envFile)) return [];
  let text: string;
  try {
    text = readFileSync(envFile, "utf8");
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && GITHUB_ENV_NAMES.includes(m[1]) && !found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

// Agent folders: an HQ-managed clone per agent, or a folder the user chose.

import { existsSync } from "node:fs";
import type { AgentConfig } from "../src/data/types";
import { companyHome, isInside } from "./company/home";
import { run } from "./lib/exec";
import { managedWorkspace } from "./paths";
import type { RepoInfo } from "./repo";

/**
 * The agent's folder. Throws if it is the company store or inside it: agents
 * must never work in, or be pointed at, the company's records.
 */
export function workspaceFor(agent: AgentConfig, projectSlug: string): string {
  const dir = agent.workspacePath || managedWorkspace(projectSlug, agent.id);
  const store = companyHome();
  if (isInside(dir, store)) throw new Error(`${dir} is inside the company store (${store}). Choose a folder outside it for ${agent.name}.`);
  return dir;
}

/**
 * Makes sure the agent's folder exists and is a git repo.
 * A full clone (not a worktree): inside a sandbox a worktree loses git access.
 */
export async function ensureWorkspace(agent: AgentConfig, projectSlug: string, repo: RepoInfo): Promise<string> {
  const dir = workspaceFor(agent, projectSlug);
  if (agent.workspacePath) {
    if (!existsSync(dir)) throw new Error(`Folder not found: ${dir}`);
    if (!(await run("git", ["rev-parse", "--git-dir"], { cwd: dir })).ok) throw new Error(`${dir} is not a git repository.`);
    return dir;
  }
  if (!existsSync(dir)) {
    const clone = await run("git", ["clone", "--quiet", repo.root, dir], { timeoutMs: 300_000 });
    if (!clone.ok) throw new Error(`git clone failed: ${clone.stderr.trim()}`);
  }
  // A local clone points origin at the folder; agents need the real remote to push.
  if (repo.originUrl) await run("git", ["remote", "set-url", "origin", repo.originUrl], { cwd: dir });
  return dir;
}

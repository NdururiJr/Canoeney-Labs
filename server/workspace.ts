// Agent folders: an HQ-managed clone per agent, or a folder the user chose.

import { existsSync, rmSync } from "node:fs";
import type { AgentConfig } from "../src/data/types";
import { companyHome, hqHome, isInside } from "./company/home";
import { run } from "./lib/exec";
import { agentConfigOnDisk, isolateClone, trackedHqFiles } from "./agentIsolation";
import { managedWorkspace } from "./paths";
import type { RepoInfo } from "./repo";

/** A folder HQ will not start an agent in. `reason` goes into the audit row (SR-D-04, SR-D-07). */
export class WorkspaceRefusedError extends Error {
  constructor(
    readonly reason: "store" | "hq-home" | "agent-config" | "hq-file",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceRefusedError";
  }
}

/**
 * The agent's folder. Throws if it is the company store or inside it: agents
 * must never work in, or be pointed at, the company's records. A folder someone
 * chose is also refused when it is, holds, or sits inside HQ's home or the
 * store (SR-D-04), links and junctions included. HQ's own clone sits inside
 * HQ's home by design.
 */
export function workspaceFor(agent: AgentConfig, projectSlug: string, roots: { store: string; hq: string } = { store: companyHome(), hq: hqHome() }): string {
  const dir = agent.workspacePath || managedWorkspace(projectSlug, agent.id);
  if (isInside(dir, roots.store)) throw new WorkspaceRefusedError("store", `${dir} is inside the company store (${roots.store}). Choose a folder outside it for ${agent.name}.`);
  if (agent.workspacePath) {
    if (isInside(roots.store, dir)) throw new WorkspaceRefusedError("store", `${dir} holds the company store (${roots.store}). Choose a folder outside it for ${agent.name}.`);
    if (isInside(dir, roots.hq) || isInside(roots.hq, dir)) throw new WorkspaceRefusedError("hq-home", `${dir} is, holds or sits inside HQ's home (${roots.hq}), where HQ keeps its records. Choose another folder for ${agent.name}.`);
  }
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
    // A chosen folder is checked, never changed: HQ does not hide files in the owner's own checkout.
    await checkFolder(dir, true);
    return dir;
  }
  if (!existsSync(dir)) {
    // No checkout until the sparse patterns are set, so the repo's agent settings never reach the disk (SR-D-07).
    const clone = await run("git", ["clone", "--quiet", "--no-checkout", repo.root, dir], { timeoutMs: 300_000 });
    if (!clone.ok) throw new Error(`git clone failed: ${clone.stderr.trim()}`);
    try {
      await isolateClone(dir);
      await checkoutHead(dir);
    } catch (err) {
      // A half-made clone would start next time as an empty folder with the whole repo staged as deleted.
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  } else {
    // An existing clone (perhaps from before this change) is isolated again on every start.
    await isolateClone(dir);
    // A clone whose first checkout never finished has an empty index: check it out now.
    const tracked = await run("git", ["ls-files"], { cwd: dir });
    const head = await run("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: dir });
    if (tracked.ok && !tracked.stdout.trim() && head.ok && head.stdout.trim()) await checkoutHead(dir);
  }
  await checkFolder(dir, false);
  // A local clone points origin at the folder; agents need the real remote to push.
  if (repo.originUrl) await run("git", ["remote", "set-url", "origin", repo.originUrl], { cwd: dir });
  return dir;
}

/** Refuses a folder that holds the repo's agent settings, or a repo that commits one of HQ's own files. */
async function checkFolder(dir: string, chosen: boolean): Promise<void> {
  const config = await agentConfigOnDisk(dir);
  if (config.length) {
    const end = chosen ? "Use an HQ-managed folder for this agent." : "Commit or discard the change in " + dir + ", then start again.";
    throw new WorkspaceRefusedError("agent-config", `${dir} has the repo's agent settings on disk (${config[0]}). HQ keeps them out of agent folders. ${end}`);
  }
  const own = await trackedHqFiles(dir);
  if (own.length) throw new WorkspaceRefusedError("hq-file", `The repo commits ${own[0]}, which HQ writes with the agent's secret. Remove it from the repo, then start again.`);
}

/** Fills the index and the working tree from HEAD, within the sparse patterns. */
async function checkoutHead(dir: string): Promise<void> {
  const r = await run("git", ["read-tree", "-mu", "HEAD"], { cwd: dir, timeoutMs: 300_000 });
  if (!r.ok) throw new Error(`git checkout failed: ${r.stderr.trim()}`);
}

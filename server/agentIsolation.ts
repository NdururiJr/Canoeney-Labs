// Agents start without the repo's own agent configuration (owner decision D1,
// threat model SR-D-07, docs/adr/0008-company-store-holds-configuration.md).
// HQ's clones use git's sparse checkout, so the repo's CLAUDE.md, AGENTS.md,
// ROLE.md, .mcp.json, .claude/, .agents/ and .codex/ never reach an agent's
// disk: neither Claude Code nor Codex can load them. One merged PR therefore
// cannot change what every agent is told or may run.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { run } from "./lib/exec";

/** Non-cone sparse patterns: everything, except the agent configuration at any depth. */
export const AGENT_CONFIG_PATTERNS: readonly string[] = [
  "/*",
  "!CLAUDE.md",
  "!CLAUDE.local.md",
  "!AGENTS.md",
  "!AGENTS.override.md",
  "!ROLE.md",
  "!.mcp.json",
  "!.claude/",
  "!.agents/",
  "!.codex/",
];

const CONFIG_FILES = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md", "ROLE.md", ".mcp.json"]);
const CONFIG_DIRS = new Set([".claude", ".agents", ".codex"]);

/** HQ's own files in an agent's folder. A repo that tracks one could commit the agent's secret. */
export const HQ_OWN_FILES: readonly string[] = [".jsmhq-role.md", ".jsmhq-hook.mjs", ".claude/settings.local.json", ".claude/hq-mcp.json", ".codex/config.toml"];

/** True for a repo path the sparse patterns leave out of an agent's folder. */
export function isAgentConfigPath(rel: string): boolean {
  const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0) return false;
  return CONFIG_FILES.has(parts[parts.length - 1]) || parts.slice(0, -1).some((p) => CONFIG_DIRS.has(p));
}

/** Applies the sparse patterns to a clone. Needs git 2.35 or later. */
export async function isolateClone(dir: string): Promise<void> {
  const r = await run("git", ["sparse-checkout", "set", "--no-cone", "--stdin"], { cwd: dir, input: AGENT_CONFIG_PATTERNS.join("\n") + "\n", timeoutMs: 120_000 });
  if (!r.ok) {
    const first = (r.stderr || r.stdout).trim().split("\n")[0] ?? "";
    throw new Error(`HQ needs git 2.35 or later to keep the repo's agent settings out of agent folders: ${first}`);
  }
}

/** Every path the repo tracks, from `git ls-files -z`. */
async function tracked(dir: string): Promise<string[]> {
  const r = await run("git", ["ls-files", "-z"], { cwd: dir, timeoutMs: 60_000 });
  if (!r.ok) throw new Error(`git ls-files failed in ${dir}: ${r.stderr.trim().split("\n")[0]}`);
  return r.stdout.split("\0").filter(Boolean);
}

/** Tracked agent-configuration paths that exist on disk in `dir` (a link counts). */
export async function agentConfigOnDisk(dir: string): Promise<string[]> {
  return (await tracked(dir)).filter((rel) => {
    if (!isAgentConfigPath(rel)) return false;
    try {
      lstatSync(join(dir, rel));
      return true;
    } catch {
      return false;
    }
  });
}

/** HQ's own file names that the repo tracks. */
export async function trackedHqFiles(dir: string): Promise<string[]> {
  const all = new Set(await tracked(dir));
  return HQ_OWN_FILES.filter((f) => all.has(f));
}

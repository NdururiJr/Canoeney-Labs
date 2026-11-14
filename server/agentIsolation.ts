// Agents start without the repo's own agent configuration (owner decision D1,
// threat model SR-D-07, docs/adr/0008-company-store-holds-configuration.md).
// HQ's clones use git's sparse checkout, so the repo's CLAUDE.md, AGENTS.md,
// ROLE.md, .mcp.json, .claude/, .agents/ and .codex/ never reach an agent's
// disk: neither Claude Code nor Codex can load them. One merged PR therefore
// cannot change what every agent is told or may run.
import { lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { run } from "./lib/exec";

const CONFIG_FILE_NAMES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md", "ROLE.md", ".mcp.json"];
const CONFIG_DIR_NAMES = [".claude", ".agents", ".codex"];

/**
 * A name as a pattern that matches it in any letter case ("[cC][lL]…"). Windows and
 * macOS file systems ignore case, so Claude Code would load a tracked "Claude.md";
 * git's own sparse matching ignores case only where core.ignorecase is set. Writing
 * the case into the pattern makes every platform leave out the same files.
 */
const anyCase = (name: string): string => name.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

/**
 * Non-cone sparse patterns: everything, except the agent configuration at any depth
 * and in any letter case. These are the plan's patterns (!CLAUDE.md, !.claude/, …)
 * with the case written out.
 */
export const AGENT_CONFIG_PATTERNS: readonly string[] = ["/*", ...CONFIG_FILE_NAMES.map((n) => `!${anyCase(n)}`), ...CONFIG_DIR_NAMES.map((n) => `!${anyCase(n)}/`)];

const CONFIG_FILES = new Set(CONFIG_FILE_NAMES.map((n) => n.toLowerCase()));
const CONFIG_DIRS = new Set(CONFIG_DIR_NAMES);

/** HQ's own files in an agent's folder. A repo that tracks one could commit the agent's secret. */
export const HQ_OWN_FILES: readonly string[] = [".jsmhq-role.md", ".jsmhq-hook.mjs", ".claude/settings.local.json", ".claude/hq-mcp.json", ".codex/config.toml"];

/** True for a repo path the sparse patterns leave out of an agent's folder. */
export function isAgentConfigPath(rel: string): boolean {
  const parts = rel.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);
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

/**
 * Every path the repo tracks, from `git ls-files -z` at the repo's top level,
 * with that top level. A chosen folder can be a subfolder: the repo's root
 * CLAUDE.md applies to it too (Claude Code reads it from a parent folder).
 */
async function tracked(dir: string): Promise<{ top: string; files: string[] }> {
  const t = await run("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
  const top = t.ok && t.stdout.trim() ? t.stdout.trim() : dir;
  const r = await run("git", ["ls-files", "-z"], { cwd: top, timeoutMs: 60_000 });
  if (!r.ok) throw new Error(`git ls-files failed in ${top}: ${r.stderr.trim().split("\n")[0]}`);
  return { top, files: r.stdout.split("\0").filter(Boolean) };
}

/** Tracked agent-configuration paths that exist on disk in `dir` (a link counts). */
export async function agentConfigOnDisk(dir: string): Promise<string[]> {
  const { top, files } = await tracked(dir);
  return files.filter((rel) => {
    if (!isAgentConfigPath(rel)) return false;
    try {
      lstatSync(join(top, rel));
      return true;
    } catch {
      return false;
    }
  });
}

/** The repo's tracked paths that are one of HQ's own file names, in any letter case. */
export async function trackedHqFiles(dir: string): Promise<string[]> {
  const own = new Set(HQ_OWN_FILES.map((f) => f.toLowerCase()));
  const { top, files } = await tracked(dir);
  // HQ writes its files into `dir`, which can be a subfolder: compare paths relative to it.
  const under = relative(top, dir).replace(/\\/g, "/");
  const prefix = under ? `${under}/` : "";
  return files
    .filter((rel) => rel.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((rel) => rel.slice(prefix.length))
    .filter((rel) => own.has(rel.toLowerCase()));
}

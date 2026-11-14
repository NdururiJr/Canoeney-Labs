// Per-CLI differences: which files HQ writes into the agent's folder and how
// the agent is launched. Everything else (hooks → state, Team MCP, delivery)
// is shared — Codex and Claude Code send the same hook payloads.

import { join } from "node:path";
import { agentRemove, agentWrite } from "./lib/agentFs";
import type { AgentCli, AgentConfig, HqConfig } from "../src/data/types";
import { removeOldRoleFile, excludeFromGit, HOOK_AUTH, HOOK_SCRIPT, type RoleExtras, hookCommand, hqUrl, MCP_CONFIG, roleMd, writeClaudeFiles, writeHookAuth } from "./agentFiles";

export interface Launch {
  sbxAgent: string; // agent name for `sbx run`
  args: string[]; // the CLI's own arguments (not shell-quoted)
}

export interface CliAdapter {
  /** Writes HQ's files into the agent's folder (all git-excluded). */
  writeFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string, extras: RoleExtras): Promise<void>;
  launch(agent: AgentConfig, dir: string): Launch;
}

// ---------------------------------------------------------------- Claude Code

const claude: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras) {
    await removeOldRoleFile(dir);
    writeClaudeFiles(dir, agent, cfg, token, extras);
  },
  launch(agent, dir) {
    // "Opus" / "Sonnet" / "Haiku" → Claude Code's aliases; anything else is passed as a full model id.
    const m = agent.model.trim();
    const model = !m || /^default$/i.test(m) ? null : /^(opus|sonnet|haiku)$/i.test(m) ? m.toLowerCase() : m;
    return { sbxAgent: "claude", args: ["--mcp-config", `${dir}/${MCP_CONFIG}`, ...(model ? ["--model", model] : [])] };
  },
};

// ---------------------------------------------------------------- Codex

export const CODEX_CONFIG = ".codex/config.toml";
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop", "SessionEnd"];

/** TOML basic string (JSON's escaping is valid TOML for these characters). */
const t = (s: string) => JSON.stringify(s);

export function codexConfig(agent: AgentConfig, cfg: HqConfig, token: string, dir: string, extras: RoleExtras): string {
  const url = hqUrl(agent, cfg.project.hqPort);
  const auth = join(dir, HOOK_AUTH);
  const lines = [
    "# Written by JSM HQ for this agent (git-excluded). Codex loads it once you trust this folder.",
    `developer_instructions = ${t(roleMd(agent, cfg, extras))}`,
    "",
    "[features]",
    "hooks = true",
    "",
    "[mcp_servers.hq]",
    `url = ${t(`${url}/mcp`)}`,
    `http_headers = { Authorization = ${t(`Bearer ${token}`)} }`,
  ];
  for (const event of CODEX_EVENTS)
    lines.push("", `[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${t(hookCommand(url, auth, agent.id, event))}`);
  return lines.join("\n") + "\n";
}

const codex: CliAdapter = {
  async writeFiles(dir, agent, cfg, token, extras) {
    // A repo that commits .codex/config.toml is refused before this (workspace.ts, trackedHqFiles).
    // The role goes in the config (developer_instructions), from the company store only.
    await removeOldRoleFile(dir);
    writeHookAuth(dir, token);
    agentWrite(dir, CODEX_CONFIG, codexConfig(agent, cfg, token, dir, extras), { mode: 0o600 });
    agentRemove(dir, HOOK_SCRIPT); // an earlier HQ's Local-mode script: no longer used
    excludeFromGit(dir, [CODEX_CONFIG, HOOK_AUTH, HOOK_SCRIPT]);
  },
  launch(agent) {
    const model = agent.model.trim() && !/^default$/i.test(agent.model.trim()) ? agent.model.trim() : null;
    return { sbxAgent: "codex", args: model ? ["-m", model] : [] };
  },
};

export const adapters: Record<AgentCli, CliAdapter> = { claude, codex };

/** The command a Local-mode agent runs on the host. */
export const localBinary: Record<AgentCli, string> = { claude: "claude", codex: "codex" };

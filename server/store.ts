// Defaults for a project's configuration. The configuration itself lives in the
// company store (M0-D1, server/company/projectSettings.ts); HQ no longer reads or
// writes .jsmhq/config.json or .jsmhq/plan.json, except the one-time import
// (server/repoConfigImport.ts).

import type { AgentConfig, Board, SandboxSettings, Task } from "../src/data/types";

export interface PlanFile {
  boards: Board[];
  tasks: Task[];
}

export const defaultSandbox = (): SandboxSettings => ({
  resources: { cpus: null, memoryGb: null }, // sbx's own defaults
  allow: [],
  deny: [],
});

export function newAgent(id: string, name: string, role: string, color: string, isLead: boolean): AgentConfig {
  return {
    id,
    name,
    role,
    isLead,
    cli: "claude",
    model: "", // the CLI's default; users can pick with /model or "Start with model"
    mode: "sandbox",
    color,
    skills: [],
    roleMd: isLead
      ? `You are ${name}, the lead. You plan and assign work. You never write app code.`
      : `You are ${name}, a ${role.toLowerCase()} on the team. You build the tasks assigned to you.`,
    sandbox: defaultSandbox(),
    workspacePath: null,
    mcp: [],
  };
}


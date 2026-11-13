import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { hqHome } from "./company/home";

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "project";

/** ~/.jsmhq/<project>/ (or under HQ_HOME) — HQ's per-project home (agent folders, tokens). */
export function projectHome(projectSlug: string): string {
  const dir = join(hqHome(), projectSlug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Agent ids name folders, so only plain slugs: "../_company" must never resolve. */
const AGENT_ID = /^[a-z0-9][a-z0-9-]*$/;

/** ~/.jsmhq/<project>/<agent>/ — the agent's HQ-managed clone. */
export function managedWorkspace(projectSlug: string, agentId: string): string {
  if (!AGENT_ID.test(agentId)) throw new Error(`Invalid agent id ${JSON.stringify(agentId)}: use lower-case letters, digits and "-".`);
  return join(projectHome(projectSlug), agentId);
}

/** Session names used for tmux and for the sandbox. */
export const sessionName = (projectSlug: string, agentId: string) => `hq-${projectSlug}-${agentId}`;

/**
 * Before M0-B every agent of a project shared one token, kept here. Each agent
 * now has its own secret (server/company/agentSecrets.ts); HQ removes the old
 * file at startup.
 */
export const legacyAgentTokenFile = (projectSlug: string): string => join(projectHome(projectSlug), "agent-token");

/** Before M0-C the UI connected with a per-start token; the dev copy lived here. HQ removes it at startup. */
export const legacyDevTokenFile = (projectSlug: string): string => join(projectHome(projectSlug), "dev-browser-token");

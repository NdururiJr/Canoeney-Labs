import type { Migration } from "../migrations";

// One GitHub App per agent (M0-E, docs/adr/0010-github-app-per-agent.md). The
// App's private key is sealed with the owner key (server/company/sealed.ts),
// never stored in clear. bot_user_id is the App's bot user, which PR
// attribution matches by type and id, never by login text (SR-E-12).
const up = `
CREATE TABLE agent_github_apps(
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  app_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  bot_user_id INTEGER NOT NULL,
  key_sealed TEXT NOT NULL,
  installation_id INTEGER NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX agent_github_apps_bot ON agent_github_apps(bot_user_id);

-- The owner's confirmation (with the PIN) that a private repo has an Actions
-- spending limit: GitHub does not show a personal account's limit to the API (SR-E-14).
CREATE TABLE repo_guard(
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  spending_confirmed_at TEXT NULL,
  spending_confirmed_by TEXT NULL
);
`;

export const m007: Migration = { version: 7, name: "agent-github", up };

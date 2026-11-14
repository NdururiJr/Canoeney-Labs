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
`;

export const m007: Migration = { version: 7, name: "agent-github", up };

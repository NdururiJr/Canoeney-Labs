import type { Migration } from "../migrations";

// Per-role skills (M0-F, docs/security/threat-model-m0.md SR-F-03). The lock
// (which skills are pinned, and the hash of every file) and the role-to-skill
// sets live here and nowhere an agent can write. Both change only through
// ProjectSettings.authorized(): the owner's PIN or an approved decision.
//
// The sets are seeded with spec §2a's starting values. This migration reaches
// main only through the owner's merge, so the seed is an owner-approved change.
// Three §2a skills (humanizer, the charter-first planning skill, the company
// audit skill) arrive in M1.
const up = `
CREATE TABLE skill_source(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  repo TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  lock_hash TEXT NOT NULL,
  pinned_at TEXT NOT NULL
);

CREATE TABLE skill_lock(
  name TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  files_json TEXT NOT NULL,
  scripts_json TEXT NOT NULL
);

CREATE TABLE role_skills(
  role TEXT NOT NULL,
  skill TEXT NOT NULL,
  PRIMARY KEY (role, skill)
);

INSERT INTO role_skills(role, skill) VALUES
  ('builder', 'test-driven-development'),
  ('builder', 'systematic-debugging'),
  ('builder', 'verification-before-completion'),
  ('builder', 'executing-plans'),
  ('cto', 'writing-plans'),
  ('cto', 'requesting-code-review'),
  ('cto', 'brainstorming'),
  ('ceo', 'verification-before-completion'),
  ('cio', 'verification-before-completion');

-- HQ's record that it created this agent's sandbox with skills off.
CREATE TABLE agent_sandboxes(
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  skills_off_at TEXT NOT NULL
);
`;

export const m008: Migration = { version: 8, name: "skills", up };

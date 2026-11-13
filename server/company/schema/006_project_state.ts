import type { Migration } from "../migrations";

// Project state moves from the repo's .jsmhq/ files into the company store
// (spec M0.11, surface S7; docs/adr/0008-company-store-holds-configuration.md).
// Per-agent grants use the permissions table of migration 001. Every CHECK list
// is a literal: schema.test.ts has a tripwire for AGENT_MODES, BOARD_STATUSES
// and TASK_STATUSES. Approved project notes are append-only, like the charter.
const up = `
CREATE TABLE project_settings(
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  github TEXT NULL,
  workflow_json TEXT NOT NULL,
  stack_json TEXT NULL,
  office_name TEXT NULL,
  export_plan INTEGER NOT NULL DEFAULT 0 CHECK (export_plan IN (0, 1)),
  imported_at TEXT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_settings(
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  display_role TEXT NOT NULL,
  color TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL CHECK (mode IN ('sandbox', 'local')),
  workspace_path TEXT NULL,
  role_md TEXT NOT NULL,
  cpus INTEGER NULL,
  memory_gb REAL NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE boards(
  project_id TEXT NOT NULL REFERENCES projects(id),
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'planned', 'done')),
  ord INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE tasks(
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  title TEXT NOT NULL,
  owner_agent_id TEXT NULL REFERENCES agents(id),
  status TEXT NOT NULL CHECK (status IN ('todo', 'in-progress', 'in-review', 'done', 'blocked')),
  needs_json TEXT NOT NULL DEFAULT '[]',
  pr_number INTEGER NULL,
  description TEXT NOT NULL DEFAULT '',
  files_json TEXT NOT NULL DEFAULT '[]',
  done_when TEXT NOT NULL DEFAULT '',
  note TEXT NULL,
  created_by TEXT NULL,
  ord INTEGER NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, board_id) REFERENCES boards(project_id, id)
);

CREATE TABLE project_notes(
  project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  content TEXT NOT NULL,
  approved_by_human_id TEXT NULL REFERENCES humans(id),
  approved_by_decision_id TEXT NULL REFERENCES decisions(id),
  approved_at TEXT NOT NULL,
  PRIMARY KEY (project_id, version),
  CHECK (approved_by_human_id IS NOT NULL OR approved_by_decision_id IS NOT NULL)
);
CREATE TRIGGER project_notes_no_update BEFORE UPDATE ON project_notes
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER project_notes_no_delete BEFORE DELETE ON project_notes
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`;

export const m006: Migration = { version: 6, name: "project-state", up };

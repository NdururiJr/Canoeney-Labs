import type { Migration } from "../migrations";

const up = `
CREATE TABLE memory_items(
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('agent', 'client')),
  scope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, key)
);

CREATE TABLE knowledge_docs(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_human_id TEXT NOT NULL REFERENCES humans(id)
);
`;

export const m002: Migration = { version: 2, name: "memory-knowledge", up };

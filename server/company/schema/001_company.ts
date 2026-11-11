import type { Migration } from "../migrations";

// Every CHECK list and seed row below is a literal on purpose. A migration is
// frozen once it merges, so it must not read the live unions in types.ts: if it
// did, a later change to a union would make fresh stores differ from existing
// ones. schema.test.ts has a tripwire that fails when a union in types.ts grows
// beyond these lists; widen the CHECK in a new migration then.

const CURRENCY = "currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency))";

const appendOnly = (table: string): string => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'append-only'); END;`;

const up = `
CREATE TABLE roles(
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL
);
INSERT INTO roles(id, label) VALUES
  ('ceo', 'CEO'),
  ('cio', 'CIO'),
  ('security-audit', 'Security & Audit'),
  ('cto', 'CTO'),
  ('solutions', 'Solutions'),
  ('builder', 'Builder'),
  ('qa', 'QA'),
  ('security-reviewer', 'Security reviewer'),
  ('customer-service', 'Customer service'),
  ('accountant', 'Accountant'),
  ('sales', 'Sales'),
  ('marketing', 'Marketing'),
  ('research', 'Research');

CREATE TABLE departments(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  head_agent_id TEXT NULL REFERENCES agents(id)
);

CREATE TABLE humans(
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'supervisor')),
  created_at TEXT NOT NULL,
  disabled_at TEXT NULL
);
CREATE UNIQUE INDEX one_owner ON humans(role) WHERE role = 'owner';

CREATE TABLE clients(
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE projects(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('company', 'client')),
  client_id TEXT NULL REFERENCES clients(id),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'client') = (client_id IS NOT NULL))
);

CREATE TABLE agents(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id),
  department_id TEXT NOT NULL REFERENCES departments(id),
  manager_id TEXT NULL REFERENCES agents(id),
  human_owner_id TEXT NULL REFERENCES humans(id),
  project_id TEXT NULL REFERENCES projects(id),
  cli TEXT NOT NULL CHECK (cli IN ('claude', 'codex')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  autonomy_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  retired_at TEXT NULL,
  CHECK (manager_id IS NULL OR manager_id <> id)
);

CREATE TABLE charter_versions(
  version INTEGER PRIMARY KEY,
  content_json TEXT NOT NULL,
  changed_by_human_id TEXT NOT NULL REFERENCES humans(id),
  changed_at TEXT NOT NULL,
  note TEXT
);
${appendOnly("charter_versions")}

CREATE TABLE permissions(
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  kind TEXT NOT NULL CHECK (kind IN ('network-allow', 'network-deny', 'mcp-server', 'secret-name', 'tool', 'skill')),
  value TEXT NOT NULL,
  granted_by_decision_id TEXT NULL REFERENCES decisions(id),
  granted_by_human_id TEXT NULL REFERENCES humans(id),
  granted_at TEXT NOT NULL,
  revoked_at TEXT NULL,
  CHECK (granted_by_decision_id IS NOT NULL OR granted_by_human_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_active_grant ON permissions(agent_id, kind, value) WHERE revoked_at IS NULL;

CREATE TABLE decisions(
  id TEXT PRIMARY KEY,
  category INTEGER NULL CHECK (category BETWEEN 1 AND 8),
  requester_kind TEXT NOT NULL CHECK (requester_kind IN ('agent', 'hq')),
  requester_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL DEFAULT '[]',
  recommendation TEXT,
  cost_minor INTEGER NULL CHECK (cost_minor >= 0),
  cost_currency TEXT NULL CHECK (cost_currency IS NULL OR (length(cost_currency) = 3 AND cost_currency = upper(cost_currency))),
  urgency TEXT NOT NULL CHECK (urgency IN ('critical', 'high', 'normal', 'fyi')),
  deadline_at TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  decided_by_human_id TEXT NULL REFERENCES humans(id),
  decided_at TEXT NULL,
  channel TEXT NULL,
  verification TEXT NULL CHECK (verification IN ('pin', 'channel-reply')),
  reply_code TEXT NOT NULL UNIQUE,
  dedupe_key TEXT NOT NULL,
  execution_status TEXT NOT NULL DEFAULT 'not-started' CHECK (execution_status IN ('not-started', 'started', 'done', 'failed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  CHECK ((cost_minor IS NULL) = (cost_currency IS NULL))
);
CREATE INDEX decisions_dedupe ON decisions(dedupe_key, status);

CREATE TABLE budgets(
  id INTEGER PRIMARY KEY,
  area TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  limit_minor INTEGER NOT NULL CHECK (limit_minor >= 0),
  ${CURRENCY},
  UNIQUE(area, period)
);

CREATE TABLE spend(
  id INTEGER PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  vendor TEXT NOT NULL,
  area TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  ${CURRENCY},
  source TEXT NOT NULL CHECK (source IN ('api-metered', 'subscription', 'invoice', 'estimate')),
  agent_id TEXT NULL REFERENCES agents(id),
  decision_id TEXT NULL REFERENCES decisions(id)
);

CREATE TABLE audit_events(
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent', 'human', 'hq')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NULL,
  decision_id TEXT NULL,
  data_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);
${appendOnly("audit_events")}

-- Seeded after agents exists: inserting into departments checks its foreign key target.
INSERT INTO departments(id, name) VALUES
  ('executive', 'Executive'),
  ('internal-it', 'Internal IT'),
  ('delivery', 'Delivery'),
  ('clients', 'Clients'),
  ('finance', 'Finance'),
  ('growth', 'Growth'),
  ('strategy', 'Strategy'),
  ('security-audit', 'Security & Audit');
`;

export const m001: Migration = { version: 1, name: "company", up };

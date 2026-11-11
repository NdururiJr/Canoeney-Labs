import type { Migration } from "../migrations";
import {
  ACTOR_KINDS,
  AGENT_STATUSES,
  DECISION_STATUSES,
  DEPARTMENT_IDS,
  EXECUTION_STATUSES,
  HUMAN_ROLES,
  PERMISSION_KINDS,
  ROLE_IDS,
  SPEND_SOURCES,
  URGENCIES,
  VERIFICATIONS,
  type DepartmentId,
  type RoleId,
} from "../types";

// SQL building blocks. Every value comes from types.ts or the literals below,
// never from user input, so string interpolation into DDL is safe here.
const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");
const checkIn = (column: string, values: readonly string[]): string => `CHECK (${column} IN (${sqlList(values)}))`;
const CURRENCY = "currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency))";

const ROLE_LABELS: Record<RoleId, string> = {
  ceo: "CEO",
  cio: "CIO",
  "security-audit": "Security & Audit",
  cto: "CTO",
  solutions: "Solutions",
  builder: "Builder",
  qa: "QA",
  "security-reviewer": "Security reviewer",
  "customer-service": "Customer service",
  accountant: "Accountant",
  sales: "Sales",
  marketing: "Marketing",
  research: "Research",
};

const DEPARTMENT_NAMES: Record<DepartmentId, string> = {
  executive: "Executive",
  "internal-it": "Internal IT",
  delivery: "Delivery",
  clients: "Clients",
  finance: "Finance",
  growth: "Growth",
  strategy: "Strategy",
  "security-audit": "Security & Audit",
};

const seedRows = (labels: Record<string, string>, ids: readonly string[]): string =>
  ids.map((id) => `('${id}', '${labels[id].replace(/'/g, "''")}')`).join(", ");

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
INSERT INTO roles(id, label) VALUES ${seedRows(ROLE_LABELS, ROLE_IDS)};

CREATE TABLE departments(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  head_agent_id TEXT NULL REFERENCES agents(id)
);

CREATE TABLE humans(
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL ${checkIn("role", HUMAN_ROLES)},
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
  kind TEXT NOT NULL ${checkIn("kind", ["company", "client"])},
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
  cli TEXT NOT NULL ${checkIn("cli", ["claude", "codex"])},
  status TEXT NOT NULL DEFAULT 'active' ${checkIn("status", AGENT_STATUSES)},
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
  kind TEXT NOT NULL ${checkIn("kind", PERMISSION_KINDS)},
  value TEXT NOT NULL,
  granted_by_decision_id TEXT NULL REFERENCES decisions(id),
  granted_by_human_id TEXT NULL REFERENCES humans(id),
  granted_at TEXT NOT NULL,
  revoked_at TEXT NULL
);
CREATE UNIQUE INDEX one_active_grant ON permissions(agent_id, kind, value) WHERE revoked_at IS NULL;

CREATE TABLE decisions(
  id TEXT PRIMARY KEY,
  category INTEGER NULL CHECK (category BETWEEN 1 AND 8),
  requester_kind TEXT NOT NULL ${checkIn("requester_kind", ["agent", "hq"])},
  requester_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL DEFAULT '[]',
  recommendation TEXT,
  cost_minor INTEGER NULL CHECK (cost_minor >= 0),
  cost_currency TEXT NULL,
  urgency TEXT NOT NULL ${checkIn("urgency", URGENCIES)},
  deadline_at TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending' ${checkIn("status", DECISION_STATUSES)},
  decided_by_human_id TEXT NULL REFERENCES humans(id),
  decided_at TEXT NULL,
  channel TEXT NULL,
  verification TEXT NULL ${checkIn("verification", VERIFICATIONS)},
  reply_code TEXT NOT NULL UNIQUE,
  dedupe_key TEXT NOT NULL,
  execution_status TEXT NOT NULL DEFAULT 'not-started' ${checkIn("execution_status", EXECUTION_STATUSES)},
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
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
  source TEXT NOT NULL ${checkIn("source", SPEND_SOURCES)},
  agent_id TEXT NULL REFERENCES agents(id),
  decision_id TEXT NULL REFERENCES decisions(id)
);

CREATE TABLE audit_events(
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor_kind TEXT NOT NULL ${checkIn("actor_kind", ACTOR_KINDS)},
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
INSERT INTO departments(id, name) VALUES ${seedRows(DEPARTMENT_NAMES, DEPARTMENT_IDS)};
`;

export const m001: Migration = { version: 1, name: "company", up };

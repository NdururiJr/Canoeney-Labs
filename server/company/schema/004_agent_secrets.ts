import type { Migration } from "../migrations";

// Per-agent secrets (spec M0.2, docs/adr/0005-agent-identity.md). Only a
// SHA-256 hash of each secret is stored (owner decision D8). A secret is never
// deleted or brought back: it can only be revoked, once.
const up = `
CREATE TABLE agent_secrets(
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  secret_hash TEXT NOT NULL UNIQUE CHECK (length(secret_hash) = 64),
  issued_at TEXT NOT NULL,
  revoked_at TEXT NULL,
  revoked_reason TEXT NULL CHECK (revoked_reason IN ('rotated', 'stopped', 'paused', 'retired')),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE UNIQUE INDEX one_live_secret ON agent_secrets(agent_id) WHERE revoked_at IS NULL;

CREATE TRIGGER agent_secrets_no_delete BEFORE DELETE ON agent_secrets
BEGIN SELECT RAISE(ABORT, 'agent secrets are kept'); END;

CREATE TRIGGER agent_secrets_revoke_only BEFORE UPDATE ON agent_secrets
WHEN OLD.revoked_at IS NOT NULL
  OR NEW.revoked_at IS NULL
  OR NEW.id IS NOT OLD.id
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.secret_hash IS NOT OLD.secret_hash
  OR NEW.issued_at IS NOT OLD.issued_at
BEGIN SELECT RAISE(ABORT, 'an agent secret can only be revoked, once'); END;

CREATE TRIGGER agents_retired_is_final BEFORE UPDATE OF status, retired_at ON agents
WHEN OLD.status = 'retired' AND (NEW.status IS NOT 'retired' OR NEW.retired_at IS NOT OLD.retired_at)
BEGIN SELECT RAISE(ABORT, 'a retired agent stays retired'); END;
`;

export const m004: Migration = { version: 4, name: "agent-secrets", up };

import type { Migration } from "../migrations";

// Credentials of the humans who log in to the dashboard (spec M0.7; owner
// decision SR-C-19, 2026-11-12; docs/adr/0007-owner-login-and-dashboard.md).
// The password and PIN are slow salted hashes. The TOTP seed is encrypted with
// a key kept in a file outside this database, so a copy of the store alone
// opens nothing. The last TOTP step used only moves forward, so a code works
// once.
const up = `
CREATE TABLE human_credentials(
  human_id TEXT PRIMARY KEY REFERENCES humans(id),
  password_hash TEXT NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  pin_hash TEXT NOT NULL CHECK (pin_hash LIKE 'scrypt$%'),
  totp_seed_enc TEXT NOT NULL CHECK (totp_seed_enc LIKE 'v1:%'),
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER human_credentials_step_forward BEFORE UPDATE OF totp_last_step ON human_credentials
WHEN NEW.totp_last_step < OLD.totp_last_step
BEGIN SELECT RAISE(ABORT, 'a TOTP step is used once'); END;
`;

export const m005: Migration = { version: 5, name: "human-credentials", up };

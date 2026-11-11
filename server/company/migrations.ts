import type { CompanyDb } from "./db";

export interface Migration {
  version: number;
  name: string;
  up: string;
}

// Migrations are TypeScript modules so the server bundle carries them.
// A migration is never edited after it merges; add a new one instead.
export const MIGRATIONS: readonly Migration[] = [];

export class SchemaTooNewError extends Error {
  constructor(
    readonly storedVersion: number,
    readonly knownVersion: number,
  ) {
    super(
      `Company store is at schema version ${storedVersion} but this HQ knows up to ${knownVersion}. ` +
        "It was written by a newer HQ; update HQ.",
    );
    this.name = "SchemaTooNewError";
  }
}

const BOOKKEEPING = `CREATE TABLE IF NOT EXISTS schema_migrations(
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

/** Highest migration version applied to this store; 0 when none. */
export function schemaVersion(db: CompanyDb): number {
  db.exec(BOOKKEEPING);
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get<{ v: number | null }>();
  return row?.v ?? 0;
}

/** Apply every migration above the stored version, each in its own transaction. */
export function migrate(db: CompanyDb, migrations: readonly Migration[]): { applied: number[] } {
  for (let i = 0; i < migrations.length; i++) {
    const prev = i === 0 ? 0 : migrations[i - 1].version;
    if (migrations[i].version <= prev) {
      throw new Error(`Migrations must have strictly ascending versions (saw ${migrations[i].version} after ${prev})`);
    }
  }
  const stored = schemaVersion(db);
  const known = migrations.length === 0 ? 0 : migrations[migrations.length - 1].version;
  if (stored > known) throw new SchemaTooNewError(stored, known);

  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= stored) continue;
    db.transaction(() => {
      db.exec(m.up);
      db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    }, "immediate");
    applied.push(m.version);
  }
  return { applied };
}

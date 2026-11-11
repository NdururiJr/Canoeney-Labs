// The only file that imports node:sqlite. Everything else uses CompanyDb, so
// the driver can be swapped (see docs/adr/0002-company-store-sqlite.md).
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS, migrate, type Migration } from "./migrations";

export { SchemaTooNewError } from "./migrations";

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Statement {
  run(...p: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  get<T>(...p: SqlValue[]): T | undefined;
  all<T>(...p: SqlValue[]): T[];
}

export interface CompanyDb {
  readonly file: string;
  /** True while a transaction() call is running on this handle. */
  readonly inTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T, mode?: "deferred" | "immediate"): T;
  close(): void;
}

class SqliteCompanyDb implements CompanyDb {
  private depth = 0;
  private closed = false;

  constructor(
    readonly file: string,
    private readonly raw: DatabaseSync,
  ) {}

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): Statement {
    const stmt = this.raw.prepare(sql);
    return {
      run: (...p) => {
        const r = stmt.run(...p);
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
      },
      get: <T>(...p: SqlValue[]) => stmt.get(...p) as T | undefined,
      all: <T>(...p: SqlValue[]) => stmt.all(...p) as T[],
    };
  }

  transaction<T>(fn: () => T, mode: "deferred" | "immediate" = "deferred"): T {
    if (this.depth > 0) throw new Error("nested transaction");
    this.raw.exec(mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
    this.depth++;
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        // Keep the original error; the connection may already have rolled back.
      }
      throw err;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.raw.close();
  }
}

export function openCompanyDb(file: string, migrations: readonly Migration[] = MIGRATIONS): CompanyDb {
  const inMemory = file === ":memory:";
  const posix = process.platform !== "win32";
  if (!inMemory && posix) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  else if (!inMemory) mkdirSync(dirname(file), { recursive: true });

  const raw = new DatabaseSync(file);
  const db = new SqliteCompanyDb(file, raw);
  try {
    if (!inMemory && posix) chmodSync(file, 0o600);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec("PRAGMA busy_timeout = 5000");
    if (!inMemory) raw.exec("PRAGMA journal_mode = WAL");
    migrate(db, migrations);
  } catch (err) {
    db.close(); // an open handle would keep the files locked on Windows
    throw err;
  }
  return db;
}

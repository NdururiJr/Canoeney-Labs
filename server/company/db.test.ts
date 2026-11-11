import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openCompanyDb, SchemaTooNewError, type CompanyDb } from "./db";
import { migrate, schemaVersion, type Migration } from "./migrations";

// The prefix has spaces on purpose: paths with spaces must work everywhere.
// Windows keeps WAL files locked until the database is closed, so every
// database opened through open() is closed (close is idempotent) before rmSync.
function tmpStore(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "hq company "));
  const file = join(dir, "company.db");
  const opened: CompanyDb[] = [];
  t.after(() => {
    for (const db of opened) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const open = (migrations?: readonly Migration[]): CompanyDb => {
    const db = openCompanyDb(file, migrations);
    opened.push(db);
    return db;
  };
  return { dir, file, open };
}

const m1: Migration = { version: 1, name: "a", up: "CREATE TABLE a(x INTEGER);" };
const m2: Migration = { version: 2, name: "b", up: "CREATE TABLE b(y INTEGER);" };

const tableNames = (db: CompanyDb): string[] =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>()
    .map((r) => r.name);

test("opens a file store with WAL and foreign keys on", (t) => {
  const { open } = tmpStore(t);
  const db = open();
  assert.equal(db.prepare("PRAGMA journal_mode").get<{ journal_mode: string }>()?.journal_mode, "wal");
  assert.equal(db.prepare("PRAGMA foreign_keys").get<{ foreign_keys: number }>()?.foreign_keys, 1);
  assert.equal(db.prepare("PRAGMA busy_timeout").get<{ timeout: number }>()?.timeout, 5000);
});

test("an in-memory store reports the memory journal", (t) => {
  const db = openCompanyDb(":memory:", []);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA journal_mode").get<{ journal_mode: string }>()?.journal_mode, "memory");
  assert.equal(schemaVersion(db), 0);
});

test("migrate applies pending migrations in order and records them", (t) => {
  const { open } = tmpStore(t);
  const db = open([m1, m2]);
  const versions = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all<{ version: number }>()
    .map((r) => r.version);
  assert.deepEqual(versions, [1, 2]);
  const tables = tableNames(db);
  assert.ok(tables.includes("a"));
  assert.ok(tables.includes("b"));
});

test("reopening applies nothing", (t) => {
  const { open } = tmpStore(t);
  open([m1, m2]).close();
  const db = open([m1, m2]);
  assert.deepEqual(migrate(db, [m1, m2]).applied, []);
});

test("a failing migration rolls back and leaves the version unchanged", (t) => {
  const { open } = tmpStore(t);
  const bad: Migration = { version: 2, name: "bad", up: "CREATE TABLE b(y INTEGER); NOT SQL;" };
  assert.throws(() => open([m1, bad]));
  const db = open([m1]);
  assert.equal(schemaVersion(db), 1);
  assert.ok(!tableNames(db).includes("b"));
});

test("refuses a store newer than the code", (t) => {
  const { open } = tmpStore(t);
  open([m1, m2]).close();
  assert.throws(
    () => open([m1]),
    (err: unknown) =>
      err instanceof SchemaTooNewError && /2.*1|1.*2/.test(err.message),
  );
});

test("transaction commits on return", (t) => {
  const { open } = tmpStore(t);
  const db = open([m1]);
  const n = db.transaction(() => {
    db.prepare("INSERT INTO a(x) VALUES (?)").run(7);
    return 42;
  });
  assert.equal(n, 42);
  assert.equal(db.prepare("SELECT x FROM a").get<{ x: number }>()?.x, 7);
});

test("transaction rolls back on throw", (t) => {
  const { open } = tmpStore(t);
  const db = open([m1]);
  assert.throws(
    () =>
      db.transaction(() => {
        db.prepare("INSERT INTO a(x) VALUES (?)").run(1);
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM a").get<{ n: number }>()?.n, 0);
  // The wrapper recovered: a new transaction works.
  db.transaction(() => db.prepare("INSERT INTO a(x) VALUES (?)").run(2), "immediate");
  assert.equal(db.prepare("SELECT count(*) AS n FROM a").get<{ n: number }>()?.n, 1);
});

test("nested transaction throws", (t) => {
  const { open } = tmpStore(t);
  const db = open([m1]);
  assert.throws(
    () => db.transaction(() => db.transaction(() => 1)),
    /nested transaction/,
  );
  // The outer transaction rolled back and the depth counter reset.
  assert.equal(db.transaction(() => 5), 5);
});

test("opens and reopens a store in a folder with spaces", (t) => {
  const { dir, open } = tmpStore(t);
  assert.ok(dir.includes(" "));
  open([m1, m2]).close();
  const db = open([m1, m2]);
  assert.equal(schemaVersion(db), 2);
});

test("store file is private on POSIX", { skip: process.platform === "win32" }, (t) => {
  const { file, open } = tmpStore(t);
  open();
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

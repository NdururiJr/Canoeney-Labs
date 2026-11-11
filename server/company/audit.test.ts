import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AuditSecretError, GENESIS_HASH, SqliteAuditSink } from "./audit";
import { FakeClock } from "./clock";
import { openCompanyDb, type CompanyDb } from "./db";
import type { AuditEventInput } from "./slots/types";

const START = "2026-11-11T06:00:00.000Z";

function fresh(t: { after(fn: () => void): void }, clock = new FakeClock(START)) {
  const db = openCompanyDb(":memory:");
  t.after(() => db.close());
  return { db, clock, sink: new SqliteAuditSink(db, clock) };
}

const ev = (over: Partial<AuditEventInput> = {}): AuditEventInput => ({
  actorKind: "agent",
  actorId: "a1",
  action: "tool.call",
  ...over,
});

test("first event links to the genesis hash", (t) => {
  const { sink } = fresh(t);
  const e = sink.append(ev());
  assert.equal(e.seq, 1);
  assert.equal(e.prevHash, GENESIS_HASH);
  assert.match(e.hash, /^[0-9a-f]{64}$/);
  assert.equal(e.at, START);
  assert.equal(e.target, null);
  assert.equal(e.decisionId, null);
  assert.deepEqual(e.data, {});
});

test("each event links to the previous one", (t) => {
  const { sink } = fresh(t);
  sink.append(ev());
  const e2 = sink.append(ev());
  const e3 = sink.append(ev());
  assert.equal(e3.prevHash, e2.hash);
  assert.deepEqual(sink.head(), { seq: 3, hash: e3.hash });
});

test("head is null on an empty chain and verify of an empty chain is ok", (t) => {
  const { sink } = fresh(t);
  assert.equal(sink.head(), null);
  assert.deepEqual(sink.verify(), { ok: true, count: 0, head: null });
});

function three(sink: SqliteAuditSink) {
  sink.append(ev({ data: { n: 1 } }));
  sink.append(ev({ data: { n: 2 } }));
  return sink.append(ev({ data: { n: 3 } }));
}

test("verify passes on an untouched chain", (t) => {
  const { sink } = fresh(t);
  const e3 = three(sink);
  assert.deepEqual(sink.verify(), { ok: true, count: 3, head: e3.hash });
});

test("verify finds an edited row", (t) => {
  const { db, sink } = fresh(t);
  three(sink);
  db.exec("DROP TRIGGER audit_events_no_update");
  db.exec(`UPDATE audit_events SET data_json = '{"x":2}' WHERE seq = 2`);
  assert.deepEqual(sink.verify(), { ok: false, brokenAtSeq: 2 });
});

test("verify finds a deleted row", (t) => {
  const { db, sink } = fresh(t);
  three(sink);
  db.exec("DROP TRIGGER audit_events_no_delete");
  db.exec("DELETE FROM audit_events WHERE seq = 2");
  assert.deepEqual(sink.verify(), { ok: false, brokenAtSeq: 3 });
});

function forge(db: CompanyDb, seq: number, prevHash: string, verb = "INSERT"): void {
  db.prepare(
    `${verb} INTO audit_events(seq, at, actor_kind, actor_id, action, target, decision_id, data_json, prev_hash, hash)
     VALUES (?, ?, 'hq', 'hq', 'forged', NULL, NULL, '{}', ?, ?)`,
  ).run(seq, START, prevHash, `forged${seq}`);
}

test("an INSERT OR REPLACE of an existing row is refused, and caught by verify without the trigger", (t) => {
  const { db, sink } = fresh(t);
  three(sink);
  const orig = db
    .prepare("SELECT at, actor_kind, actor_id, action, prev_hash, hash FROM audit_events WHERE seq = 2")
    .get<{ at: string; actor_kind: string; actor_id: string; action: string; prev_hash: string; hash: string }>()!;
  const replace = () =>
    db
      .prepare(
        `INSERT OR REPLACE INTO audit_events(seq, at, actor_kind, actor_id, action, target, decision_id, data_json, prev_hash, hash)
         VALUES (2, ?, ?, ?, ?, NULL, NULL, '{"x":2}', ?, ?)`,
      )
      .run(orig.at, orig.actor_kind, orig.actor_id, orig.action, orig.prev_hash, orig.hash);
  // The delete trigger does not fire on REPLACE (no recursive_triggers); the chain trigger does.
  assert.throws(replace, /audit chain/);
  assert.deepEqual(sink.verify(), { ok: true, count: 3, head: sink.head()!.hash });
  db.exec("DROP TRIGGER audit_events_chain");
  replace();
  assert.deepEqual(sink.verify(), { ok: false, brokenAtSeq: 2 });
});

test("a forged insert that does not extend the chain is refused", (t) => {
  const { db, sink } = fresh(t);
  const e3 = three(sink);
  assert.throws(() => forge(db, 0, GENESIS_HASH), /audit chain/);
  assert.throws(() => forge(db, -5, GENESIS_HASH), /audit chain/);
  assert.throws(() => forge(db, 5, e3.hash), /audit chain/); // skips seq 4
  assert.throws(() => forge(db, 4, GENESIS_HASH), /audit chain/); // wrong prev_hash
  assert.deepEqual(sink.verify(), { ok: true, count: 3, head: e3.hash });
  assert.deepEqual(
    sink.query().map((e) => e.seq),
    [1, 2, 3],
  );
});

test("the first event of an empty chain must have seq 1 and the genesis hash", (t) => {
  const { db } = fresh(t);
  assert.throws(() => forge(db, 2, GENESIS_HASH), /audit chain/);
  assert.throws(() => forge(db, 1, "f".repeat(64)), /audit chain/);
  forge(db, 1, GENESIS_HASH);
});

test("verify fails on a row outside the chain and reports its seq", (t) => {
  const { db, sink } = fresh(t);
  three(sink);
  db.exec("DROP TRIGGER audit_events_chain");
  forge(db, 0, GENESIS_HASH);
  assert.deepEqual(sink.verify(), { ok: false, brokenAtSeq: 0 });
  forge(db, -5, GENESIS_HASH);
  assert.deepEqual(sink.verify(), { ok: false, brokenAtSeq: -5 }); // the lowest stray row
});

test("hash is independent of key order and survives unicode", (t) => {
  const clock = new FakeClock(START);
  const a = fresh(t, clock);
  const b = fresh(t, clock);
  const name = "Wanjirũ Ndũrũrĩ 🚀";
  const e1 = a.sink.append(ev({ data: { name, z: 1, a: { y: 2, x: 1 } } }));
  const e2 = b.sink.append(ev({ data: { a: { x: 1, y: 2 }, z: 1, name } }));
  assert.equal(e1.hash, e2.hash);
  assert.equal(a.sink.query()[0]!.data.name, name);
  assert.deepEqual(a.sink.verify().ok, true);
});

test("refuses secret-shaped keys anywhere in data", (t) => {
  const { sink } = fresh(t);
  for (const data of [{ token: "x" }, { nested: { API_KEY: "x" } }, { list: [{ Password: "x" }] }]) {
    assert.throws(() => sink.append(ev({ data })), AuditSecretError);
  }
  assert.equal(sink.head(), null);
  sink.append(ev({ data: { secretName: "github" } }));
  assert.equal(sink.head()?.seq, 1);
});

test("refuses broader secret-shaped keys", (t) => {
  const { sink } = fresh(t);
  const bad = ["access_token", "refreshToken", "client_secret", "x-api-key", "password_hash", "Bearer", "privateKey", "AWS_CREDENTIALS", "api key"];
  for (const key of bad) {
    assert.throws(() => sink.append(ev({ data: { [key]: "x" } })), AuditSecretError, key);
    assert.throws(() => sink.append(ev({ data: { deep: [{ [key]: "x" }] } })), AuditSecretError, key);
  }
  assert.equal(sink.head(), null);
  for (const key of ["secretName", "inputTokens", "tokenCount", "pinned", "prevHash"]) {
    sink.append(ev({ data: { [key]: "ok" } }));
  }
  assert.equal(sink.head()?.seq, 5);
});

test("refuses malformed unicode in actor, action, target or decisionId", (t) => {
  const { sink } = fresh(t);
  const bad = "a\uD800b";
  for (const over of [{ actorId: bad }, { action: bad }, { target: bad }, { decisionId: bad }]) {
    assert.throws(() => sink.append(ev(over)), TypeError);
  }
  assert.equal(sink.head(), null);
  // well-formed astral characters are fine and verify
  sink.append(ev({ actorId: "🚀", target: "Wanjirũ" }));
  assert.equal(sink.verify().ok, true);
});

test("append joins a caller's transaction and commits with it", (t) => {
  const { db, sink } = fresh(t);
  db.transaction(() => {
    db.prepare("INSERT INTO humans(id, display_name, role, created_at) VALUES ('h1', 'H', 'owner', ?)").run(START);
    sink.append(ev({ data: { n: 1 } }));
    sink.append(ev({ data: { n: 2 } }));
  }, "immediate");
  assert.equal(db.prepare("SELECT count(*) AS n FROM humans").get<{ n: number }>()?.n, 1);
  assert.deepEqual(sink.verify().ok && sink.verify(), { ok: true, count: 2, head: sink.head()!.hash });
});

test("append rolls back with a caller's transaction", (t) => {
  const { db, sink } = fresh(t);
  assert.throws(
    () =>
      db.transaction(() => {
        db.prepare("INSERT INTO humans(id, display_name, role, created_at) VALUES ('h1', 'H', 'owner', ?)").run(START);
        sink.append(ev());
        throw new Error("boom");
      }, "immediate"),
    /boom/,
  );
  assert.equal(sink.head(), null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM humans").get<{ n: number }>()?.n, 0);
  assert.equal(sink.append(ev()).seq, 1); // still usable afterwards
});

test("clock going backwards does not break order or verification", (t) => {
  const { sink, clock } = fresh(t);
  sink.append(ev());
  clock.set("2020-01-01T00:00:00.000Z");
  sink.append(ev());
  assert.deepEqual(
    sink.query().map((e) => e.seq),
    [1, 2],
  );
  assert.equal(sink.verify().ok, true);
});

test("query filters", (t) => {
  const { sink } = fresh(t);
  for (let i = 1; i <= 5; i++) {
    sink.append(ev({ actorId: i % 2 ? "odd" : "even", action: i === 5 ? "x.y" : "tool.call", decisionId: i === 2 ? "d1" : null }));
  }
  assert.deepEqual(
    sink.query({ actorId: "odd" }).map((e) => e.seq),
    [1, 3, 5],
  );
  assert.deepEqual(
    sink.query({ afterSeq: 3 }).map((e) => e.seq),
    [4, 5],
  );
  assert.deepEqual(
    sink.query({ action: "x.y" }).map((e) => e.seq),
    [5],
  );
  assert.deepEqual(
    sink.query({ decisionId: "d1" }).map((e) => e.seq),
    [2],
  );
});

test("query defaults to 100 and caps at 1000", (t) => {
  const { sink } = fresh(t);
  for (let i = 0; i < 1001; i++) sink.append(ev());
  assert.equal(sink.query().length, 100);
  assert.equal(sink.query({ limit: 5000 }).length, 1000);
});

test("two connections appending interleaved keep one valid chain", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hq audit "));
  const file = join(dir, "company.db");
  const dbs: CompanyDb[] = [];
  t.after(() => {
    for (const d of dbs) d.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const clock = new FakeClock(START);
  const d1 = openCompanyDb(file);
  dbs.push(d1);
  const d2 = openCompanyDb(file);
  dbs.push(d2);
  const s1 = new SqliteAuditSink(d1, clock);
  const s2 = new SqliteAuditSink(d2, clock);
  for (let i = 0; i < 20; i++) (i % 2 ? s2 : s1).append(ev({ data: { i } }));
  for (const s of [s1, s2]) {
    const v = s.verify();
    assert.equal(v.ok, true);
    assert.equal(v.ok && v.count, 20);
    assert.deepEqual(
      s.query().map((e) => e.seq),
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  }
});

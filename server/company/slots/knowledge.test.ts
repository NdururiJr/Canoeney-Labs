import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteAuditSink } from "../audit";
import { FakeClock } from "../clock";
import { openCompanyDb } from "../db";
import { SqliteKnowledgeStore } from "./knowledge";

const START = "2026-11-11T06:00:00.000Z";

function fresh(t: { after(fn: () => void): void }) {
  const db = openCompanyDb(":memory:");
  t.after(() => db.close());
  const clock = new FakeClock(START);
  const audit = new SqliteAuditSink(db, clock);
  const addHuman = (id: string, role = "supervisor") =>
    db.prepare("INSERT INTO humans(id, display_name, role, created_at) VALUES (?, ?, ?, ?)").run(id, id, role, START);
  addHuman("owner1", "owner");
  return { db, clock, audit, addHuman, store: new SqliteKnowledgeStore(db, clock, audit) };
}

test("put creates version 1 then 2", (t) => {
  const { store, clock } = fresh(t);
  const d1 = store.put({ id: "refund-policy", title: "Refunds", body: "first" }, "owner1");
  assert.deepEqual(d1, { id: "refund-policy", title: "Refunds", body: "first", version: 1, updatedAt: START });
  clock.advance(1_000);
  const d2 = store.put({ id: "refund-policy", title: "Refunds v2", body: "second" }, "owner1");
  assert.equal(d2.version, 2);
  assert.equal(d2.updatedAt, "2026-11-11T06:00:01.000Z");
  assert.deepEqual(store.reader().get("refund-policy"), d2);
});

test("put audits the id and version, never the body", (t) => {
  const { store, audit } = fresh(t);
  store.put({ id: "p", title: "T", body: "SECRET-BODY-TEXT" }, "owner1");
  store.put({ id: "p", title: "T", body: "SECRET-BODY-TEXT" }, "owner1");
  const last = audit.query().at(-1);
  assert.ok(last);
  assert.equal(last.action, "knowledge.put");
  assert.equal(last.actorKind, "human");
  assert.equal(last.actorId, "owner1");
  assert.equal(last.target, "p");
  assert.deepEqual(last.data, { version: 2 });
  assert.ok(!JSON.stringify(last).includes("SECRET-BODY-TEXT"));
});

test("put rolls back the document when the audit append fails", (t) => {
  const { store, audit, addHuman } = fresh(t);
  // SQLite stores a lone surrogate as U+FFFD, so give the FK a matching row;
  // the failure then comes from the audit well-formedness guard.
  addHuman("a�b");
  const head = audit.head();
  assert.throws(() => store.put({ id: "p", title: "T", body: "b" }, "a\uD800b"), TypeError);
  assert.equal(store.reader().get("p"), null);
  assert.deepEqual(audit.head(), head);
});

test("reader exposes only get and list", (t) => {
  const { store } = fresh(t);
  const reader = store.reader();
  assert.deepEqual(Object.keys(reader).sort(), ["get", "list"]);
  assert.equal(Object.isFrozen(reader), true);
  assert.equal("put" in reader, false);
});

test("returned docs are copies", (t) => {
  const { store } = fresh(t);
  const d = store.put({ id: "p", title: "T", body: "b" }, "owner1");
  d.title = "mutated";
  const got = store.reader().get("p");
  assert.ok(got);
  assert.equal(got.title, "T");
  got.body = "mutated";
  assert.equal(store.reader().get("p")?.body, "b");
});

test("list omits bodies and is ordered by id", (t) => {
  const { store } = fresh(t);
  store.put({ id: "b", title: "B", body: "body-b" }, "owner1");
  store.put({ id: "a", title: "A", body: "body-a" }, "owner1");
  const list = store.reader().list();
  assert.deepEqual(list, [
    { id: "a", title: "A", version: 1, updatedAt: START },
    { id: "b", title: "B", version: 1, updatedAt: START },
  ]);
  assert.ok(list.every((d) => !("body" in d)));
});

test("get of an unknown id is null", (t) => {
  const { store } = fresh(t);
  assert.equal(store.reader().get("nope"), null);
});

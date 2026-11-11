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

test("put creates version 1 then 2", async (t) => {
  const { store, clock } = fresh(t);
  const d1 = store.put({ id: "refund-policy", title: "Refunds", body: "first" }, "owner1");
  assert.deepEqual(d1, { id: "refund-policy", title: "Refunds", body: "first", version: 1, updatedAt: START });
  clock.advance(1_000);
  const d2 = store.put({ id: "refund-policy", title: "Refunds v2", body: "second" }, "owner1");
  assert.equal(d2.version, 2);
  assert.equal(d2.updatedAt, "2026-11-11T06:00:01.000Z");
  assert.deepEqual(await store.reader().get("refund-policy"), d2);
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

test("put rolls back the document when the audit append fails", async (t) => {
  const { store, audit, addHuman } = fresh(t);
  // SQLite stores a lone surrogate as U+FFFD, so give the FK a matching row;
  // the failure then comes from the audit well-formedness guard.
  addHuman("a�b");
  const head = audit.head();
  assert.throws(() => store.put({ id: "p", title: "T", body: "b" }, "a\uD800b"), TypeError);
  assert.equal(await store.reader().get("p"), null);
  assert.deepEqual(audit.head(), head);
});

test("reader exposes only get and list, and both return promises", async (t) => {
  const { store } = fresh(t);
  const reader = store.reader();
  assert.deepEqual(Object.keys(reader).sort(), ["get", "list"]);
  assert.equal(Object.isFrozen(reader), true);
  assert.equal("put" in reader, false);
  for (const p of [reader.get("x"), reader.list()]) {
    assert.ok(p instanceof Promise);
    await p;
  }
});

test("returned docs are copies", async (t) => {
  const { store } = fresh(t);
  const d = store.put({ id: "p", title: "T", body: "b" }, "owner1");
  d.title = "mutated";
  const got = await store.reader().get("p");
  assert.ok(got);
  assert.equal(got.title, "T");
  got.body = "mutated";
  assert.equal((await store.reader().get("p"))?.body, "b");
});

test("list omits bodies and is ordered by id", async (t) => {
  const { store } = fresh(t);
  store.put({ id: "b", title: "B", body: "body-b" }, "owner1");
  store.put({ id: "a", title: "A", body: "body-a" }, "owner1");
  const list = await store.reader().list();
  assert.deepEqual(list, [
    { id: "a", title: "A", version: 1, updatedAt: START },
    { id: "b", title: "B", version: 1, updatedAt: START },
  ]);
  assert.ok(list.every((d) => !("body" in d)));
});

test("get of an unknown id is null", async (t) => {
  const { store } = fresh(t);
  assert.equal(await store.reader().get("nope"), null);
});

test("put joins a caller's transaction and rolls back with it", (t) => {
  const { db, store, audit } = fresh(t);
  db.transaction(() => {
    store.put({ id: "p", title: "T", body: "b" }, "owner1");
    audit.append({ actorKind: "hq", actorId: "hq", action: "after.put" });
  }, "immediate");
  assert.deepEqual(
    audit.query().map((e) => e.action),
    ["knowledge.put", "after.put"],
  );
  assert.throws(
    () =>
      db.transaction(() => {
        store.put({ id: "q", title: "T", body: "b" }, "owner1");
        throw new Error("boom");
      }, "immediate"),
    /boom/,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM knowledge_docs WHERE id = 'q'").get<{ n: number }>()?.n, 0);
  assert.equal(audit.head()?.seq, 2);
});

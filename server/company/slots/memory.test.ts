import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeClock } from "../clock";
import { openCompanyDb } from "../db";
import { SqliteMemory } from "./memory";

const START = "2026-11-11T06:00:00.000Z";

function fresh(t: { after(fn: () => void): void }) {
  const db = openCompanyDb(":memory:");
  t.after(() => db.close());
  const clock = new FakeClock(START);
  return { clock, mem: new SqliteMemory(db, clock) };
}

test("scopes are isolated", (t) => {
  const { mem } = fresh(t);
  mem.set({ kind: "agent", id: "a" }, "k", "v");
  assert.equal(mem.get({ kind: "agent", id: "a" }, "k"), "v");
  assert.equal(mem.get({ kind: "agent", id: "b" }, "k"), null);
  assert.equal(mem.get({ kind: "client", id: "a" }, "k"), null);
});

test("set overwrites and stamps the clock time", (t) => {
  const { mem, clock } = fresh(t);
  const s = { kind: "agent", id: "a" } as const;
  mem.set(s, "k", "one");
  clock.advance(5_000);
  mem.set(s, "k", "two");
  assert.equal(mem.get(s, "k"), "two");
  assert.deepEqual(mem.list(s), [{ key: "k", value: "two", updatedAt: "2026-11-11T06:00:05.000Z" }]);
});

test("list is sorted by key", (t) => {
  const { mem } = fresh(t);
  const s = { kind: "client", id: "c" } as const;
  mem.set(s, "b", "2");
  mem.set(s, "c", "3");
  mem.set(s, "a", "1");
  assert.deepEqual(
    mem.list(s).map((e) => e.key),
    ["a", "b", "c"],
  );
});

test("delete reports whether a row existed", (t) => {
  const { mem } = fresh(t);
  const s = { kind: "agent", id: "a" } as const;
  mem.set(s, "k", "v");
  assert.equal(mem.delete(s, "k"), true);
  assert.equal(mem.delete(s, "k"), false);
  assert.equal(mem.get(s, "k"), null);
});

test("rejects values over 64 KiB", (t) => {
  const { mem } = fresh(t);
  const s = { kind: "agent", id: "a" } as const;
  assert.throws(() => mem.set(s, "k", "é".repeat(32_769)), RangeError);
  mem.set(s, "k", "é".repeat(32_768)); // exactly 65,536 bytes is allowed
  assert.equal(mem.get(s, "k")?.length, 32_768);
});

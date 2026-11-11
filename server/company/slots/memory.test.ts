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

test("every method returns a promise", async (t) => {
  const { mem } = fresh(t);
  const s = { kind: "agent", id: "a" } as const;
  for (const p of [mem.set(s, "k", "v"), mem.get(s, "k"), mem.list(s), mem.delete(s, "k")]) {
    assert.ok(p instanceof Promise);
    await p;
  }
});

test("scopes are isolated", async (t) => {
  const { mem } = fresh(t);
  await mem.set({ kind: "agent", id: "a" }, "k", "v");
  assert.equal(await mem.get({ kind: "agent", id: "a" }, "k"), "v");
  assert.equal(await mem.get({ kind: "agent", id: "b" }, "k"), null);
  assert.equal(await mem.get({ kind: "client", id: "a" }, "k"), null);
});

test("set overwrites and stamps the clock time", async (t) => {
  const { mem, clock } = fresh(t);
  const s = { kind: "agent", id: "a" } as const;
  await mem.set(s, "k", "one");
  clock.advance(5_000);
  await mem.set(s, "k", "two");
  assert.equal(await mem.get(s, "k"), "two");
  assert.deepEqual(await mem.list(s), [{ key: "k", value: "two", updatedAt: "2026-11-11T06:00:05.000Z" }]);
});

test("list is sorted by key", async (t) => {
  const { mem } = fresh(t);
  const s = { kind: "client", id: "c" } as const;
  await mem.set(s, "b", "2");
  await mem.set(s, "c", "3");
  await mem.set(s, "a", "1");
  assert.deepEqual(
    (await mem.list(s)).map((e) => e.key),
    ["a", "b", "c"],
  );
});

test("delete reports whether a row existed", async (t) => {
  const { mem } = fresh(t);
  const s = { kind: "agent", id: "a" } as const;
  await mem.set(s, "k", "v");
  assert.equal(await mem.delete(s, "k"), true);
  assert.equal(await mem.delete(s, "k"), false);
  assert.equal(await mem.get(s, "k"), null);
});

test("rejects values over 64 KiB", async (t) => {
  const { mem } = fresh(t);
  const s = { kind: "agent", id: "a" } as const;
  await assert.rejects(mem.set(s, "k", "é".repeat(32_769)), RangeError);
  await mem.set(s, "k", "é".repeat(32_768)); // exactly 65,536 bytes is allowed
  assert.equal((await mem.get(s, "k"))?.length, 32_768);
});

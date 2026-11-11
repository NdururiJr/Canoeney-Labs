import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeClock, systemClock } from "./clock";

test("FakeClock starts where told and advances", () => {
  const c = new FakeClock("2026-11-11T06:00:00.000Z");
  assert.equal(c.now().toISOString(), "2026-11-11T06:00:00.000Z");
  c.advance(90_000);
  assert.equal(c.now().toISOString(), "2026-11-11T06:01:30.000Z");
});

test("FakeClock.set can move backwards", () => {
  const c = new FakeClock("2026-11-11T06:00:00.000Z");
  c.set("2026-11-10T00:00:00.000Z");
  assert.equal(c.now().toISOString(), "2026-11-10T00:00:00.000Z");
});

test("mutating a returned Date does not move the clock", () => {
  const c = new FakeClock("2026-11-11T06:00:00.000Z");
  c.now().setUTCFullYear(1999);
  assert.equal(c.now().toISOString(), "2026-11-11T06:00:00.000Z");
});

test("systemClock is close to Date.now()", () => {
  assert.ok(Math.abs(systemClock.now().getTime() - Date.now()) < 1000);
});

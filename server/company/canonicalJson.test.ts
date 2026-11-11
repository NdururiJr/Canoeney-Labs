import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "./canonicalJson";

test("sorts keys recursively and omits undefined", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }),
    '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
  );
});

test("rejects non-plain values", () => {
  for (const bad of [NaN, Infinity, 10n, new Date(), new Map(), () => 1]) {
    assert.throws(() => canonicalJson(bad), TypeError);
  }
});

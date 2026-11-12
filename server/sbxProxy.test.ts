import assert from "node:assert/strict";
import { test } from "node:test";
import { redactProxy } from "./sbx";

test("SR-C-17 [T-S5.10] a proxy read back from sbx never carries its password to the browser", () => {
  assert.equal(redactProxy("http://user:sk-secret-123@proxy.example:8080"), "http://proxy.example:8080");
  assert.equal(redactProxy("https://token@proxy.example"), "https://proxy.example");
  assert.equal(redactProxy("http://proxy.example:3128"), "http://proxy.example:3128");
  assert.equal(redactProxy(""), null);
  // Not a URL sbx would accept: shown as set, never echoed.
  assert.equal(redactProxy("user:sk-secret-123@proxy"), "(set)");
});

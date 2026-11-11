import assert from "node:assert/strict";
import { test } from "node:test";
import { newReplyCode, REPLY_CODE_ALPHABET, REPLY_CODE_LENGTH, REPLY_CODE_PATTERN } from "./replyCode";

test("1000 new codes all match the pattern and use only the alphabet", () => {
  for (let i = 0; i < 1000; i++) {
    const c = newReplyCode();
    assert.equal(c.length, REPLY_CODE_LENGTH);
    assert.ok(REPLY_CODE_PATTERN.test(`#${c}`), c);
    for (const ch of c) assert.ok(REPLY_CODE_ALPHABET.includes(ch), `${ch} in ${c}`);
  }
});

test("excludes look-alike characters", () => {
  assert.equal(REPLY_CODE_ALPHABET.length, 31);
  for (let i = 0; i < 1000; i++) assert.doesNotMatch(newReplyCode(), /[0O1IL]/);
});

test("pattern is stateless and respects boundaries", () => {
  assert.equal(REPLY_CODE_PATTERN.global, false);
  assert.ok(REPLY_CODE_PATTERN.test("#K7Q2M"));
  assert.ok(REPLY_CODE_PATTERN.test("#K7Q2M"));
  assert.ok(REPLY_CODE_PATTERN.test("ok #k7q2m."));
  assert.ok(!REPLY_CODE_PATTERN.test("#K7Q2MX"));
  assert.ok(!REPLY_CODE_PATTERN.test("#K7Q2M9"));
  assert.ok(!REPLY_CODE_PATTERN.test("#K7Q2"));
});

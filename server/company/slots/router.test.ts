import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalRouter } from "./router";
import type { InboundMessage, Route } from "./types";

const msg = (text: string): InboundMessage => ({
  channel: "whatsapp",
  senderRef: "+254700000000",
  text,
  receivedAt: "2026-11-11T06:00:00.000Z",
});

const K7Q2M: Route = { kind: "decision-reply", code: "K7Q2M" };
const NO_CODE: Route = { kind: "unrouted", reason: "no-code" };

const cases: [string, Route][] = [
  ["yes #k7q2m", K7Q2M],
  ["#K7Q2M #K7Q2M approve", K7Q2M],
  ["#k7q2m #K7Q2M", K7Q2M],
  ["#K7Q2M.", K7Q2M],
  ["#K7Q2M and #ABCDE", { kind: "unrouted", reason: "ambiguous" }],
  ["approve", NO_CODE],
  ["#K7Q2", NO_CODE],
  ["#K7Q2MX", NO_CODE],
  ["#O0I1L", NO_CODE],
  ["REJECT", NO_CODE],
];

for (const [text, expected] of cases) {
  test(`routes ${JSON.stringify(text)}`, () => {
    assert.deepEqual(new LocalRouter().route(msg(text)), expected);
  });
}

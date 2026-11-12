import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseSource } from "./authState";
import { statusAfterClose } from "./ws/wsSource";

const json = (body: unknown) => async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const html = async () => new Response("<!doctype html><div id=root></div>", { headers: { "content-type": "text/html" } });
const down = async (): Promise<Response> => {
  throw new TypeError("fetch failed");
};

test("the UI chooses the real source when /auth/state answers", async () => {
  assert.equal(await chooseSource(json({ enrolled: false, session: null }), false), "hq");
  assert.equal(await chooseSource(json({ enrolled: true, session: null }), true), "hq");
});

test("the demo office appears only in development; the built page says HQ can't be reached", async () => {
  // `pnpm dev` with no HQ: Vite answers /auth/state with its HTML page.
  assert.equal(await chooseSource(html, true), "mock");
  assert.equal(await chooseSource(down, true), "mock");
  // The page HQ serves never falls back to invented agents and tasks.
  assert.equal(await chooseSource(html, false), "unreachable");
  assert.equal(await chooseSource(down, false), "unreachable");
  assert.equal(await chooseSource(async () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } }), false), "unreachable");
});

test("an unauthorized socket shows the login screen", () => {
  // HQ closes a socket whose session ended with 4401.
  assert.equal(statusAfterClose({ code: 4401, opened: true, retry: 0 }), "unauthorized");
  // An upgrade refused with 401 never opens: after a few tries, it is the session.
  assert.equal(statusAfterClose({ code: 1006, opened: false, retry: 3 }), "unauthorized");
  assert.equal(statusAfterClose({ code: 1006, opened: false, retry: 0 }), "reconnecting");
  assert.equal(statusAfterClose({ code: 1006, opened: true, retry: 5 }), "reconnecting");
});

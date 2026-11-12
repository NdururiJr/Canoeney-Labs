import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { makeHq, openWs, ORIGIN, OWNER_PASSWORD, wsStatus, type Hq } from "./testing/hqFixture";
import { stepOf, totpAt, base32Decode } from "./company/totp";

const MINUTE = 60_000;
const rows = (hq: Hq, action: string) => hq.company.audit.query({ action });
const withOrigin = (cookie: string, extra: Record<string, string> = {}) => ({ cookie, origin: ORIGIN, ...extra });

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

async function post(hq: Hq, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${hq.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

test("SR-C-01 [T-S5.1] a WebSocket upgrade with no session gets 401", async (t) => {
  const hq = await makeHq(t);
  assert.equal(await wsStatus(hq, { origin: ORIGIN }), 401);
  assert.equal(await wsStatus(hq, { origin: ORIGIN }, "/ws?token=anything"), 401);
  const cookie = await hq.sessionCookie();
  assert.equal(await wsStatus(hq, withOrigin(cookie)), 101);
});

test("SR-C-02 [T-S5.5 T-X3.8] the session cookie is HttpOnly and SameSite=Strict", async (t) => {
  const hq = await makeHq(t);
  const r = await hq.login();
  assert.equal(r.status, 200);
  assert.match(r.setCookie ?? "", /HttpOnly/);
  assert.match(r.setCookie ?? "", /SameSite=Strict/);
  assert.match(r.setCookie ?? "", /Path=\//);
  assert.doesNotMatch(r.setCookie ?? "", /Secure/);
  const viaHttps = await hq.login({ headers: { "x-forwarded-proto": "https" } });
  assert.match(viaHttps.setCookie ?? "", /; Secure/);
});

test("SR-C-02 [T-S5.5 T-X3.8] a session ends after the idle limit", async (t) => {
  const hq = await makeHq(t);
  const cookie = await hq.sessionCookie();
  hq.clock.advance(31 * MINUTE);
  assert.equal(await wsStatus(hq, withOrigin(cookie)), 401);
});

test("SR-C-02 [T-S5.5 T-X3.8] a session ends after the absolute limit, whatever its activity", async (t) => {
  const hq = await makeHq(t);
  const cookie = await hq.sessionCookie();
  for (let i = 0; i < 72; i++) {
    hq.clock.advance(10 * MINUTE);
    await fetch(`${hq.url}/auth/state`, { headers: { cookie } });
  }
  assert.equal(await wsStatus(hq, withOrigin(cookie)), 101);
  hq.clock.advance(10 * MINUTE);
  assert.equal(await wsStatus(hq, withOrigin(cookie)), 401);
});

test("SR-C-02 [T-S5.5 T-X3.8] logout ends the session on the server and closes its sockets", async (t) => {
  const hq = await makeHq(t);
  const cookie = await hq.sessionCookie();
  const { ws } = await openWs(hq, withOrigin(cookie));
  assert.ok(ws);
  const closed = closeCode(ws);
  const out = await post(hq, "/auth/logout", {}, { cookie });
  assert.equal(out.status, 200);
  assert.equal(await closed, 4401);
  assert.equal(await wsStatus(hq, withOrigin(cookie)), 401);
  assert.equal(rows(hq, "auth.logout").length, 1);
});

test("SR-C-02 [T-S5.5 T-X3.8] frames from HQ do not keep a session alive; commands from the client do", async (t) => {
  const hq = await makeHq(t);
  const idle = (await openWs(hq, withOrigin(await hq.sessionCookie()))).ws;
  const busy = (await openWs(hq, withOrigin(await hq.sessionCookie()))).ws;
  assert.ok(idle && busy);
  const idleClosed = closeCode(idle);
  let busyClosed = false;
  busy.once("close", () => (busyClosed = true));
  for (let i = 0; i < 4; i++) {
    hq.hub.activity("config", null, "a frame HQ pushes");
    busy.send(JSON.stringify({ cmd: "noop", args: [] }));
    await new Promise((r) => setTimeout(r, 50));
    hq.clock.advance(10 * MINUTE);
  }
  hq.ownerAuth.sweep();
  assert.equal(await idleClosed, 4401);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(busyClosed, false);
  busy.close();
});

test("SR-C-03 [T-S5.4] the upgrade needs a session and an allowed Origin", async (t) => {
  const hq = await makeHq(t);
  const cookie = await hq.sessionCookie();
  assert.equal(await wsStatus(hq, { cookie }), 401);
  assert.equal(await wsStatus(hq, { cookie, origin: "https://evil.example" }), 401);
  assert.equal(await wsStatus(hq, withOrigin(cookie)), 101);
});

test("SR-C-18 [T-S5.11] failures from one source do not lock a second source, and the lock expires", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  const a = { "x-forwarded-for": "10.0.0.1" };
  const b = { "x-forwarded-for": "10.0.0.2" };
  for (let i = 0; i < 5; i++) assert.equal((await hq.login({ password: "wrong password!", headers: a })).status, 401);
  assert.equal((await hq.login({ headers: a })).status, 429); // locked, even with the right password
  assert.equal((await hq.login({ headers: b })).status, 200);
  assert.equal(rows(hq, "auth.locked").length, 1);
  hq.clock.advance(15 * MINUTE);
  assert.equal((await hq.login({ headers: a })).status, 200);
});

test("SR-C-18 [T-S5.11] the source is the address the local proxy saw, not one the client chose", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  for (let n = 1; n <= 5; n++) {
    assert.equal((await hq.login({ password: "wrong password!", code: "000000", headers: { "x-forwarded-for": `9.9.9.${n}, 100.64.0.7` } })).status, 401);
  }
  assert.equal((await hq.login({ headers: { "x-forwarded-for": "9.9.9.200, 100.64.0.7" } })).status, 429);
  const failed = rows(hq, "auth.login.failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].data.source, "100.64.0.7");
  assert.ok(!JSON.stringify(hq.company.audit.query()).includes("9.9.9"));
  // A header that is a credential, or not an address at all, gets the uniform 401 and HQ keeps serving.
  for (const xff of [`ghp_${"a".repeat(36)}`, "not an address"]) {
    const r = await hq.login({ password: "wrong password!", headers: { "x-forwarded-for": xff } });
    assert.equal(r.status, 401);
  }
  assert.ok(!JSON.stringify(hq.company.audit.query()).includes("ghp_"));
  assert.equal((await fetch(`${hq.url}/api/health`)).status, 200);
});

test("a login through a local proxy is a remote session", async (t) => {
  const hq = await makeHq(t);
  const remote = await hq.login({ headers: { "x-forwarded-for": "100.64.0.7", host: "hq.example.ts.net" } });
  assert.equal(remote.body?.remote, true);
  const local = await hq.login();
  assert.equal(local.body?.remote, false);
  const viaTailscale = await hq.login({ headers: { "tailscale-user-login": "someone@example.com" } });
  assert.equal(viaTailscale.body?.remote, true);
});

test("a store with no owner reports enroll and writes the setup file 0600", async (t) => {
  const hq = await makeHq(t);
  const state = await (await fetch(`${hq.url}/auth/state`)).json();
  assert.deepEqual(state, { enrolled: false, session: null });
  assert.ok(existsSync(hq.setupFile));
  if (process.platform !== "win32") assert.equal(statSync(hq.setupFile).mode & 0o777, 0o600);
  const setupCode = readFileSync(hq.setupFile, "utf8").trim();

  const start = await post(hq, "/auth/enroll", { setupCode, displayName: "Jerry", password: OWNER_PASSWORD, pin: "583920" });
  assert.equal(start.status, 200);
  const seed = base32Decode(String(start.json?.secret));
  assert.match(String(start.json?.otpauth), /^otpauth:\/\/totp\//);
  const confirm = await post(hq, "/auth/enroll/confirm", { code: totpAt(seed, stepOf(hq.clock.now())), enrollToken: start.json?.enrollToken });
  assert.equal(confirm.status, 200);
  assert.match(confirm.setCookie ?? "", /hq_session=/);
  assert.equal(existsSync(hq.setupFile), false);
  assert.equal((await post(hq, "/auth/enroll", { setupCode, displayName: "X", password: OWNER_PASSWORD, pin: "583920" })).status, 401);
  const after = (await (await fetch(`${hq.url}/auth/state`)).json()) as { enrolled: boolean };
  assert.equal(after.enrolled, true);
});

test("enrollment needs the setup code, and a wrong one counts toward the lock", async (t) => {
  const hq = await makeHq(t);
  const bad = await post(hq, "/auth/enroll", { setupCode: "x".repeat(22), displayName: "X", password: OWNER_PASSWORD, pin: "583920" });
  assert.equal(bad.status, 401);
  assert.equal(hq.company.humans.hasOwner(), false);
  for (let i = 0; i < 4; i++) await post(hq, "/auth/enroll", { setupCode: "y".repeat(22) });
  const code = readFileSync(hq.setupFile, "utf8").trim();
  assert.equal((await post(hq, "/auth/enroll", { setupCode: code, displayName: "X", password: OWNER_PASSWORD, pin: "583920" })).status, 429);
});

test("an /auth POST needs an allowed Origin and JSON", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  assert.equal((await post(hq, "/auth/login", { password: OWNER_PASSWORD }, { origin: "https://evil.example" })).status, 403);
  const plain = await fetch(`${hq.url}/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "text/plain" }, body: "{}" });
  assert.equal(plain.status, 415);
});

test("after a restart the old cookie opens no WebSocket", async (t) => {
  const hq = await makeHq(t);
  const cookie = await hq.sessionCookie();
  assert.equal(await wsStatus(hq, withOrigin(cookie)), 101);
  await hq.restart();
  assert.equal(await wsStatus(hq, withOrigin(cookie)), 401);
});

test("a failed login writes no password or code", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  await hq.login({ password: "marker-password-123" });
  await hq.login({ code: "987654", password: "another-marker-pw" });
  const all = JSON.stringify(hq.company.audit.query());
  for (const m of ["marker-password-123", "another-marker-pw", "987654"]) assert.ok(!all.includes(m));
  assert.ok(rows(hq, "auth.login.failed").length >= 1);
});

test("SR-C-18 [T-S5.11] wrong logins sent at once still lock their source after five", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  let checks = 0;
  const real = hq.company.humans.verifyLogin.bind(hq.company.humans);
  hq.company.humans.verifyLogin = async (...a) => (checks++, real(...a));
  const headers = { "x-forwarded-for": "10.9.9.9" };
  const statuses = await Promise.all(Array.from({ length: 20 }, () => hq.login({ password: "wrong password!", code: "000000", headers }).then((r) => r.status)));
  assert.equal(statuses.filter((s) => s === 401).length, 5);
  assert.equal(statuses.filter((s) => s === 429).length, 15);
  assert.equal(checks, 5);
});

test("enrollment is confirmed only with the token from its own start, within ten minutes", async (t) => {
  const hq = await makeHq(t);
  const setupCode = readFileSync(hq.setupFile, "utf8").trim();
  const start = await post(hq, "/auth/enroll", { setupCode, displayName: "J", password: OWNER_PASSWORD, pin: "583920" });
  const seed = base32Decode(String(start.json?.secret));
  const code = () => totpAt(seed, stepOf(hq.clock.now()));
  assert.equal((await post(hq, "/auth/enroll/confirm", { code: code() })).status, 401);
  assert.equal((await post(hq, "/auth/enroll/confirm", { code: code(), enrollToken: "x".repeat(32) })).status, 401);
  hq.clock.advance(11 * MINUTE);
  assert.equal((await post(hq, "/auth/enroll/confirm", { code: code(), enrollToken: start.json?.enrollToken })).status, 401);
  assert.equal(hq.company.humans.hasOwner(), false);
});

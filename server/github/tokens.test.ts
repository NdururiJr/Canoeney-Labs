import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { FakeClock } from "../company/clock";
import { makeHq } from "../testing/hqFixture";
import { withSessions } from "../testing/sessionFixture";
import type { GitHubApi } from "./api";
import { APP_PERMISSIONS } from "./appManifest";
import { InstallationLookupError } from "./apps";
import { AgentTokens, revokeOnStatus } from "./tokens";

const NOW = "2026-11-14T10:00:00.000Z";
const HOUR = 3_600_000;
const OWNER = { kind: "human", id: "owner" } as const;

/** A fake GitHub that issues numbered tokens for an hour, and a timer queue the test drives. */
function harness(o: { identity?: boolean; lookup?: () => Promise<never> } = {}) {
  const clock = new FakeClock(NOW);
  const calls: { method: string; path: string; body?: unknown; token?: string; jwt?: string }[] = [];
  let n = 0;
  const api: GitHubApi = {
    async request(method, path, opts = {}) {
      calls.push({ method, path, body: opts.body, token: opts.token, jwt: opts.jwt });
      if (method === "POST" && path === "/app/installations/77/access_tokens") {
        n++;
        return { status: 201, json: { token: `ghs_${"t".repeat(30)}${n}`, expires_at: new Date(clock.now().getTime() + HOUR).toISOString() } as never };
      }
      if (method === "DELETE" && path === "/installation/token") return { status: 204, json: null };
      return { status: 404, json: null };
    },
  };
  const apps = {
    has: () => o.identity !== false,
    installation: async () => (o.lookup ? o.lookup() : o.identity === false ? null : { id: 77, selection: "selected" as const }),
    jwtFor: () => "jwt-for-the-app",
  };
  const keys: string[] = [];
  const sbx = {
    setKey: async (id: string | null, svc: string, v: string) => void keys.push(`set ${id} ${svc} ${v}`),
    removeKey: async (id: string | null, svc: string) => void keys.push(`rm ${id} ${svc}`),
  };
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const t = { at: clock.now().getTime() + ms, fn, cancelled: false };
    timers.push(t);
    return () => void (t.cancelled = true);
  };
  /** Moves the clock and runs every timer that is now due. */
  const advance = async (ms: number) => {
    clock.advance(ms);
    for (const t of timers.filter((x) => !x.cancelled && x.at <= clock.now().getTime())) {
      t.cancelled = true;
      t.fn();
    }
    await new Promise((r) => setTimeout(r, 0));
  };
  const rows: { action: string; actorId: string; data: Record<string, unknown> }[] = [];
  const audit = { append: (r: { action: string; actorId: string; data?: Record<string, unknown> }) => void rows.push({ action: r.action, actorId: r.actorId, data: r.data ?? {} }) } as never;
  const tokens = new AgentTokens({ apps, api, sbx, clock, audit, schedule });
  const issued = () => calls.filter((c) => c.method === "POST").length;
  return { tokens, calls, keys, rows, advance, issued, clock };
}

test("SR-E-04 [T-S3.10] a sandboxed agent gets a one-repo token as its own github key", async () => {
  const h = harness();
  assert.equal(await h.tokens.deliver("ana", "site/ana", "acme/site"), "issued");
  const req = h.calls.find((c) => c.method === "POST")!;
  assert.equal(req.jwt, "jwt-for-the-app");
  // One repository, and exactly the App's permissions (SR-E-02, ADR 0010).
  assert.deepEqual(req.body, { repositories: ["site"], permissions: { ...APP_PERMISSIONS } });
  assert.deepEqual(h.keys, [`set ana github ghs_${"t".repeat(30)}1`]);
  assert.equal(JSON.stringify(h.rows).includes("ghs_"), false, "no token in the audit trail");
});

test("the token is refreshed ten minutes before it expires, while the agent runs", async () => {
  const h = harness();
  await h.tokens.deliver("ana", "site/ana", "acme/site");
  await h.advance(HOUR - 10 * 60_000 - 1);
  assert.equal(h.issued(), 1);
  await h.advance(1);
  assert.equal(h.issued(), 2);
  assert.equal(h.keys.at(-1), `set ana github ghs_${"t".repeat(30)}2`);
  // The old token is revoked once the new one is in place.
  assert.ok(h.calls.some((c) => c.method === "DELETE" && c.token === `ghs_${"t".repeat(30)}1`));
});

test("SR-E-07 [T-S3.9] pausing revokes the agent's GitHub token, and a pending refresh issues nothing", async () => {
  const h = harness();
  await h.tokens.deliver("ana", "site/ana", "acme/site");
  await h.tokens.revoke("ana", "paused", OWNER);
  const del = h.calls.filter((c) => c.method === "DELETE");
  assert.equal(del.length, 1);
  assert.equal(del[0].token, `ghs_${"t".repeat(30)}1`);
  assert.equal(h.keys.at(-1), "rm ana github");
  assert.deepEqual(h.rows.map((r) => [r.action, r.actorId, r.data.reason]), [["github.token-revoked", "owner", "paused"]]);
  await h.advance(2 * HOUR);
  assert.equal(h.issued(), 1, "no token after the revoke");
});

test("stopping, retiring and HQ stopping each revoke", async () => {
  for (const reason of ["stopped", "retired", "hq-stopped"] as const) {
    const h = harness();
    await h.tokens.deliver("ana", "site/ana", "acme/site");
    await h.tokens.deliver("ben", "site/ben", "acme/site");
    if (reason === "hq-stopped") await h.tokens.revokeAll(reason);
    else await h.tokens.revoke("ana", reason, OWNER);
    const revoked = h.rows.filter((r) => r.action === "github.token-revoked").map((r) => r.data.reason);
    assert.deepEqual(revoked, reason === "hq-stopped" ? ["hq-stopped", "hq-stopped"] : [reason], reason);
  }
});

test("revoking an agent that holds no token calls nothing", async () => {
  const h = harness();
  await h.tokens.revoke("ana", "stopped", OWNER);
  assert.equal(h.calls.length, 0);
  assert.equal(h.rows.length, 0);
});

test("an agent with no GitHub identity gets no token", async () => {
  const h = harness({ identity: false });
  assert.equal(await h.tokens.deliver("ana", "site/ana", "acme/site"), "no-identity");
  assert.equal(h.issued(), 0);
  // Any github key in its sandbox is removed: HQ's is the only one an agent may hold (final review).
  assert.deepEqual(h.keys, ["rm ana github"]);
});

test("an installation lookup GitHub failed (HTTP 500) mints no token and leaves the agent without an identity", async () => {
  const h = harness({
    lookup: async () => {
      throw new InstallationLookupError(500);
    },
  });
  assert.equal(await h.tokens.deliver("ana", "site/ana", "acme/site"), "no-identity");
  assert.equal(h.issued(), 0);
  assert.deepEqual(h.keys, ["rm ana github"]);
  // Any other failure still reaches the caller, as before.
  const other = harness({
    lookup: async () => {
      throw new Error("the App key does not open");
    },
  });
  await assert.rejects(() => other.tokens.deliver("ana", "site/ana", "acme/site"), /does not open/);
  assert.equal(other.issued(), 0);
});

// ---------------------------------------------------------------- through Sessions

/** ana in a sandbox, with the sbx calls stubbed and a token broker that records what it is asked. */
async function sandboxed(t: TestContext) {
  const hq = await makeHq(t);
  const s = withSessions(t, hq);
  hq.hub.snap.setup = { ...hq.hub.snap.setup, sandboxReady: true };
  const ana = hq.hub.cfg("ana")!;
  ana.mode = "sandbox";
  Object.assign(s.sessions as unknown as Record<string, unknown>, { policyOk: true, sandboxExists: async () => false, whenSandboxExists: async () => false, refreshSandboxSizes: async () => {} });
  const asked: string[] = [];
  let identity = true;
  s.sessions.github = {
    deliver: async (id) => (asked.push(`deliver ${id}`), identity ? "issued" : "no-identity"),
    revoke: async (id, reason) => void asked.push(`revoke ${id} ${reason}`),
  };
  return { hq, ...s, asked, noIdentity: () => void (identity = false) };
}

test("a sandboxed agent's token is delivered before its sandbox starts, and revoked when it stops", async (t) => {
  const { hq, sessions, backend, name, asked } = await sandboxed(t);
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "running");
  assert.deepEqual(asked, ["deliver ana"]);
  assert.ok(backend.live.has(name("ana")));
  await sessions.stop("ana");
  assert.deepEqual(asked, ["deliver ana", "revoke ana stopped"]);
});

test("an agent with no GitHub identity starts, without a github key, and the activity says it cannot push", async (t) => {
  const { hq, sessions, noIdentity } = await sandboxed(t);
  noIdentity();
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "running");
  assert.ok(hq.hub.snap.activity.some((a) => /no GitHub identity/.test(a.text) && /can't push/.test(a.text)));
});

test("a reattached running agent gets a fresh token", async (t) => {
  const { hq, sessions, backend, name, asked } = await sandboxed(t);
  backend.live.add(name("ana")); // tmux kept it running while HQ was stopped
  await sessions.pollOnce();
  assert.equal(hq.hub.status("ana")?.session.state, "running");
  assert.deepEqual(asked, ["deliver ana"]);
});

test("a company-level agent is never given a token", async (t) => {
  const { hq, sessions, asked } = await sandboxed(t);
  hq.company.agents.setRole(hq.slug, "ana", "ceo", OWNER);
  await sessions.start("ana", OWNER);
  assert.equal(asked.filter((a) => a.startsWith("deliver")).length, 0);
});

test("an agent that has no sandbox gets no token", async (t) => {
  const { hq, sessions, asked } = await sandboxed(t);
  hq.hub.cfg("ana")!.mode = "local"; // Task 6 removes Local mode; this guards the code path
  await sessions.start("ana", OWNER);
  assert.equal(asked.filter((a) => a.startsWith("deliver")).length, 0);
});

// PR #12 review, round 1: Pause and Retire reach the revoke (SR-E-07), through the registry.
test("SR-E-07 [T-S3.11] pausing or retiring an agent revokes its token; another project's agent is not touched", async (t) => {
  const hq = await makeHq(t);
  const h = harness();
  const unwatch = revokeOnStatus(hq.company.agents, h.tokens, hq.slug);
  const other = revokeOnStatus(hq.company.agents, harness().tokens, "other-project");
  t.after(() => {
    unwatch();
    other();
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  for (const [agent, to] of [["ana", "paused"], ["ben", "retired"]] as const) {
    await h.tokens.deliver(agent, `${hq.slug}/${agent}`, "acme/site");
    const token = h.keys.at(-1)!.split(" ").at(-1)!;
    hq.company.agents.setStatus(hq.slug, agent, to, OWNER);
    await tick();
    await tick();
    const deletes = h.calls.filter((c) => c.method === "DELETE" && c.path === "/installation/token");
    assert.equal(deletes.at(-1)?.token, token, `${to}: that agent's token is revoked`);
    const row = h.rows.filter((r) => r.action === "github.token-revoked").at(-1);
    assert.deepEqual([row?.actorId, row?.data.reason], ["owner", to]);
  }
  assert.equal(h.calls.filter((c) => c.method === "DELETE").length, 2, "one revoke per change");
});

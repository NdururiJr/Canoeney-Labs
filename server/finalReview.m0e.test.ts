// Fixes from M0-E's final whole-branch review: each test reproduces one finding.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { makeCommands } from "./commands";
import { FakeClock } from "./company/clock";
import { Dashboard, type CommandCtx } from "./dashboard";
import type { GitHubApi } from "./github/api";
import { applyRepoGuard, checkRepo, desiredRulesets, mainProtection, type GuardAgent } from "./github/repoGuard";
import { AgentTokens, TokenError } from "./github/tokens";
import { hookCommand } from "./agentFiles";
import { makeHq, OWNER_PIN } from "./testing/hqFixture";
import { withSessions } from "./testing/sessionFixture";

const HOUR = 3_600_000;
const OWNER = { kind: "human", id: "owner" } as const;

/** Token broker over a fake GitHub; `gate()` holds the next sbx setKey until released. */
function broker(o: { identity?: boolean; setKeyFails?: boolean } = {}) {
  const clock = new FakeClock("2026-11-14T10:00:00.000Z");
  let n = 0;
  const issued: string[] = [];
  const revoked: string[] = [];
  const api: GitHubApi = {
    async request(method, _path, opts = {}) {
      if (method === "POST") {
        const token = `tok${++n}`;
        issued.push(token);
        return { status: 201, json: { token, expires_at: new Date(clock.now().getTime() + HOUR).toISOString() } as never };
      }
      if (method === "DELETE") revoked.push(opts.token!);
      return { status: 204, json: null };
    },
  };
  const keys: string[] = [];
  let hold: Promise<void> | null = null;
  let release = () => {};
  const sbx = {
    setKey: async (id: string, _s: string, v: string) => {
      if (hold) await hold;
      if (o.setKeyFails) throw new Error("sbx: error storing value " + v);
      keys.push(`set ${id} ${v}`);
    },
    removeKey: async (id: string) => void keys.push(`rm ${id}`),
  };
  const timers: { at: number; fn: () => void; off: boolean }[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const t = { at: clock.now().getTime() + ms, fn, off: false };
    timers.push(t);
    return () => void (t.off = true);
  };
  const tokens = new AgentTokens({
    apps: { has: () => o.identity !== false, installation: async () => (o.identity === false ? null : { id: 7, selection: "selected" as const }), jwtFor: () => "jwt" },
    api,
    sbx,
    clock,
    audit: { append: () => {} } as never,
    schedule,
  });
  const fireDue = () => {
    for (const t of timers.filter((x) => !x.off && x.at <= clock.now().getTime())) {
      t.off = true;
      t.fn();
    }
  };
  const gate = () => {
    hold = new Promise<void>((r) => (release = () => ((hold = null), r())));
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { tokens, clock, issued, revoked, keys, timers, fireDue, gate, release: () => release(), settle };
}

test("a revoke during a refresh's token write leaves no token alive and no refresh pending", async () => {
  const b = broker();
  await b.tokens.deliver("ana", "site/ana", "acme/site");
  b.gate();
  b.clock.advance(HOUR - 10 * 60_000);
  b.fireDue(); // the refresh issues tok2 and waits in setKey
  await b.settle();
  const stop = b.tokens.revoke("ana", "stopped", OWNER);
  b.release();
  await stop;
  await b.settle();
  assert.deepEqual([...b.revoked].sort(), [...b.issued].sort(), "every token issued was revoked");
  assert.equal(b.keys.at(-1), "rm ana", "the sandbox's key is gone last");
  b.clock.advance(3 * HOUR);
  b.fireDue();
  await b.settle();
  assert.equal(b.issued.length, 2, "no refresh after the stop");
});

test("HQ stopping during a first delivery revokes that token too", async () => {
  const b = broker();
  b.gate();
  const first = b.tokens.deliver("ana", "site/ana", "acme/site");
  await b.settle();
  const stop = b.tokens.revokeAll("hq-stopped");
  b.release();
  await Promise.all([first, stop]);
  await b.settle();
  assert.deepEqual(b.revoked, b.issued);
  assert.equal(b.keys.at(-1), "rm ana");
});

test("a token whose delivery to the sandbox fails is revoked, and the error is HQ's own words", async () => {
  const b = broker({ setKeyFails: true });
  await assert.rejects(b.tokens.deliver("ana", "site/ana", "acme/site"), (err: unknown) => err instanceof TokenError && !err.message.includes("tok1"));
  assert.deepEqual(b.revoked, ["tok1"]);
});

test("an agent with no GitHub identity loses any github key in its sandbox", async () => {
  const b = broker({ identity: false });
  assert.equal(await b.tokens.deliver("ana", "site/ana", "acme/site"), "no-identity");
  assert.deepEqual(b.keys, ["rm ana"]);
});

// ---------------------------------------------------------------- sessions

async function sandboxed(t: TestContext) {
  const hq = await makeHq(t);
  const s = withSessions(t, hq);
  const asked: string[] = [];
  let deliver: () => Promise<"issued" | "no-identity"> = async () => "issued";
  s.sessions.github = {
    deliver: async (id) => (asked.push(`deliver ${id}`), deliver()),
    revoke: async (id, reason) => void asked.push(`revoke ${id} ${reason}`),
  };
  return { hq, ...s, asked, setDeliver: (fn: typeof deliver) => (deliver = fn) };
}

test("a start that fails after the token was delivered revokes it", async (t) => {
  const { hq, sessions, backend, asked } = await sandboxed(t);
  backend.createThrows = true;
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.deepEqual(asked, ["deliver ana", "revoke ana stopped"]);
});

test("sbx's own error text never reaches the activity feed", async (t) => {
  const { hq, sessions, setDeliver } = await sandboxed(t);
  setDeliver(async () => {
    throw new Error("sbx: could not store ghs_secretvalue123");
  });
  await sessions.start("ana", OWNER);
  assert.equal(JSON.stringify(hq.hub.snap.activity).includes("ghs_secretvalue123"), false);
  assert.ok(hq.hub.snap.activity.some((a) => /couldn't get a GitHub token/.test(a.text)));
});

test("a paused agent reattached after an HQ restart gets no token", async (t) => {
  const { hq, sessions, backend, name, asked } = await sandboxed(t);
  hq.company.agents.setStatus(hq.slug, "ana", "paused", OWNER);
  backend.live.add(name("ana"));
  await sessions.pollOnce();
  assert.equal(asked.filter((a) => a.startsWith("deliver")).length, 0);
});

test("a status change made inside an outer transaction is still announced", async (t) => {
  const hq = await makeHq(t);
  const heard: string[] = [];
  hq.company.agents.onStatusChange((id, to) => void heard.push(`${id} ${to}`));
  hq.company.db.transaction(() => hq.company.agents.setStatus(hq.slug, "ana", "retired", OWNER), "immediate");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(heard, [`${hq.slug}/ana retired`]);
});

test("a github key for one agent's sandbox is refused too", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  const stub = () => new Proxy({} as Record<string, unknown>, { get: () => async () => {} }) as never;
  const d = new Dashboard(makeCommands(hq.hub, stub(), hq.planner, hq.inbox, stub(), stub(), hq.company), { ownerAuth: hq.ownerAuth, audit: hq.company.audit, clock: hq.clock });
  const ctx: CommandCtx = { actor: OWNER, role: "owner", remote: false, sessionId: "s1" };
  const r = await d.dispatch(ctx, { cmd: "setSecret", args: ["ana", "github", "ghp_" + "x".repeat(36)], pin: OWNER_PIN });
  assert.equal(r.ok, false);
  assert.match((r as { message?: string }).message ?? "", /own GitHub identity/);
  assert.equal(hq.company.settings.grants(`${hq.slug}/ana`, "secret-name").length, 0);
});

// ---------------------------------------------------------------- the hook

test("the hook reads its auth file inside the agent's folder, never a host path", () => {
  const cmd = hookCommand("http://host.docker.internal:7420", "ana", "Stop");
  assert.match(cmd, /-H @"\$\{CLAUDE_PROJECT_DIR:-\.\}\/\.claude\/hq-hook-auth"/);
  assert.equal(/[A-Z]:\\/.test(cmd), false);
});

// ---------------------------------------------------------------- the guard

const AGENTS: GuardAgent[] = [{ id: "ana", appId: 101, installed: true, selection: "selected" }];

function api(over: (path: string) => { status: number; json: unknown } | undefined, writes: { method: string; path: string; body?: unknown }[] = []): GitHubApi {
  const good: Record<string, unknown> = {
    "": { private: false, allow_auto_merge: false },
    "/branches/main/protection": mainProtection(),
    "/rulesets": desiredRulesets(AGENTS).map((r, i) => ({ id: i + 1, name: r.name })),
    "/actions/permissions": { enabled: true, allowed_actions: "selected" },
    "/actions/permissions/selected-actions": { github_owned_allowed: true, verified_allowed: false, patterns_allowed: [] },
    "/actions/permissions/workflow": { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
    "/actions/secrets": { total_count: 0 },
    "/actions/runners": { total_count: 0 },
    "/contents/.github/CODEOWNERS": {
      content: Buffer.from(["* @acme", ...["CLAUDE.md", "AGENTS.md", "ROLE.md", ".claude/", ".mcp.json", ".agents/", ".codex/", ".github/"].map((p) => `${p} @acme`)].join("\n")).toString("base64"),
    },
  };
  desiredRulesets(AGENTS).forEach((r, i) => (good[`/rulesets/${i + 1}`] = r));
  return {
    async request(method, path, o = {}) {
      const p = path.replace("/repos/acme/site", "");
      if (method !== "GET") {
        writes.push({ method, path: p, body: o.body });
        return { status: 200, json: {} as never };
      }
      const x = over(p);
      if (x) return x as never;
      return p in good ? { status: 200, json: good[p] as never } : { status: 404, json: null };
    },
  };
}

test("a read the guard cannot make is a named finding, never a false all-clear or a crash", async () => {
  const offline = await checkRepo(api(() => ({ status: 0, json: null })), "acme/site", { agents: AGENTS, spendingConfirmed: false });
  assert.ok(offline.length > 0);
  assert.ok(offline.every((f) => f.name.startsWith("read-failed:") && !f.fixable), offline.map((f) => f.name).join(","));
  const forbidden = await checkRepo(api((p) => (p === "/rulesets" ? { status: 403, json: { message: "Upgrade to GitHub Pro" } } : undefined)), "acme/site", { agents: AGENTS, spendingConfirmed: false });
  assert.deepEqual(forbidden.map((f) => f.name), ["read-failed:rulesets"]);
});

test("applying protection keeps the owner's own required checks and restrictions", async () => {
  const writes: { method: string; path: string; body?: unknown }[] = [];
  const prot = { ...mainProtection(), required_status_checks: { strict: true, checks: [{ context: "build", app_id: 15368 }] }, restrictions: { users: [{ login: "acme" }], teams: [], apps: [] } };
  await applyRepoGuard(api((p) => (p === "/branches/main/protection" ? { status: 200, json: prot } : undefined), writes), "acme/site", { agents: AGENTS, spendingConfirmed: false });
  const put = writes.find((w) => w.path === "/branches/main/protection")!.body as { required_status_checks: unknown; restrictions: unknown };
  assert.deepEqual(put.required_status_checks, { strict: true, checks: [{ context: "build", app_id: 15368 }] });
  assert.deepEqual(put.restrictions, { users: ["acme"], teams: [], apps: [] });
});

test("actions limited to the repo's own (local_only) are kept, not loosened", async () => {
  const writes: { method: string; path: string; body?: unknown }[] = [];
  const local = (p: string) => (p === "/actions/permissions" ? { status: 200, json: { enabled: true, allowed_actions: "local_only" } } : undefined);
  assert.deepEqual((await checkRepo(api(local), "acme/site", { agents: AGENTS, spendingConfirmed: false })).map((f) => f.name), []);
  await applyRepoGuard(api(local, writes), "acme/site", { agents: AGENTS, spendingConfirmed: false });
  assert.equal(writes.some((w) => w.path.startsWith("/actions/permissions") && w.path !== "/actions/permissions/workflow"), false);
});

test("tags are guarded: only the owner creates, moves or deletes them", async () => {
  const tags = desiredRulesets(AGENTS).find((r) => r.name === "hq-tags");
  assert.ok(tags);
  assert.equal(tags.target, "tag");
  assert.deepEqual(tags.conditions.ref_name.include, ["~ALL"]);
  assert.deepEqual(tags.rules.map((r) => r.type).sort(), ["creation", "deletion", "update"]);
  assert.deepEqual(tags.bypass_actors.map((b) => b.actor_type), ["RepositoryRole"]);
  const missing = await checkRepo(api((p) => (p === "/rulesets" ? { status: 200, json: desiredRulesets(AGENTS).map((r, i) => ({ id: i + 1, name: r.name })).filter((r) => r.name !== "hq-tags") } : undefined)), "acme/site", { agents: AGENTS, spendingConfirmed: false });
  assert.deepEqual(missing.map((f) => f.name), ["tags-ruleset-missing"]);
});

// The M0-B and M0-C carry-forward items that M0-D1 Task 4 closes.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { OfficeEvent } from "../src/data/source";
import { makeCommands } from "./commands";
import { Dashboard, type CommandCtx } from "./dashboard";
import { Sbx } from "./sbx";
import { makeHq, mcpCall } from "./testing/hqFixture";
import { withSessions } from "./testing/sessionFixture";

const REMOTE_OWNER: CommandCtx = { actor: { kind: "human", id: "owner" }, role: "owner", remote: true, sessionId: "s1" };

test("a refused folder is marked failed once, not on every poll", async (t) => {
  const hq = await makeHq(t);
  const { sessions, backend, name } = withSessions(t, hq);
  hq.hub.cfg("ana")!.workspacePath = join(hq.companyHomeDir, "inside");
  backend.live.add(name("ana"));
  let attached = 0;
  const attach = backend.attach.bind(backend) as (...a: unknown[]) => ReturnType<typeof backend.attach>;
  (backend as unknown as { attach: (...a: unknown[]) => unknown }).attach = (...args: unknown[]) => {
    if (args[0] === name("ana")) attached++;
    return attach(...args);
  };
  const failed: OfficeEvent[] = [];
  hq.hub.subscribe((e) => {
    if (e.type === "agent.updated" && e.agent.agentId === "ana" && e.agent.session.state === "failed") failed.push(e);
  });
  for (let i = 0; i < 3; i++) await sessions.pollOnce();
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.match(hq.hub.status("ana")?.session.detail ?? "", /company store/);
  assert.equal(failed.length, 1);
  assert.equal(attached, 0, "a refused folder is never attached");
});

test("stop during start leaves the agent stopped with no live secret", async (t) => {
  const hq = await makeHq(t);
  const { sessions } = withSessions(t, hq);
  const starting = sessions.start("ana");
  const stopping = sessions.stop("ana");
  await Promise.all([starting, stopping]);
  assert.equal(hq.hub.status("ana")?.session.state, "stopped");
  assert.equal(hq.company.secrets.hasLive(`${hq.slug}/ana`), false);
});

test("a paused agent's in-flight MCP request is refused", async (t) => {
  const hq = await makeHq(t);
  const secret = hq.secretFor("ana");
  // The request passes authentication, then the owner pauses the agent before the tool runs.
  const check = hq.auth.check.bind(hq.auth);
  hq.auth.check = (...args: Parameters<typeof check>) => {
    const r = check(...args);
    if (r.ok) hq.company.agents.setStatus(hq.slug, "ana", "paused", { kind: "human", id: "owner" });
    return r;
  };
  const r = await mcpCall(hq, secret, "send_message", { to: "lead", text: "still here" });
  assert.ok(r.json?.result?.isError || r.json?.error, r.text);
  assert.equal(hq.hub.snap.messages.some((m) => m.text === "still here"), false);
  const row = hq.company.audit.query({ action: "tool.called", limit: 1000 }).at(-1);
  assert.deepEqual([row?.data.outcome, row?.data.reason], ["refused", "paused"]);
});

test("authMcp is refused in a remote session", async (t) => {
  const hq = await makeHq(t);
  const stub = new Proxy({}, { get: () => async () => {} }) as never;
  const dashboard = new Dashboard(makeCommands(hq.hub, stub, hq.planner, hq.inbox, stub, stub, hq.company), { ownerAuth: hq.ownerAuth, audit: hq.company.audit, clock: hq.clock });
  assert.deepEqual(await dashboard.dispatch(REMOTE_OWNER, { cmd: "authMcp", args: ["arcjet"], pin: "000000" }), { ok: false, error: "remote" });
});

test("activity lines for sbx failures never repeat sbx's text", async (t) => {
  const hq = await makeHq(t);
  const MARK = "sbx-said-this";
  const exec = async (_cmd: string, args: string[]) => {
    if (args[0] === "ls") return { ok: true, code: 0, stdout: JSON.stringify(hq.hub.snap.config.team.map((a) => ({ name: `hq-${hq.slug}-${a.id}` }))), stderr: "" };
    if (args[0] === "policy" && args[1] === "allow") return { ok: false, code: 1, stdout: "", stderr: `${MARK}: bad host evil.example.com` };
    return { ok: true, code: 0, stdout: "[]", stderr: "" };
  };
  const sbx = new Sbx(hq.hub, hq.company, { exec });
  const approval = (id: string, host: string) => ({ id, host, protocol: "TCP", hostWide: true, detail: "", title: "" }) as never;
  sbx.state.agents.ana = { rules: [], keys: [], envFile: { path: "", exists: false }, syncError: null, ports: [], approvals: [approval("ap1", "evil.example.com")] };
  await sbx.answerApproval("ana", "ap1", "allow", { via: "pin", humanId: "owner" });
  sbx.state.agents.ana.approvals = [approval("ap2", "evil.example.com"), approval("ap3", "other.example.com")];
  await sbx.answerApproval("ana", "all", "allow", { via: "pin", humanId: "owner" });
  const texts = hq.hub.snap.activity.map((a) => a.text);
  assert.ok(texts.some((x) => /Couldn't allow/.test(x)), texts.join("\n"));
  assert.equal(texts.some((x) => x.includes(MARK) || x.includes("evil.example.com")), false, texts.join("\n"));
});

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { hook, makeHq, mcpCall, ORIGIN, type Hq } from "./testing/hqFixture";

const rows = (hq: Hq, action: string) => hq.company.audit.query({ action, limit: 1000 });

function wsStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("error", () => resolve(-1));
  });
}

test("SR-B-01 [T-S1.1] an X-HQ-Agent header naming another agent is refused", async (t) => {
  const hq = await makeHq(t);
  const task = hq.planner.createTask({ title: "Lead's secret plan" } as never, "lead");
  hq.planner.assign(task.id, "lead", "lead");
  const before = hq.hub.snap.tasks.length;
  const ana = hq.secretFor("ana");
  const r = await mcpCall(hq, ana, "create_task", { title: "x" }, { "x-hq-agent": "lead" });
  assert.equal(r.status, 401);
  assert.equal(hq.hub.snap.tasks.length, before);
  const mismatch = rows(hq, "agent.identity-mismatch");
  assert.equal(mismatch.length, 1);
  assert.equal(mismatch[0].actorId, `${hq.slug}/ana`);
  assert.equal(mismatch[0].data.claimed, "lead");
  const read = await mcpCall(hq, ana, "get_my_task", {}, { "x-hq-agent": "lead" });
  assert.equal(read.status, 401);
  assert.ok(!read.text.includes("secret plan"));
});

test("SR-B-01 [T-S1.1] a credential-shaped claimed id is refused and recorded safely", async (t) => {
  const hq = await makeHq(t);
  const ana = hq.secretFor("ana");
  const ghp = "ghp_" + "a".repeat(36);
  const sk = "sk-" + "b".repeat(24);
  assert.equal((await mcpCall(hq, ana, "get_my_task", {}, { "x-hq-agent": ghp })).status, 401);
  assert.equal((await hook(hq, ana, sk, "Stop")).status, 401);
  const mismatch = rows(hq, "agent.identity-mismatch");
  assert.equal(mismatch.length, 2);
  for (const m of mismatch) assert.deepEqual(m.data.claimed, { chars: m === mismatch[0] ? ghp.length : sk.length });
  const chain = JSON.stringify(hq.company.audit.query({ limit: 1000 }));
  assert.ok(!chain.includes(ghp) && !chain.includes(sk));
  assert.equal((await hook(hq, ana, "ana", "PostToolUse")).status, 204);
});

test("check refuses with 401 when the audit write throws", async (t) => {
  const hq = await makeHq(t);
  const ana = hq.secretFor("ana");
  const append = hq.company.audit.append.bind(hq.company.audit);
  hq.company.audit.append = () => {
    throw new Error("disk full");
  };
  const r = await hook(hq, ana, "ben", "Stop");
  hq.company.audit.append = append;
  assert.equal(r.status, 401);
  assert.equal(r.text, "unauthorized");
  assert.equal((await hook(hq, ana, "ana", "PostToolUse")).status, 204);
});

test("SR-B-02 [T-S2.1 T-S2.2 T-S2.3] a hook for B sent with A's secret has no effect", async (t) => {
  const hq = await makeHq(t);
  hq.inbox.push("ben", { fromId: "lead", text: "first private note", kind: "message" });
  hq.inbox.push("ben", { fromId: "lead", text: "second private note", kind: "message" });
  const status = JSON.stringify(hq.hub.status("ben"));
  const ana = hq.secretFor("ana");
  for (const event of ["Stop", "SessionStart", "Notification"]) {
    const r = await hook(hq, ana, "ben", event, { message: "hi" });
    assert.equal(r.status, 401, event);
    assert.ok(!r.text.includes("private note"));
  }
  assert.equal(hq.inbox.pending("ben"), 2);
  assert.equal(JSON.stringify(hq.hub.status("ben")), status);
  const mismatch = rows(hq, "agent.identity-mismatch");
  assert.equal(mismatch.length, 3);
  for (const m of mismatch) assert.equal(m.actorId, `${hq.slug}/ana`);
});

test("SR-B-03 [T-S1.1 T-S2.1] the old project token is refused and no agent-token file is created", async (t) => {
  const hq = await makeHq(t);
  const old = "0123456789abcdef".repeat(3);
  assert.equal((await hook(hq, old, "ana", "SessionStart")).status, 401);
  assert.equal((await mcpCall(hq, old, "get_my_task", {}, { "x-hq-agent": "ana" })).status, 401);
  hq.secretFor("ana"); // issuing a real secret writes no file under HQ's home either
  // The fixture's HQ_HOME is fresh: list every file under it and under the company home.
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) (e.isDirectory() ? walk : (p: string) => files.push(p))(join(dir, e.name));
  };
  walk(process.env.HQ_HOME!);
  walk(hq.companyHomeDir);
  assert.ok(process.env.HQ_HOME?.startsWith(hq.scratch), "HQ_HOME is the fixture's own");
  assert.deepEqual(files.filter((f) => basename(f) === "agent-token"), []);
});

test("SR-B-04 [T-S1.4] every failure gets the same response", async (t) => {
  const hq = await makeHq(t);
  hq.company.agents.ensureProject({ slug: "other", name: "other", root: join(tmpdir(), "no such other repo") });
  hq.company.agents.syncFromConfig("other", [{ id: "ana", name: "Ana", cli: "claude", isLead: true }]);
  const otherProject = hq.company.secrets.issue("other/ana");
  const revoked = hq.secretFor("ana");
  hq.rotate("ana");
  const variants: Record<string, string>[] = [
    {},
    { authorization: "Basic YW5hOnB3" },
    { authorization: `Bearer hqa_${"Z".repeat(43)}` },
    { authorization: `Bearer ${revoked}` },
    { authorization: "Bearer hqa_short" },
    { authorization: `Bearer ${otherProject}` },
  ];
  const seen = new Set<string>();
  for (const headers of variants) {
    const r = await hook(hq, null, "ana", "PostToolUse", {}, headers);
    const hs = [...r.headers.entries()].filter(([k]) => k !== "date");
    seen.add(JSON.stringify([r.status, hs, r.text]));
  }
  assert.equal(seen.size, 1, [...seen].join("\n"));
  assert.match([...seen][0], /^\[401,/);

  const fresh = await makeHq(t);
  for (let i = 0; i < 100; i++) await hook(fresh, null, "ana", "PostToolUse");
  assert.ok(rows(fresh, "auth.failed").length + rows(fresh, "auth.rate-limited").length <= 2);
  fresh.clock.advance(60_000);
  await hook(fresh, null, "ana", "PostToolUse");
  const failed = rows(fresh, "auth.failed");
  assert.equal(failed.length, 2);
  assert.equal(failed[1].data.suppressed, 99);
  assert.equal(failed[1].data.reason, "missing");
});

test("SR-B-06 [T-S1.3] a revoked secret is audited even after other failures", async (t) => {
  const hq = await makeHq(t);
  const old = hq.secretFor("ana");
  hq.rotate("ana");
  await hook(hq, null, "ana", "PostToolUse");
  await hook(hq, old, "ana", "PostToolUse");
  let failed = rows(hq, "auth.failed");
  assert.equal(failed.length, 2);
  assert.equal(failed[1].target, `${hq.slug}/ana`);
  assert.equal(failed[1].data.reason, "revoked");

  hq.clock.advance(60_000);
  for (let i = 0; i < 25; i++) await hook(hq, null, "ana", "PostToolUse");
  const r = await hook(hq, old, "ana", "PostToolUse");
  assert.equal(r.status, 429);
  failed = rows(hq, "auth.failed").filter((e) => e.target === `${hq.slug}/ana`);
  assert.equal(failed.length, 2);
});

test("SR-B-21 [T-S1.12 T-S2.6] a flood from one secret gets 429 and others still work", async (t) => {
  const hq = await makeHq(t);
  const ana = hq.secretFor("ana");
  const codes: number[] = [];
  for (let i = 0; i < 500; i++) codes.push((await hook(hq, ana, "ana", "PostToolUse")).status);
  assert.equal(codes.filter((c) => c === 204).length, 100);
  assert.equal(codes.filter((c) => c === 429).length, 400);
  assert.equal((await hook(hq, hq.secretFor("ben"), "ben", "PostToolUse")).status, 204);
  const limited = rows(hq, "auth.rate-limited");
  assert.equal(limited.length, 1);
  assert.equal(limited[0].target, `${hq.slug}/ana`);
});

test("SR-B-24 [T-S5.12] an agent secret opens no WebSocket", async (t) => {
  const hq = await makeHq(t);
  const ana = hq.secretFor("ana");
  const ws = hq.url.replace("http", "ws");
  const origin = ORIGIN;
  assert.equal(await wsStatus(`${ws}/ws?token=${ana}`, { origin }), 401);
  assert.equal(await wsStatus(`${ws}/ws`, { origin, authorization: `Bearer ${ana}` }), 401);
  assert.equal(await wsStatus(`${ws}/ws`, { origin, cookie: `hq_session=${ana}` }), 401);
  // A logged-in owner's session does open it (M0-C).
  assert.equal(await wsStatus(`${ws}/ws`, { origin, cookie: await hq.sessionCookie() }), 101);
});

test("a request HQ cannot parse gets 400 and HQ keeps serving", async (t) => {
  const hq = await makeHq(t);
  const { connect } = await import("node:net");
  const port = Number(new URL(hq.url).port);
  const reply = await new Promise<string>((resolve) => {
    const s = connect(port, "127.0.0.1", () => s.write("GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n"));
    let out = "";
    s.on("data", (d) => (out += d));
    s.on("end", () => resolve(out));
    s.on("error", () => resolve(out));
    setTimeout(() => (s.destroy(), resolve(out)), 2000);
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.equal((await hook(hq, hq.secretFor("ana"), "ana", "PostToolUse")).status, 204);
});

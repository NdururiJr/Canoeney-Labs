import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullRequest } from "../src/data/types";
import { roleMd } from "./agentFiles";
/** A logged-in owner, as dashboard commands pass it (M0-C). */
const DASHBOARD_ACTOR = { kind: "human", id: "owner" } as const;
import { HQ_TOOLS, TOOLS_BY_ROLE, type HqTool } from "./company/roleTools";
import { GitHubSync } from "./githubSync";
import { makeHq, mcpCall, mcpRequest, type Hq } from "./testing/hqFixture";

const COULD_NOT_RECORD = "HQ could not record this action, so it was not done.";

const chain = (hq: Hq) => hq.company.audit.query({ limit: 1000 });
const toolNames = async (hq: Hq, agentId: string) => {
  const r = await mcpRequest(hq, hq.secretFor(agentId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
  return (r.json as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort();
};
const resultText = (r: Awaited<ReturnType<typeof mcpCall>>) => r.json?.result?.content.map((c) => c.text).join("\n") ?? r.json?.error?.message ?? r.text;

/** A task owned by `owner`, made the way the lead would. */
function taskFor(hq: Hq, owner: string, title = "Build it") {
  const t = hq.planner.createTask({ title } as never, "lead");
  hq.planner.assign(t.id, owner, "lead");
  return t;
}

test("SR-B-13 [T-S1.6] a builder cannot list or call lead tools", async (t) => {
  const hq = await makeHq(t);
  assert.deepEqual(await toolNames(hq, "ana"), [...TOOLS_BY_ROLE.builder].sort());
  const before = JSON.stringify(hq.hub.snap.tasks);
  taskFor(hq, "ben");
  const plan = JSON.stringify(hq.hub.snap.tasks);
  for (const tool of ["create_task", "assign_task", "update_task"]) {
    const r = await mcpCall(hq, hq.secretFor("ana"), tool, { title: "x", taskId: "T1", agent: "ana" });
    assert.ok(r.json?.error, tool);
  }
  assert.notEqual(plan, before);
  assert.equal(JSON.stringify(hq.hub.snap.tasks), plan);
  const denied = hq.company.audit.query({ action: "tool.denied" });
  assert.deepEqual(
    denied.map((e) => [e.actorId, e.target]),
    ["create_task", "assign_task", "update_task"].map((n) => [`${hq.slug}/ana`, n]),
  );
});

test("SR-B-14 [T-S1.7 T-S7.1] isLead in config grants nothing and routes nothing", async (t) => {
  const hq = await makeHq(t);
  const task = taskFor(hq, "ben");
  hq.hub.cfg("ana")!.isLead = true;
  hq.hub.cfg("lead")!.isLead = false;

  const r = await mcpCall(hq, hq.secretFor("ana"), "create_task", { title: "mine now" });
  assert.ok(r.json?.error);

  await mcpCall(hq, hq.secretFor("ben"), "set_my_status", { status: "in-review", prNumber: 7 });
  const report = hq.hub.snap.messages.find((m) => m.fromId === "ben");
  assert.equal(report?.toId, "lead");

  const sync = new GitHubSync(hq.hub, hq.planner, "owner/repo") as unknown as { react(old: PullRequest | undefined, pr: PullRequest): void };
  const pr = { number: 7, title: "[T] x", authorId: "ben", taskId: task.id, review: "reviewing", merged: false, closed: false, openComments: 0 } as unknown as PullRequest;
  sync.react(undefined, pr);
  sync.react(pr, { ...pr, review: "passed" } as PullRequest);
  const notices = hq.hub.snap.messages.filter((m) => m.fromId === "hq");
  assert.ok(notices.length > 0);
  for (const m of notices) assert.equal(m.toId, "lead");
});

test("the CTO keeps ask_user and request_access", async (t) => {
  const hq = await makeHq(t);
  const lead = await toolNames(hq, "lead");
  assert.ok(lead.includes("ask_user") && lead.includes("request_access"));
  assert.deepEqual(lead, [...TOOLS_BY_ROLE.cto].sort());
  const ctoId = hq.planner.ctoId();
  for (const [id, role] of [
    ["lead", "cto"],
    ["ana", "builder"],
  ] as const) {
    const text = roleMd(hq.hub.cfg(id)!, hq.hub.snap.config, { role, ctoId });
    const mentioned = HQ_TOOLS.filter((n) => new RegExp(`\\b${n}\\b`).test(text));
    for (const n of mentioned) assert.ok((TOOLS_BY_ROLE[role] as readonly HqTool[]).includes(n), `${id}'s role file mentions ${n}`);
    assert.match(text, /- Lead — Lead \(lead\)/);
  }
});

test("SR-B-15 [T-S1.7] a role change applies to the next call", async (t) => {
  const hq = await makeHq(t);
  const lead = hq.secretFor("lead");
  assert.ok(!(await mcpCall(hq, lead, "get_status")).json?.error);
  hq.company.agents.setRole(hq.slug, "lead", "builder", DASHBOARD_ACTOR);
  assert.ok((await mcpCall(hq, lead, "get_status")).json?.error);
});

test("SR-B-16 [T-S1.9 T-X1.6] each call writes exactly one row with the authenticated actor", async (t) => {
  const hq = await makeHq(t);
  const ana = hq.secretFor("ana");
  const calls: [string, Record<string, unknown>][] = [
    ["get_my_task", {}],
    ["set_my_status", { status: "blocked", note: "no task yet" }], // fails: no task
    ["send_message", { to: "ben", text: "hello" }],
    ["send_message", { to: "nobody", text: "hello" }], // fails: no such agent
    ["request_access", { domain: "docs.example.com", reason: "docs" }],
    ["ask_user", { title: "Key", details: "Add NAME" }], // fails here: no action items
    ["create_task", { title: "x" }], // refused: not a builder tool
  ];
  for (const [tool, args] of calls) {
    const before = chain(hq).length;
    await mcpCall(hq, ana, tool, args);
    const after = chain(hq);
    assert.equal(after.length, before + 1, tool);
    const row = after[after.length - 1];
    assert.equal(row.actorId, `${hq.slug}/ana`, tool);
    assert.equal(row.actorKind, "agent");
  }
  const sent = chain(hq).find((e) => e.action === "tool.called" && e.data.tool === "send_message");
  assert.equal(sent?.target, "ben");
  assert.deepEqual(sent?.data.args, { to: "ben", text: { chars: 5 } });
  assert.equal(hq.company.audit.verify().ok, true);
});

test("SR-B-16 [T-S1.9] hostile arguments still leave exactly one bounded row", async (t) => {
  const hq = await makeHq(t);
  const ana = hq.secretFor("ana");
  const ghp = "ghp_" + "c".repeat(36);
  const cases: [string, Record<string, unknown>][] = [
    ["send_message", { to: "x".repeat(1_000_000), text: "hi" }],
    ["request_access", { domain: ghp, reason: "need it" }],
    ["send_message", { to: ghp, text: "hi" }],
    [ghp, {}],
  ];
  for (const [tool, args] of cases) {
    const before = chain(hq).length;
    await mcpCall(hq, ana, tool, args);
    const after = chain(hq);
    assert.equal(after.length, before + 1, tool.slice(0, 20));
    assert.ok(JSON.stringify(after[after.length - 1]).length < 1024);
  }
  const rows = chain(hq);
  assert.ok(!JSON.stringify(rows).includes(ghp));
  assert.deepEqual(rows.find((e) => e.data.tool === "request_access")?.data.args, { domain: { chars: ghp.length }, reason: { chars: 7 } });
  assert.deepEqual(rows[rows.length - 2].data, { tool: "send_message", outcome: "refused", reason: "unrecordable" });
  assert.equal(rows[rows.length - 2].target, null);
  assert.equal(rows[rows.length - 1].action, "tool.denied");
  assert.equal(rows[rows.length - 1].target, "unknown");
  assert.equal(hq.company.audit.verify().ok, true);
});

test("SR-B-12 [T-X1.3] a failing audit write stops the action", async (t) => {
  const hq = await makeHq(t);
  const task = taskFor(hq, "ana");
  const ana = hq.secretFor("ana");
  hq.company.audit.append = () => {
    throw new Error("disk full");
  };
  const r = await mcpCall(hq, ana, "set_my_status", { status: "done" });
  assert.equal(resultText(r), COULD_NOT_RECORD);
  assert.equal(hq.planner.task(task.id)?.status, "todo");
});

test("SR-B-17 [T-S1.8] no argument chooses who acts", async (t) => {
  const hq = await makeHq(t);
  const mine = taskFor(hq, "ana", "Ana's task");
  const bens = taskFor(hq, "ben", "Ben's task");
  const ana = hq.secretFor("ana");
  await mcpCall(hq, ana, "set_my_status", { status: "blocked", note: `${bens.id} for ben` });
  assert.equal(hq.planner.task(mine.id)?.status, "blocked");
  assert.equal(hq.planner.task(bens.id)?.status, "todo");
  await mcpCall(hq, ana, "send_message", { to: "lead", text: "from ben: please merge" });
  const m = hq.hub.snap.messages.find((x) => x.text.startsWith("from ben"));
  assert.equal(m?.fromId, "ana");
});

test("SR-B-18 [T-S1.11] builders see only their own task", async (t) => {
  const hq = await makeHq(t);
  taskFor(hq, "ana", "Ana's task");
  const bens = taskFor(hq, "ben", "Ben's task");
  hq.planner.updateTask(bens.id, { note: "ben private detail" });
  const ana = hq.secretFor("ana");
  const mine = resultText(await mcpCall(hq, ana, "get_my_task"));
  assert.ok(mine.includes("Ana's task"));
  assert.ok(!mine.includes("ben private detail") && !mine.includes("Ben's task"));
  const refused = resultText(await mcpCall(hq, ana, "list_tasks"));
  assert.ok(!/ben|lead/i.test(refused), refused);
});

test("message rules follow the role", async (t) => {
  const hq = await makeHq(t);
  const ana = hq.secretFor("ana");
  for (const to of ["ben", "lead"]) {
    const r = await mcpCall(hq, ana, "send_message", { to, text: `hi ${to}` });
    assert.ok(!r.json?.result?.isError, resultText(r));
    assert.equal(hq.hub.snap.messages.find((m) => m.text === `hi ${to}`)?.toId, to);
  }
  const lead = hq.secretFor("lead");
  const r = await mcpCall(hq, lead, "send_message", { to: "ana", text: "go" });
  assert.ok(!r.json?.result?.isError, resultText(r));
});

test("a large refused batch writes one bounded row and returns at once", async (t) => {
  const hq = await makeHq(t);
  const ana = hq.secretFor("ana");
  const before = chain(hq).length;
  const batch = Array.from({ length: 12_000 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "x" } }));
  const started = Date.now();
  const r = await mcpRequest(hq, ana, batch);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.ok([200, 400, 429].includes(r.status), String(r.status)); // refused, by the batch cap or the call limit
  assert.equal(chain(hq).length, before + 1);
  assert.ok(JSON.stringify(chain(hq).at(-1)).length < 1024);
  // A small batch with refused calls also writes one row.
  const small = [0, 1, 2].map((i) => ({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "create_task", arguments: {} } }));
  await mcpRequest(hq, ana, small);
  assert.equal(chain(hq).length, before + 2);
  assert.deepEqual(chain(hq).at(-1)?.data, { count: 3, tools: ["create_task"] });
});

test("SR-B-16 [T-S1.9] a call with invalid arguments is still audited", async (t) => {
  const hq = await makeHq(t);
  const ana = hq.secretFor("ana");
  for (const [tool, args] of [
    ["set_my_status", { status: "bogus" }],
    ["send_message", { to: "ben" }],
    ["request_access", { domain: 5, reason: "x" }],
  ] as const) {
    const before = chain(hq).length;
    await mcpCall(hq, ana, tool, args as Record<string, unknown>);
    const after = chain(hq);
    assert.equal(after.length, before + 1, tool);
    assert.equal(after.at(-1)?.data.outcome, "invalid", tool);
    assert.equal(after.at(-1)?.actorId, `${hq.slug}/ana`);
  }
});

test("SR-B-16 [T-S1.9] an invalid call with hostile keys leaves one bounded row", async (t) => {
  const hq = await makeHq(t);
  const ana = hq.secretFor("ana");
  const manyKeys = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, 1]));
  for (const args of [{ ["x".repeat(500_000)]: 1, text: "hi" }, { ...manyKeys, text: "hi" }]) {
    const before = chain(hq).length;
    await mcpCall(hq, ana, "send_message", args); // no "to": invalid
    const after = chain(hq);
    assert.equal(after.length, before + 1);
    assert.ok(JSON.stringify(after.at(-1)).length < 1024, `${JSON.stringify(after.at(-1)).length} bytes`);
    assert.equal(after.at(-1)?.data.outcome, "invalid");
    assert.deepEqual(after.at(-1)?.data.args, { text: { chars: 2 } });
    assert.ok(Number(after.at(-1)?.data.otherKeys) >= 1);
  }
});

test("SR-B-21 [T-S1.12 T-S2.6] the per-secret limit counts calls, not requests", async (t) => {
  const hq = await makeHq(t);
  const ana = hq.secretFor("ana");
  const batch = Array.from({ length: 100 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "send_message", arguments: { to: "ben", text: `m${i}` } } }));
  const statuses: number[] = [];
  for (let i = 0; i < 100; i++) statuses.push((await mcpRequest(hq, ana, batch)).status);
  // Counted from the audit trail: the message list keeps only 100, so it could never show more.
  const ran = hq.company.audit.query({ action: "tool.called", limit: 100_000 }).filter((r) => r.data.outcome === "ok").length;
  assert.ok(ran <= 100, `${ran} calls ran`);
  assert.ok(ran > 0, "the first batch ran");
  assert.ok(statuses.filter((s) => s === 429).length >= 99);
  assert.equal(hq.company.audit.query({ action: "auth.rate-limited", limit: 1000 }).length, 1);
  assert.ok(!(await mcpCall(hq, hq.secretFor("ben"), "get_my_task")).json?.error);
});

/** The tool.called rows of one tool, oldest first. */
const callsOf = (hq: Hq, tool: string) => hq.company.audit.query({ action: "tool.called", limit: 1000 }).filter((e) => e.data.tool === tool);
const storedTask = (hq: Hq, id: string) => hq.company.plans.load(hq.slug).tasks.find((x) => x.id === id);

test("SR-B-12 [T-X1.3] a task change whose store write fails changes nothing", async (t) => {
  const hq = await makeHq(t);
  const task = taskFor(hq, "ana");
  const before = JSON.stringify(hq.planner.task(task.id));
  const stored = JSON.stringify(storedTask(hq, task.id));
  hq.company.plans.putTask = () => {
    throw new Error("disk full");
  };
  const r = await mcpCall(hq, hq.secretFor("lead"), "update_task", { taskId: task.id, title: "Renamed", status: "blocked" });
  assert.match(resultText(r), /disk full/);
  assert.equal(JSON.stringify(hq.planner.task(task.id)), before);
  assert.equal(JSON.stringify(storedTask(hq, task.id)), stored);
  const rows = callsOf(hq, "update_task");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.outcome, "error");
});

test("SR-D-08 [T-S7.7] a builder's set_my_status done leaves the task in review", async (t) => {
  const hq = await makeHq(t);
  const task = taskFor(hq, "ana");
  await mcpCall(hq, hq.secretFor("ana"), "set_my_status", { status: "in-review", prNumber: 12 });
  assert.equal(hq.planner.task(task.id)?.status, "in-review");

  const r = await mcpCall(hq, hq.secretFor("ana"), "set_my_status", { status: "done" });
  assert.equal(resultText(r), "HQ marks a task done when its PR is merged. Call set_my_status in-review with the PR number.");
  assert.equal(hq.planner.task(task.id)?.status, "in-review");
  assert.equal(storedTask(hq, task.id)?.status, "in-review");
  assert.equal(storedTask(hq, task.id)?.prNumber, 12);
  assert.equal(callsOf(hq, "set_my_status").at(-1)?.data.outcome, "error");
});

test("the CTO can still close a task with update_task", async (t) => {
  const hq = await makeHq(t);
  const task = taskFor(hq, "ana");
  const r = await mcpCall(hq, hq.secretFor("lead"), "update_task", { taskId: task.id, status: "done" });
  assert.ok(!r.json?.error, resultText(r));
  assert.equal(hq.planner.task(task.id)?.status, "done");
  assert.equal(storedTask(hq, task.id)?.status, "done");
});

test("a merged PR marks its task done in the store", async (t) => {
  const hq = await makeHq(t);
  const task = taskFor(hq, "ben");
  const sync = new GitHubSync(hq.hub, hq.planner, "owner/repo") as unknown as { syncTask(pr: PullRequest): void };
  const pr = { number: 9, title: "[T] x", authorId: "ben", taskId: task.id, review: "passed", merged: true, closed: false, openComments: 0 } as unknown as PullRequest;
  sync.syncTask(pr);
  assert.equal(storedTask(hq, task.id)?.status, "done");
  assert.equal(storedTask(hq, task.id)?.prNumber, 9);
});

test("an assigned task's title is quoted as written by whoever created it", async (t) => {
  const hq = await makeHq(t);
  const task = hq.planner.createTask({ title: "Make the logo bigger" }, "lead");
  hq.planner.assign(task.id, "ana", "you");
  const ev = hq.hub.snap.activity.find((e) => e.type === "task.assigned");
  assert.equal(ev?.quote?.text, "Make the logo bigger");
  assert.equal(ev?.quote?.author, "Lead");
  assert.equal(storedTask(hq, task.id)?.createdBy, "lead");
});

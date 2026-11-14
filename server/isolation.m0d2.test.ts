// SR-D-09: each project sees only its own boards, tasks and messages, even
// when two projects have agents with the same id (M0-D2 Task 4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCommands } from "./commands";
import type { CommandCtx } from "./dashboard";
import { newAgent } from "./store";
import { hook, makeHq, mcpCall, mcpRequest, type Hq } from "./testing/hqFixture";

const TEAM = () => [newAgent("lead", "Lead", "Lead", "#ff77a8", true), newAgent("ana", "Ana", "Developer", "#29adff", false)];

/** Project X is the fixture's own; Y is a second project with the same agent ids. Y's task id exists only in Y. */
async function twoProjects(t: Parameters<typeof makeHq>[0], stops: string[] = []) {
  const hq = await makeHq(t, {
    team: TEAM(),
    extraProjects: [{ slug: "y", team: TEAM() }],
    // A dashboard stopAgent records which project's agent it reached.
    commands: ({ hub, planner, inbox, company }) =>
      makeCommands(hub, { stop: async (id: string) => void stops.push(`${hub.slug}/${id}`) } as never, planner, inbox, {} as never, {} as never, company),
  });
  const x = hq.runtime(hq.slug);
  const y = hq.runtime("y");
  x.planner.createTask({ title: "X task", boardId: x.planner.defaultBoard().id }, "lead");
  const yBoard = y.planner.createBoard("Y second board", "active");
  const yTask = y.planner.createTask({ title: "Y task", boardId: yBoard.id }, "lead");
  assert.equal(x.planner.task(yTask.id), undefined, "the Y task id does not exist in X");
  return { hq, x, y, yTask, secret: (slug: string, id: string) => hq.company.secrets.issue(`${slug}/${id}`) };
}

const planOf = (hq: Hq, slug: string) => JSON.stringify(hq.company.plans.load(slug));
const text = (r: Awaited<ReturnType<typeof mcpCall>>) => r.json?.result?.content[0]?.text ?? r.json?.error?.message ?? "";
const failed = (r: Awaited<ReturnType<typeof mcpCall>>) => r.json?.result?.isError === true || !!r.json?.error;

test("SR-D-09 [T-S7.8] a builder of project X calling the task tools with ids from project Y gets nothing and changes nothing", async (t) => {
  const { hq, x, yTask, secret } = await twoProjects(t);
  const yBefore = planOf(hq, "y");
  const xAna = secret(hq.slug, "ana");
  const xLead = secret(hq.slug, "lead");

  const mine = await mcpCall(hq, xAna, "get_my_task");
  assert.doesNotMatch(text(mine), /Y task/);
  assert.ok(failed(await mcpCall(hq, xAna, "set_my_status", { status: "in-review", prNumber: 7 })), "X's ana has no task: refused");

  assert.ok(failed(await mcpCall(hq, xLead, "update_task", { taskId: yTask.id, title: "hijacked" })));
  assert.ok(failed(await mcpCall(hq, xLead, "assign_task", { taskId: yTask.id, agent: "ana" })));
  const list = text(await mcpCall(hq, xLead, "list_tasks"));
  assert.match(list, /X task/);
  assert.doesNotMatch(list, /Y task/);

  const refusals = hq.company.audit.query({ action: "tool.called" }).filter((r) => r.data.outcome !== "ok");
  assert.equal(refusals.length, 3);
  for (const r of refusals) {
    assert.ok(r.actorId.startsWith(`${hq.slug}/`), `actor ${r.actorId} is X's agent`);
    assert.ok(r.data.outcome === "refused" || r.data.outcome === "error", String(r.data.outcome));
  }
  assert.equal(planOf(hq, "y"), yBefore);
  assert.equal(x.planner.task(yTask.id), undefined);

  // And the other way: Y's lead sees Y's tasks only.
  const yList = text(await mcpCall(hq, secret("y", "lead"), "list_tasks"));
  assert.match(yList, /Y task/);
  assert.doesNotMatch(yList, /X task/);
});

test("SR-D-09 [T-S7.8] same agent id in two projects: each message, hook and command reaches its own project's agent", async (t) => {
  const stops: string[] = [];
  const { hq, x, y, secret } = await twoProjects(t, stops);
  await hq.enroll();

  // A message from X's lead to "ana" reaches X's inbox only.
  const xBefore = x.hub.snap.messages.length;
  const yBefore = y.hub.snap.messages.length;
  const sent = await mcpCall(hq, secret(hq.slug, "lead"), "send_message", { to: "ana", text: "hello X ana" });
  assert.equal(failed(sent), false, text(sent));
  assert.equal(x.hub.snap.messages.length, xBefore + 1);
  assert.equal(y.hub.snap.messages.length, yBefore);

  // A hook carrying Y's ana secret changes Y's status only.
  const xAna = secret(hq.slug, "ana");
  const yAna = secret("y", "ana");
  assert.equal((await hook(hq, yAna, "ana", "UserPromptSubmit", { prompt: "Y work" })).status, 204);
  assert.equal(y.hub.status("ana")?.state, "working");
  assert.notEqual(x.hub.status("ana")?.state, "working");

  // Turn tracking is per project: Y's ana ending a turn does not make X's ana's hooks stale.
  await hook(hq, xAna, "ana", "UserPromptSubmit", { prompt: "X work" });
  await hook(hq, xAna, "ana", "PermissionRequest", { tool_name: "Bash" });
  assert.equal(x.hub.status("ana")?.state, "needs-input");
  await hook(hq, yAna, "ana", "Stop", {});
  await hook(hq, xAna, "ana", "PreToolUse", { tool_name: "Bash" });
  assert.equal(x.hub.status("ana")?.state, "working", "X's turn is still open");

  // A dashboard command with X selected reaches X's ana only.
  const ctx: CommandCtx = { actor: { kind: "human", id: "owner" }, role: "owner", remote: false, sessionId: "s1", projectId: hq.slug };
  assert.deepEqual(await hq.dashboard.dispatch(ctx, { cmd: "stopAgent", args: ["ana"] }), { ok: true });
  assert.deepEqual(stops, [`${hq.slug}/ana`]);
});

test("SR-D-09 [T-S7.8] a company-level role gets none of the project's task tools", async (t) => {
  const { hq } = await twoProjects(t);
  hq.company.agents.setRole(hq.slug, "ana", "ceo", { kind: "human", id: "owner" });
  const r = await mcpRequest(hq, hq.company.secrets.issue(`${hq.slug}/ana`), { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = ((r.json as { result?: { tools?: { name: string }[] } } | null)?.result?.tools ?? []).map((tool) => tool.name);
  for (const tool of ["list_tasks", "create_task", "update_task", "assign_task", "get_my_task", "set_my_status", "list_workers", "get_status", "create_board"]) {
    assert.equal(names.includes(tool), false, tool);
  }
});

test("only the CTO may close a task with set_my_status done", async (t) => {
  const { hq, x } = await twoProjects(t);
  const task = x.planner.createTask({ title: "QA check", boardId: x.planner.defaultBoard().id }, "lead");
  x.planner.assign(task.id, "ana", "lead");
  hq.company.agents.setRole(hq.slug, "ana", "qa", { kind: "human", id: "owner" });
  assert.throws(() => x.planner.setStatus("ana", "done"), (err: unknown) => (err as { code?: string }).code === "SELF_DONE");
  assert.notEqual(x.planner.task(task.id)?.status, "done");
});

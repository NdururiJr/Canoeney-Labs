// HQ's activity lines never carry an agent's words as HQ's own: what an agent
// wrote travels in `quote`, and the feed shows it labelled with its author
// (SR-C-13, threat model T-S10.3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionItems } from "./actionItems";
import { GitHubSync } from "./githubSync";
import { hook, makeHq, mcpCall } from "./testing/hqFixture";

test("SR-C-13 [T-S10.3] no tool argument or hook field reaches the HQ text of an activity line", async (t) => {
  const hq = await makeHq(t);
  hq.planner.actions = new ActionItems(hq.hub, hq.planner);
  const lead = hq.secretFor("lead");
  const ana = hq.secretFor("ana");
  const m = (n: string) => `mk${n}x`;
  const call = async (secret: string, tool: string, args: Record<string, unknown>) => {
    const r = await mcpCall(hq, secret, tool, args);
    assert.equal(r.status, 200, `${tool}: ${r.text}`);
    assert.ok(!r.json?.result?.isError, `${tool} failed: ${r.json?.result?.content?.[0]?.text}`);
    try {
      return JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
    } catch {
      return {}; // some tools answer in plain text
    }
  };

  await call(lead, "create_board", { title: m("board"), active: true });
  const task = await call(lead, "create_task", { title: m("title"), description: m("desc") });
  const taskId = String(task.id ?? task.taskId);
  await call(lead, "update_task", { taskId, title: m("retitle"), description: m("redesc") });
  await call(lead, "assign_task", { taskId, agent: "ana" });
  await call(ana, "set_my_status", { status: "blocked", note: m("note") });
  await call(ana, "send_message", { to: "lead", text: m("message") });
  await call(lead, "ask_user", { title: m("asktitle"), details: m("askdetails") });
  await call(lead, "request_access", { domain: `${m("domain")}.example.com`, reason: m("reason") });
  await hook(hq, ana, "ana", "PermissionRequest", { tool_name: m("tool") });
  await hook(hq, ana, "ana", "Notification", { message: m("notice") });
  // A PR title arrives from GitHub, written by an agent.
  const sync = new GitHubSync(hq.hub, hq.planner, null);
  const pr = { number: 7, title: m("prtitle"), taskId, authorId: "ana", review: "none", openComments: 0, mergeable: true, merged: false, openedAt: "x" };
  (sync as unknown as { react(old: unknown, pr: unknown): void }).react(undefined, pr);
  (sync as unknown as { react(old: unknown, pr: unknown): void }).react(pr, { ...pr, merged: true });

  const markers = ["prtitle", "board", "title", "desc", "retitle", "redesc", "note", "message", "asktitle", "askdetails", "domain", "reason", "tool", "notice"].map(m);
  for (const e of hq.hub.snap.activity) {
    for (const k of markers) assert.ok(!e.text.includes(k), `activity text holds agent words: ${e.text}`);
  }
  const quoted = hq.hub.snap.activity.filter((e) => e.quote).map((e) => e.quote!);
  for (const k of ["note", "message", "asktitle", "domain", "tool", "notice"].map(m)) {
    const q = quoted.find((x) => x.text.includes(k));
    assert.ok(q, `${k} is quoted`);
  }
  assert.equal(quoted.find((x) => x.text.includes(m("note")))?.author, "Ana");
  assert.equal(quoted.find((x) => x.text.includes(m("message")))?.author, "Ana");
  for (const s of hq.hub.snap.agents) {
    if (s.note && markers.some((k) => s.note!.includes(k))) assert.equal(s.noteIsAgentText, true, `${s.agentId}: ${s.note}`);
  }
});

test("a held note keeps its agent-text flag through an access request", async (t) => {
  const hq = await makeHq(t);
  const hub = hq.hub;
  hub.snap.accessRequests = [{ id: "R-1", agentId: "ana", domain: "x.example", reason: "r", at: "x", status: "pending" }];
  // While access is pending, an agent-written note is held, and HQ shows its own "Asking" note.
  hub.setStatus("ana", { state: "working", note: "agent words", noteIsAgentText: true });
  const asking = hub.status("ana")!;
  assert.match(asking.note ?? "", /^Asking: access to/);
  // The "Asking" note names the domain the agent chose, so it is flagged as a whole (SR-C-13).
  assert.equal(asking.noteIsAgentText, true);
  // Once answered, the held note comes back with its flag.
  hub.snap.accessRequests = [];
  hub.accessAnswered("ana");
  assert.equal(hub.status("ana")!.note, "agent words");
  assert.equal(hub.status("ana")!.noteIsAgentText, true);
});

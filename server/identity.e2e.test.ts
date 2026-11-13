import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { withSessions } from "./testing/sessionFixture";
import { hook, makeHq, mcpCall } from "./testing/hqFixture";

test("SR-B-10 [T-S1.10] the secret appears nowhere but the agent's own files", async (t) => {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original = methods.map((m) => console[m]);
  for (const m of methods) console[m] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  t.after(() => methods.forEach((m, i) => (console[m] = original[i])));

  const hq = await makeHq(t);
  const events: string[] = [];
  hq.hub.subscribe((e) => events.push(JSON.stringify(e)));
  const { sessions, fileSecret } = withSessions(t, hq);
  await sessions.start("ana");
  assert.equal(hq.hub.status("ana")?.session.state, "running");
  const secret = fileSecret("ana");

  const replies: string[] = [];
  replies.push((await hook(hq, secret, "ana", "SessionStart")).text);
  for (let i = 0; i < 10; i++) {
    const r = await mcpCall(hq, secret, i % 2 ? "get_my_task" : "send_message", { to: "ben", text: `update ${i}` });
    replies.push(r.text);
  }
  replies.push((await mcpCall(hq, secret, "create_task", { title: "not mine to make" })).text); // refused
  replies.push((await mcpCall(hq, secret, "set_my_status", { status: "done" })).text); // an error: no task
  replies.push((await hook(hq, secret, "ana", "Stop")).text);
  // Stopping the agent (its secret is revoked, its folder kept) must not print or emit the secret either.
  await sessions.stop("ana");
  assert.equal(hq.hub.status("ana")?.session.state, "stopped");

  const body = secret.slice("hqa_".length);
  const audit = JSON.stringify(hq.company.audit.query({ limit: 1000 }));
  const porcelain = execFileSync("git", ["status", "--porcelain", "--ignored=no"], { cwd: hq.hub.cfg("ana")!.workspacePath!, encoding: "utf8" });
  for (const [where, text] of [
    ["console", lines.join("\n")],
    ["dashboard events", events.join("\n")],
    ["audit trail", audit],
    ["replies and errors", replies.join("\n")],
    ["git status", porcelain],
  ] as const) {
    assert.ok(!text.includes(body), `the secret appears in the ${where}`);
  }
  assert.ok(!/hq-mcp\.json|settings\.local\.json/.test(porcelain), "HQ's files are git-excluded");
  assert.ok(audit.includes("tool.denied"));
});

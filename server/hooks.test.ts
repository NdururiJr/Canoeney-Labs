import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { OfficeEvent } from "../src/data/source";
import { cleanAgentText } from "./hooks";
import { hook, makeHq, mcpCall, type Hq } from "./testing/hqFixture";

// C0 and C1 control characters, DEL included.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const HOSTILE = "\u001b[31mred\u0007 <script>alert(1)</script> " + "x".repeat(10_000);

function capture(hq: Hq): OfficeEvent[] {
  const events: OfficeEvent[] = [];
  hq.hub.subscribe((e) => events.push(e));
  return events;
}

test("cleanAgentText strips control characters, collapses space and cuts", () => {
  assert.equal(cleanAgentText("a\u0000b\u009b c\n\t d"), "ab c d");
  assert.equal(cleanAgentText("\u001b[31mred\u001b[0m"), "red");
  const long = cleanAgentText("y".repeat(500), 64);
  assert.equal(long.length, 64);
  assert.ok(long.endsWith("…"));
  assert.equal(cleanAgentText(42), "");
  assert.equal(cleanAgentText({ a: 1 }), "");
});

test("SR-B-20 [T-S2.5] hook text is cut, cleaned and flagged", async (t) => {
  const hq = await makeHq(t);
  const events = capture(hq);
  const r = await hook(hq, hq.secretFor("ana"), "ana", "Notification", { message: HOSTILE });
  assert.equal(r.status, 204);
  const note = hq.hub.status("ana")!.note!;
  assert.ok(note.length <= 200);
  assert.ok(!CONTROL.test(note));
  const activity = events.find((e) => e.type === "activity") as Extract<OfficeEvent, { type: "activity" }>;
  assert.ok(activity && !CONTROL.test(activity.event.text));
  // The hook text travels as a labelled quote, cleaned too (M0-C, SR-C-13).
  assert.equal(activity.event.quote?.author, "Ana");
  assert.ok(activity.event.quote && !CONTROL.test(activity.event.quote.text) && activity.event.quote.text.length <= 200);
  const updated = events.filter((e) => e.type === "agent.updated") as Extract<OfficeEvent, { type: "agent.updated" }>[];
  assert.equal(updated[updated.length - 1].agent.noteIsAgentText, true);
});

test("SR-B-20 [T-S2.5] every payload string is cleaned", async (t) => {
  const hq = await makeHq(t);
  const ana = hq.secretFor("ana");
  const events = capture(hq);
  await hook(hq, ana, "ana", "UserPromptSubmit", { prompt: HOSTILE });
  let s = hq.hub.status("ana")!;
  assert.ok(!CONTROL.test(s.note!) && s.note!.length <= 200 && s.noteIsAgentText === true, "prompt");
  await hook(hq, ana, "ana", "Notification", { message: "ok" }); // leaves "working", so PreToolUse sets a note
  await hook(hq, ana, "ana", "PreToolUse", { tool_name: HOSTILE });
  s = hq.hub.status("ana")!;
  assert.ok(!CONTROL.test(s.note!) && s.note!.length <= 200 && s.noteIsAgentText === true, "PreToolUse");
  await hook(hq, ana, "ana", "PermissionRequest", { tool_name: HOSTILE });
  s = hq.hub.status("ana")!;
  assert.ok(!CONTROL.test(s.note!) && s.note!.length <= 200 && s.noteIsAgentText === true, "PermissionRequest");
  for (const e of events) if (e.type === "activity") assert.ok(!CONTROL.test(e.event.text));
  assert.equal((await hook(hq, ana, "ana", "PreToolUse", { tool_name: 42 })).status, 204);
  assert.equal((await hook(hq, ana, "ana", "PermissionRequest", { tool_name: { a: 1 } })).status, 204);
  // A note HQ writes itself is not agent text.
  await hook(hq, ana, "ana", "SessionStart");
  assert.equal(hq.hub.status("ana")!.noteIsAgentText, undefined);
});

test("SR-B-19 [T-S2.4] hook-reported state decides nothing", async (t) => {
  const hq = await makeHq(t);
  const ana = hq.secretFor("ana");
  const outcome = async () => {
    const allowed = await mcpCall(hq, ana, "get_my_task");
    const refused = await mcpCall(hq, ana, "create_task", { title: "x" });
    return JSON.stringify([allowed.status, !!allowed.json?.error, refused.status, !!refused.json?.error]);
  };
  hq.hub.setStatus("ana", { state: "working" });
  const working = await outcome();
  hq.hub.setStatus("ana", { state: "idle" });
  assert.equal(await outcome(), working);
  assert.equal(working, JSON.stringify([200, false, 200, true]));

  hq.inbox.push("ana", { fromId: "lead", text: "next thing", kind: "message" });
  await hook(hq, ana, "ana", "SessionStart");
  await hook(hq, ana, "ana", "Stop");
  await hook(hq, ana, "ana", "SessionEnd");
  const rows = hq.company.audit.query({ limit: 1000 }).filter((e) => e.action.startsWith("hook."));
  assert.deepEqual(
    rows.map((e) => [e.action, e.actorId, e.data]),
    [
      ["hook.SessionStart", `${hq.slug}/ana`, { bestEffort: true }],
      ["hook.Stop", `${hq.slug}/ana`, { bestEffort: true, delivered: 1 }],
      ["hook.SessionEnd", `${hq.slug}/ana`, { bestEffort: true }],
    ],
  );
});

test("SR-B-19 [T-S2.4] every read of hook-reported state is a display or delivery site", () => {
  // Hook-reported state (an agent's state and note, and when its last hook came) may time
  // deliveries and fill the display; it must never decide who may do what. A new read must
  // be added here on purpose, after checking it decides nothing.
  const ALLOWED = [
    "inbox.ts: lastHookAt(", // the inbox records when hooks arrive
    "inbox.ts: status(agentId)?.state", // delivery: type a message only into an idle agent
    "main.ts: lastHookAt", // wiring
    "main.ts: lastHookAt(",
    "sessions.ts: lastHookAt", // declaration
    "sessions.ts: lastHookAt(", // the quiet time before reading the agent's screen
  ];
  const server = dirname(fileURLToPath(import.meta.url));
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "testing") walk(p);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        for (const m of readFileSync(p, "utf8").matchAll(/lastHookAt\(?|status\([^)]*\)\??\.(?:state|note)\b/g)) found.add(`${relative(server, p).replace(/\\/g, "/")}: ${m[0]}`);
      }
    }
  };
  walk(server);
  assert.deepEqual([...found].sort(), [...ALLOWED].sort());
});

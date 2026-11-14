// M0-E Task 6: no secret value reaches a sandbox (D2, SR-E-13), no Local mode
// (SR-E-06), the merge setting (SR-E-08), and the remaining agent gates.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { makeCommands } from "./commands";
import { AuthorityError } from "./company/authority";
import { Dashboard, type CommandCtx } from "./dashboard";
import { mergeByNotice, passedNotice } from "./githubSync";
import { previewImport, readImport } from "./repoConfigImport";
import { newAgent } from "./store";
import { makeHq, mcpRequest, writeRepoFiles } from "./testing/hqFixture";
import { withSessions } from "./testing/sessionFixture";

const OWNER: CommandCtx = { actor: { kind: "human", id: "owner" }, role: "owner", remote: false, sessionId: "s1" };
const stub = () => new Proxy({} as Record<string, unknown>, { get: () => async () => {} }) as never;

test("SR-E-13 [T-S3.5] an agent started while its env file exists gets no --env-file", async (t) => {
  const hq = await makeHq(t);
  const s = withSessions(t, hq);
  const env = `${hq.scratch}/env/ana.env`;
  mkdirSync(dirname(env), { recursive: true });
  writeFileSync(env, "API_KEY=test-only-value\n");
  s.sessions.envFileFor = () => env;
  const specs: unknown[] = [];
  const create = s.backend.create.bind(s.backend);
  s.backend.create = async (name, cwd, spec, size) => (specs.push(spec), create(name, cwd, spec, size));
  await s.sessions.start("ana", { kind: "human", id: "owner" });
  assert.equal(hq.hub.status("ana")?.session.state, "running");
  const spec = JSON.stringify(specs[0]);
  assert.equal(spec.includes("env-file"), false, spec);
  assert.equal(spec.includes(env), false);
  assert.ok(hq.hub.snap.activity.some((a) => /app variables/i.test(a.text) && /not passed/i.test(a.text)));
});

test("SR-E-13 [T-S3.6] a message or answer to an agent that looks like a key is refused", async (t) => {
  const hq = await makeHq(t);
  const d = new Dashboard(makeCommands(hq.hub, stub(), hq.planner, hq.inbox, stub(), stub(), hq.company), { ownerAuth: hq.ownerAuth, audit: hq.company.audit, clock: hq.clock });
  const before = hq.hub.snap.messages.length;
  const key = "ghp_" + "a".repeat(36);
  const r1 = await d.dispatch(OWNER, { cmd: "sendMessage", args: ["ana", `use ${key}`] });
  const r2 = await d.dispatch(OWNER, { cmd: "resolveActionItem", args: ["A-1", "done", `the key is ${key}`] });
  for (const r of [r1, r2]) {
    assert.equal(r.ok, false);
    assert.match((r as { message?: string }).message ?? "", /looks like a key/);
  }
  assert.equal(hq.hub.snap.messages.length, before, "nothing was sent");
  const rows = hq.company.audit.query({ action: "message.refused" });
  assert.deepEqual(rows.map((r) => [r.actorId, r.data.reason]), [
    ["owner", "secret-shape"],
    ["owner", "secret-shape"],
  ]);
  assert.equal(JSON.stringify(hq.company.audit.query({})).includes(key), false);
});

test("SR-E-08 [T-S3.4] merge.by changes only with the PIN", async (t) => {
  const hq = await makeHq(t);
  const before = JSON.stringify(hq.company.settings.view(hq.slug, { path: "", hqPort: 0 }).workflow);
  const tries = [
    { by: { via: "session", humanId: "owner" } as const, reason: "pin-or-decision-required" },
    { by: { via: "hq" } as const, reason: "hq-cannot-grant" },
    { by: { via: "pin", humanId: "sup1" } as const, reason: "not-owner" },
  ];
  hq.company.db.prepare("INSERT INTO humans(id, display_name, role, created_at) VALUES ('sup1', 'Sam', 'supervisor', ?)").run("2026-11-14T00:00:00.000Z");
  for (const { by, reason } of tries) {
    assert.throws(() => hq.company.settings.updateWorkflow(hq.slug, { merge: { by: "lead" } }, by), (err: unknown) => err instanceof AuthorityError && err.reason === reason, reason);
  }
  assert.equal(JSON.stringify(hq.company.settings.view(hq.slug, { path: "", hqPort: 0 }).workflow), before);
  assert.equal(hq.company.audit.query({ action: "settings.refused" }).length, 3);
});

test("SR-E-08 [T-S3.4] no agent tool can change merge.by", async (t) => {
  const hq = await makeHq(t);
  for (const id of ["lead", "ana"]) {
    const list = await mcpRequest(hq, hq.secretFor(id), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = ((list.json as { result?: { tools?: { name: string }[] } }).result?.tools ?? []).map((x) => x.name);
    assert.equal(tools.some((n) => /workflow|merge|settings/i.test(n)), false, `${id}: ${tools.join(", ")}`);
  }
  const call = await mcpRequest(hq, hq.secretFor("lead"), { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update_workflow", arguments: { merge: { by: "lead" } } } });
  assert.deepEqual((call.json as { error?: { code: number; message: string } }).error, { code: -32601, message: "That tool is not available to your role." });
  // Refused before any tool runs and recorded as tool.denied (SR-B-13); a name that is not one of HQ's tools is "unknown".
  const row = hq.company.audit.query({ action: "tool.denied" }).at(-1);
  assert.equal(row?.actorId, `${hq.slug}/lead`);
  assert.deepEqual(row?.data.tools, ["unknown"]);
  assert.equal(hq.company.settings.view(hq.slug, { path: "", hqPort: 0 }).workflow.merge.by, "human");
});

test("SR-E-06 [T-S3.2] no agent is set to or started in Local mode", async (t) => {
  const hq = await makeHq(t);
  const PIN = { via: "pin", humanId: "owner" } as const;
  const rowBefore = JSON.stringify(hq.company.db.prepare("SELECT * FROM agent_settings WHERE agent_id = ?").get(`${hq.slug}/ana`));
  assert.throws(() => hq.company.settings.updateAgent(`${hq.slug}/ana`, { mode: "local" }, PIN), (err: unknown) => err instanceof AuthorityError && err.reason === "local-mode-forbidden");
  assert.throws(
    () => hq.company.settings.addAgent(hq.slug, { id: "cara", name: "Cara", cli: "claude", displayRole: "Dev", color: "#29adff", mode: "local", model: "" }, "builder", PIN),
    (err: unknown) => err instanceof AuthorityError && err.reason === "local-mode-forbidden",
  );
  assert.equal(JSON.stringify(hq.company.db.prepare("SELECT * FROM agent_settings WHERE agent_id = ?").get(`${hq.slug}/ana`)), rowBefore);
  assert.equal(hq.company.agents.get(hq.slug, "cara"), null);
  // An agent stored as local before this change is refused at start.
  hq.company.db.prepare("UPDATE agent_settings SET mode = 'local' WHERE agent_id = ?").run(`${hq.slug}/ana`);
  hq.hub.configChanged();
  const s = withSessions(t, hq, {}, { keepModes: true });
  await s.sessions.start("ana", { kind: "human", id: "owner" });
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.equal(s.backend.live.has(s.name("ana")), false);
  assert.deepEqual(hq.company.audit.query({ action: "workspace.refused" }).map((r) => [r.actorId, r.data.reason]), [["owner", "local-mode"]]);
});

test("the import turns a file's Local mode into Sandbox and says so", async (t) => {
  const hq = await makeHq(t, { unseeded: true });
  writeRepoFiles(hq.repoRoot, { config: { team: [{ id: "lead", name: "Lead", isLead: true, mode: "local" }] } });
  const { plan } = readImport(hq.repoRoot, hq.company, hq.slug);
  assert.equal(previewImport(plan).some((l) => /Local mode/.test(l.text)), false, "no step writes Local mode");
  assert.equal(plan.sandboxed, 1);
});

test("a company-level agent with an MCP server grant does not start", async (t) => {
  const hq = await makeHq(t);
  const s = withSessions(t, hq);
  hq.company.agents.setRole(hq.slug, "ana", "ceo", { kind: "human", id: "owner" });
  hq.hub.cfg("ana")!.mcp = ["notion"];
  await s.sessions.start("ana", { kind: "human", id: "owner" });
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.deepEqual(hq.company.audit.query({ action: "workspace.refused" }).map((r) => r.data.reason), ["mcp-server"]);
});

test("SR-E-15 [T-S3.7] a new agent's allow list is empty", () => {
  for (const lead of [true, false]) assert.deepEqual(newAgent("x", "X", "Dev", "#000000", lead).sandbox.allow, []);
});

test("a passed PR under merge.by lead asks the owner to merge, and never tells the lead to run gh pr merge", () => {
  const note = passedNotice({ number: 7, title: "Fix" }, "Ana", "lead");
  assert.equal(note.includes("gh pr merge"), false);
  assert.match(note, /owner/i);
  assert.equal(mergeByNotice("lead", [7]).includes("gh pr merge"), false);
});

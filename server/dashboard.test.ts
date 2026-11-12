import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCommands } from "./commands";
import { makeDashboardHq, OWNER_PIN, type DashboardHq } from "./testing/dashboardFixture";
import { ORIGIN, SUPERVISOR, wsStatus } from "./testing/hqFixture";

const MINUTE = 60_000;
const commandRows = (d: DashboardHq) => d.hq.company.audit.query({ action: "dashboard.command", limit: 10_000 });

/** Captures console output (HQ's log) while fn runs. */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ out: string; value: T }> {
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  let out = "";
  const grab = (...a: unknown[]) => (out += a.map(String).join(" ") + "\n");
  Object.assign(console, { log: grab, warn: grab, error: grab, info: grab });
  try {
    const value = await fn();
    return { out, value };
  } finally {
    Object.assign(console, original);
  }
}

/** Every command in the table, with arguments that make it do something harmless. */
function sampleArgs(d: DashboardHq): Record<string, unknown[]> {
  return {
    sendTerminalInput: ["ana", "x"],
    resizeTerminal: ["ana", 80, 24],
    openShell: ["ana"],
    closeShell: ["ana"],
    openHostShell: [d.hq.repoRoot, false],
    closeHostShell: [],
    forwardPort: ["ana", 3000],
    unforwardPort: ["ana", 3000],
    startAgent: ["ana"],
    stopAgent: ["ana"],
    openWorkspace: ["ana"],
    recreateSandbox: ["ana"],
    recheckSetup: [],
    runSetupFix: ["sbx"],
    assignTask: ["T-1", "ana"],
    sendMessage: ["ana", "hello"],
    addAgent: [{ name: "Cara", role: "Developer", mode: "sandbox" }],
    updateAgent: ["ana", { name: "Ana B" }],
    inspectWorkspace: ["ana"],
    removeAgent: ["ben", {}],
    updateSandbox: ["ana", { resources: { cpus: null, memoryGb: null } }],
    setSecret: ["ana", "github", "value-1"],
    removeSecret: ["ana", "github"],
    setProxy: [null],
    openEnvFile: ["ana"],
    refreshSbx: [],
    resolveActionItem: ["A-1", "done"],
    refreshMcp: [],
    addMcp: [{ name: "docs", url: "https://mcp.example" }],
    authMcp: ["docs"],
    removeMcp: ["docs"],
    setAgentMcp: ["ana", []],
    answerApproval: ["ana", "ap-1", "dismiss"],
    updateStack: [null],
    resolveAccess: ["R-1", "deny"],
    completeWelcome: [{}],
    updateWorkflow: [{}],
    updateProject: [{ name: "Fixture" }],
    createBoard: ["Board"],
    updateBoard: ["B-1", { title: "x" }],
  };
}

test("SR-C-04 [T-S5.2 T-S5.7] every command declares a role, and an undeclared command is refused", async (t) => {
  const d = await makeDashboardHq(t);
  const table = makeCommands(d.hq.hub, {} as never, d.hq.planner, d.hq.inbox, {} as never, {} as never, d.hq.company);
  for (const [name, spec] of Object.entries(table)) assert.ok(spec.role === "owner" || spec.role === "supervisor", `${name} has no role`);
  // The sample list covers the whole table, so later tests reach every command.
  assert.deepEqual(Object.keys(sampleArgs(d)).sort(), Object.keys(table).sort());
  const c = await d.connect();
  assert.deepEqual(await c.send("dropDatabase"), { ok: false, error: "unknown" });
  const row = commandRows(d).at(-1);
  assert.equal(row?.data.outcome, "refused");
  assert.equal(row?.data.reason, "unknown");
  assert.equal(row?.actorId, "owner");
  c.close();
});

test("SR-C-04 [T-S5.2 T-S5.7] a supervisor is refused every owner command, and audited", async (t) => {
  const d = await makeDashboardHq(t);
  const c = await d.connect("supervisor");
  const table = makeCommands(d.hq.hub, {} as never, d.hq.planner, d.hq.inbox, {} as never, {} as never, d.hq.company);
  const before = JSON.stringify(d.hq.hub.snap);
  const args = sampleArgs(d);
  let refused = 0;
  for (const [name, spec] of Object.entries(table)) {
    if (spec.role !== "owner") continue;
    assert.deepEqual(await c.send(name, args[name]), { ok: false, error: "forbidden" }, name);
    refused++;
  }
  assert.equal(JSON.stringify(d.hq.hub.snap), before);
  assert.equal(d.calls.length, 0);
  const rows = commandRows(d);
  assert.equal(rows.length, refused);
  for (const r of rows) {
    assert.equal(r.actorId, SUPERVISOR.id);
    assert.equal(r.data.reason, "forbidden");
  }
  assert.deepEqual(await c.send("stopAgent", ["ana"]), { ok: true });
  assert.ok(d.calls.some((x) => x.name === "sessions.stop"));
  c.close();
});

test("SR-C-05 [T-S5.6] a PIN confirms only the command it came with", async (t) => {
  const d = await makeDashboardHq(t);
  const c = await d.connect();
  assert.deepEqual(await c.send("setSecret", ["ana", "github", "v1"], OWNER_PIN), { ok: true });
  assert.deepEqual(await c.send("setProxy", ["http://proxy.example:8080"]), { ok: false, error: "pin-required" });
  assert.deepEqual(await c.send("setSecret", ["ana", "github", "v2"], "000000"), { ok: false, error: "pin-wrong" });
  assert.equal(d.calls.filter((x) => x.name === "sbx.setKey").length, 1);
  assert.equal(d.calls.filter((x) => x.name === "sbx.setProxy").length, 0);
  c.close();
});

test("SR-C-05 [T-S5.6] five wrong PINs lock the step, and the lock lifts", async (t) => {
  const d = await makeDashboardHq(t);
  const c = await d.connect();
  const { out } = await captureLog(async () => {
    for (let i = 0; i < 5; i++) assert.deepEqual(await c.send("setProxy", [null], "111111"), { ok: false, error: "pin-wrong" });
    assert.deepEqual(await c.send("setProxy", [null], OWNER_PIN), { ok: false, error: "pin-locked" });
    return true;
  });
  assert.equal(d.calls.length, 0);
  assert.equal(d.hq.company.audit.query({ action: "auth.pin-locked" }).length, 1);
  d.hq.clock.advance(15 * MINUTE);
  c.raw({ cmd: "noop" }); // keeps the session alive across the jump
  assert.deepEqual(await c.send("setProxy", [null], OWNER_PIN), { ok: true });
  const all = JSON.stringify(d.hq.company.audit.query({ limit: 10_000 })) + JSON.stringify(c.frames) + out;
  for (const pin of ["111111", OWNER_PIN]) assert.ok(!all.includes(pin), "a PIN was written down");
  c.close();
});

test("SR-C-06 [T-S5.8 T-S4.1] an owner-started permission change applies only with the owner's PIN", async (t) => {
  const d = await makeDashboardHq(t);
  const allow = () => d.hq.hub.cfg("ana")?.sandbox.allow ?? [];
  const before = [...allow()];
  const change = ["ana", { allow: [...before, "example.com"] }];
  // An agent secret never opens the socket.
  assert.equal(await wsStatus(d.hq, { origin: ORIGIN, authorization: `Bearer ${d.hq.secretFor("ana")}` }), 401);
  const sup = await d.connect("supervisor");
  assert.deepEqual(await sup.send("updateSandbox", change, OWNER_PIN), { ok: false, error: "forbidden" });
  const owner = await d.connect();
  assert.deepEqual(await owner.send("updateSandbox", change), { ok: false, error: "pin-required" });
  assert.deepEqual(allow(), before);
  const rowsBefore = commandRows(d).length;
  assert.deepEqual(await owner.send("updateSandbox", change, OWNER_PIN), { ok: true });
  assert.ok(allow().includes("example.com"));
  const added = commandRows(d).slice(rowsBefore);
  assert.equal(added.length, 1);
  assert.equal(added[0].actorKind, "human");
  assert.equal(added[0].actorId, "owner");
  assert.equal(added[0].data.outcome, "run");
  sup.close();
  owner.close();
});

test("SR-C-07 [T-S5.9] each command adds one row with the human's id, and verify() passes", async (t) => {
  const d = await makeDashboardHq(t);
  const c = await d.connect();
  const args = sampleArgs(d);
  // openEnvFile would open a text editor on this machine; it is covered by the role and local tests.
  const skip = new Set(["sendTerminalInput", "resizeTerminal", "openEnvFile"]);
  for (const name of Object.keys(args)) {
    if (skip.has(name)) continue;
    const before = commandRows(d).length;
    await c.send(name, args[name], OWNER_PIN);
    const added = commandRows(d).slice(before);
    assert.equal(added.length, 1, name);
    assert.equal(added[0].actorId, "owner", name);
    assert.equal(added[0].data.cmd, name);
  }
  // Rows a command writes itself name the human too, not a shared dashboard id.
  const registered = d.hq.company.audit.query({ action: "agent.registered" }).at(-1);
  assert.equal(registered?.actorId, "owner");
  assert.equal(d.hq.company.audit.verify().ok, true);
  c.close();
});

test("terminal input is audited once per agent per minute, without the text", async (t) => {
  const d = await makeDashboardHq(t);
  const c = await d.connect();
  for (let i = 0; i < 30; i++) await c.send("sendTerminalInput", ["ana", `secret-key-${i}`]);
  d.hq.clock.advance(MINUTE);
  await c.send("sendTerminalInput", ["ana", "z"]);
  const rows = d.hq.company.audit.query({ action: "dashboard.terminal" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.count, 30);
  assert.equal(rows[0].target, "ana");
  assert.ok(!JSON.stringify(d.hq.company.audit.query({ limit: 10_000 })).includes("secret-key-"));
  c.close();
});

test("SR-C-08 [T-S5.3] a remote session cannot use the host shell, the terminal or the sandbox shell", async (t) => {
  const d = await makeDashboardHq(t);
  const c = await d.connect("owner", { "x-forwarded-for": "100.64.0.7" });
  const args = sampleArgs(d);
  for (const name of ["openHostShell", "sendTerminalInput", "openShell"]) {
    assert.deepEqual(await c.send(name, args[name]), { ok: false, error: "remote" }, name);
  }
  assert.equal(d.calls.length, 0);
  const reasons = commandRows(d).map((r) => r.data.reason);
  assert.deepEqual(reasons, ["remote", "remote", "remote"]);
  c.close();
});

test("SR-C-17 [T-S5.10] a secret value goes to its store and nowhere else", async (t) => {
  const d = await makeDashboardHq(t);
  const marker = "sk-marker-0123456789abcdef";
  const c = await d.connect();
  const { out } = await captureLog(async () => {
    for (const fail of [false, true]) {
      d.failWith.text = fail ? `rejected ${marker} and http://user:${marker}@proxy.example:8080` : null;
      await c.send("setSecret", ["ana", "github", marker], OWNER_PIN);
      await c.send("setProxy", [`http://user:${marker}@proxy.example:8080`], OWNER_PIN);
      await c.send("addMcp", [{ name: `docs${fail ? "2" : "1"}`, url: "https://mcp.example", apiKey: marker }], OWNER_PIN);
    }
    await new Promise((r) => setTimeout(r, 100));
    return true;
  });
  // The values did reach their stores.
  assert.ok(d.calls.some((x) => x.name === "sbx.setKey" && x.args.includes(marker)));
  assert.ok(d.calls.some((x) => x.name === "run.sbx" && x.args.includes(`${marker}\n`)));
  const everywhere = [JSON.stringify(c.frames), JSON.stringify(d.hq.hub.snap.activity), JSON.stringify(d.hq.company.audit.query({ limit: 10_000 })), out].join("\n");
  assert.ok(!everywhere.includes(marker), "the secret value leaked");
  assert.ok(d.hq.hub.snap.activity.some((a) => a.text.includes("proxy.example:8080")));
  c.close();
});

test("SR-C-18 [T-S5.11] the socket limits message rate", async (t) => {
  const d = await makeDashboardHq(t);
  const c = await d.connect();
  const other = await d.connect();
  for (let i = 0; i < 300; i++) c.raw({ cmd: "refreshSbx", args: [], id: `r${i}` });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(d.calls.filter((x) => x.name === "sbx.refresh").length, 100);
  assert.equal(d.hq.company.audit.query({ action: "dashboard.rate-limited" }).length, 1);
  assert.deepEqual(await other.send("refreshSbx"), { ok: true });
  c.close();
  other.close();
});

test("a builder added from the dashboard reports to the current team's CTO", async (t) => {
  const d = await makeDashboardHq(t);
  // An earlier team's CTO, not in the current config, registered first.
  d.hq.company.db.prepare("UPDATE agents SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(`${d.hq.slug}/lead`);
  d.hq.company.agents.register(d.hq.slug, { id: "old-cto", name: "Old", cli: "claude" }, "cto", { kind: "hq", id: "hq" }, "import");
  d.hq.company.db.prepare("UPDATE agents SET created_at = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(`${d.hq.slug}/old-cto`);
  const c = await d.connect();
  assert.deepEqual(await c.send("addAgent", [{ name: "Dee", role: "Developer", mode: "sandbox" }], OWNER_PIN), { ok: true });
  assert.equal(d.hq.company.agents.get(d.hq.slug, "dee")?.managerId, `${d.hq.slug}/lead`);
  c.close();
});

test("SR-C-09 [T-S5.7] a supervisor's snapshot and event stream hold no owner-only data", async (t) => {
  const d = await makeDashboardHq(t);
  const MARK = "owner-only-marker";
  const hub = d.hq.hub;
  const ana = hub.cfg("ana")!;
  ana.sandbox.allow.push(`${MARK}.example`);
  ana.roleMd = MARK;
  ana.workspacePath = `/home/${MARK}`;
  ana.skills = [MARK];
  hub.snap.sbx = { ...hub.snap.sbx, proxy: MARK } as never;
  hub.snap.mcp = { servers: [], attached: { ana: [MARK] }, error: null, checkedAt: "x" } as never;
  hub.snap.accessRequests = [{ id: "R-1", agentId: "ana", domain: `${MARK}.example`, reason: "r", at: "x", status: "pending" } as never];
  hub.status("ana")!.session.workspace = `/home/${MARK}`;
  const sup = await d.connect("supervisor");
  const owner = await d.connect("owner");
  hub.emit({ type: "terminal.output", agentId: "ana", data: MARK });
  hub.emit({ type: "workspace.info", info: { agentId: "ana", path: MARK } as never });
  hub.emit({ type: "sbx.updated", sbx: hub.snap.sbx });
  hub.emit({ type: "mcp.updated", mcp: hub.snap.mcp! });
  hub.emit({ type: "setup.updated", setup: { ...hub.snap.setup, checks: [{ id: "x", label: MARK }] } as never });
  hub.emit({ type: "access.updated", request: hub.snap.accessRequests![0] });
  hub.emit({ type: "config.updated", config: hub.snap.config });
  hub.emit({ type: "agent.updated", agent: hub.status("ana")! });
  hub.activity("config", null, "a line both see");
  await new Promise((r) => setTimeout(r, 200));
  const supFrames = JSON.stringify(sup.frames);
  assert.ok(!supFrames.includes(MARK), "a supervisor received owner-only data");
  assert.ok(!sup.frames.some((f) => f.type === "terminal.output"));
  assert.ok(supFrames.includes("a line both see"));
  assert.ok(sup.frames.some((f) => f.type === "snapshot"));
  // The owner receives all of it.
  const ownerFrames = JSON.stringify(owner.frames);
  for (const type of ["terminal.output", "workspace.info", "sbx.updated", "mcp.updated", "setup.updated", "access.updated"]) {
    assert.ok(owner.frames.some((f) => f.type === type), type);
  }
  assert.ok(ownerFrames.includes(MARK));
  sup.close();
  owner.close();
});

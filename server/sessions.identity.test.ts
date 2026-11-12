import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CODEX_CONFIG } from "./adapters";
import { MCP_CONFIG } from "./agentFiles";
import type { SessionBackend } from "./backends/types";
/** A logged-in owner, as dashboard commands pass it (M0-C). */
const DASHBOARD_ACTOR = { kind: "human", id: "owner" } as const;
import { makeCommands } from "./commands";
import type { CommandCtx } from "./dashboard";

const OWNER_CTX: CommandCtx = { actor: { kind: "human", id: "owner" }, role: "owner", remote: false, sessionId: "s" };
import { Sessions } from "./sessions";
import { hook, makeHq, mcpCall, type Hq } from "./testing/hqFixture";
import { withSessions } from "./testing/sessionFixture";

const posix = process.platform !== "win32";
const SETTINGS = ".claude/settings.local.json";

const secretRows = (hq: Hq) => hq.company.db.prepare("SELECT * FROM agent_secrets ORDER BY id").all<Record<string, unknown>>();

test("SR-B-06 [T-S1.2 T-S1.3] a new session rotates the secret", async (t) => {
  const hq = await makeHq(t);
  const { sessions, fileSecret } = withSessions(t, hq);
  await sessions.start("ana");
  assert.equal(hq.hub.status("ana")?.session.state, "running", hq.hub.status("ana")?.session.detail ?? "");
  const old = fileSecret("ana");
  assert.equal((await mcpCall(hq, old, "get_my_task")).status, 200);
  await sessions.stop("ana");
  await sessions.start("ana");
  const fresh = fileSecret("ana");
  assert.notEqual(fresh, old);
  assert.equal((await mcpCall(hq, old, "get_my_task")).status, 401);
  assert.ok(hq.company.audit.query({ action: "auth.failed", limit: 1000 }).some((e) => e.target === `${hq.slug}/ana`));
  assert.equal((await mcpCall(hq, fresh, "get_my_task")).status, 200);
});

test("SR-B-07 [T-X3.6] reattaching to a live session issues no secret and writes no file", async (t) => {
  const hq = await makeHq(t);
  const { sessions, backend, name, fileSecret } = withSessions(t, hq);
  await sessions.start("ana");
  const secret = fileSecret("ana");
  // As after an HQ restart: the session still runs, HQ thinks it is stopped.
  hq.hub.setSession("ana", { state: "stopped" });
  const dir = hq.hub.cfg("ana")!.workspacePath!;
  const mtimes = () => [MCP_CONFIG, SETTINGS, ".jsmhq-role.md"].map((f) => statSync(join(dir, f)).mtimeMs);
  const before = { rows: JSON.stringify(secretRows(hq)), mtimes: mtimes() };
  assert.ok(backend.live.has(name("ana")));
  await sessions.start("ana");
  await sessions.pollOnce();
  assert.equal(hq.hub.status("ana")?.session.state, "running");
  assert.equal(JSON.stringify(secretRows(hq)), before.rows);
  assert.deepEqual(mtimes(), before.mtimes);
  assert.equal((await mcpCall(hq, secret, "get_my_task")).status, 200);
});

test("SR-B-08 [T-S1.3] a paused agent's secret stops at once and start is refused", async (t) => {
  const hq = await makeHq(t);
  const { sessions, fileSecret } = withSessions(t, hq);
  await sessions.start("ana");
  const secret = fileSecret("ana");
  await sessions.stop("ana");
  hq.company.agents.setStatus(hq.slug, "ana", "paused", DASHBOARD_ACTOR);
  assert.equal((await mcpCall(hq, secret, "get_my_task")).status, 401);
  assert.equal((await hook(hq, secret, "ana", "SessionStart")).status, 401);
  await sessions.start("ana");
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.match(hq.hub.status("ana")?.session.detail ?? "", /paused/);
});

test("stopping a session revokes its secret", async (t) => {
  const hq = await makeHq(t);
  const { sessions, backend, name, fileSecret } = withSessions(t, hq);
  await sessions.start("ana");
  const first = fileSecret("ana");
  await sessions.stop("ana");
  assert.equal((await mcpCall(hq, first, "get_my_task")).status, 401);
  assert.ok(hq.company.audit.query({ action: "auth.failed", limit: 1000 }).some((e) => e.data.reason === "revoked"));
  await sessions.start("ana");
  const second = fileSecret("ana");
  backend.dead.add(name("ana")); // the agent's process exited; HQ closes the session
  await sessions.pollOnce();
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.equal((await mcpCall(hq, second, "get_my_task")).status, 401);
});

test("a session that looks gone for one tick keeps its secret", async (t) => {
  const hq = await makeHq(t);
  const { sessions, backend, name, fileSecret } = withSessions(t, hq);
  await sessions.start("ana");
  const secret = fileSecret("ana");
  backend.goneOnce.add(name("ana"));
  await sessions.pollOnce();
  await sessions.pollOnce();
  assert.equal(hq.hub.status("ana")?.session.state, "running");
  assert.equal((await mcpCall(hq, secret, "get_my_task")).status, 200);
  assert.ok(!hq.hub.snap.activity.some((a) => a.text.includes("old HQ key")));
});

test("a failed start leaves no live secret", async (t) => {
  const hq = await makeHq(t);
  const { sessions, backend, fileSecret } = withSessions(t, hq);
  backend.createThrows = true;
  await sessions.start("ana");
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.equal(hq.company.secrets.hasLive(`${hq.slug}/ana`), false);
  assert.equal((await mcpCall(hq, fileSecret("ana"), "get_my_task")).status, 401);
});

test("a start that reattaches and then fails keeps the running agent's secret", async (t) => {
  const hq = await makeHq(t);
  const { sessions, backend, fileSecret } = withSessions(t, hq);
  await sessions.start("ana");
  const secret = fileSecret("ana");
  // HQ restarts: a new Sessions finds ana's session still running, and attaching to it fails.
  hq.hub.setSession("ana", { state: "stopped" });
  const restarted = new Sessions(hq.hub, hq.company);
  (restarted as unknown as { backend: SessionBackend }).backend = backend;
  t.after(() => restarted.shutdown());
  backend.attachThrows = true;
  await restarted.start("ana");
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.equal((await mcpCall(hq, secret, "get_my_task")).status, 200);
});

test("SR-B-22 [T-S7.6] one refused workspace does not stop the poll", async (t) => {
  const hq = await makeHq(t);
  const { sessions, backend, name } = withSessions(t, hq);
  hq.hub.cfg("ana")!.workspacePath = join(hq.companyHomeDir, "inside");
  backend.live.add(name("ana"));
  backend.live.add(name("ben"));
  await sessions.pollOnce();
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.match(hq.hub.status("ana")?.session.detail ?? "", /company store/);
  assert.equal(hq.hub.status("ben")?.session.state, "running");
});

test("SR-B-23 [T-S1.10] secret files are 0600, never written through a link, and git-excluded", async (t) => {
  const hq = await makeHq(t);
  const { sessions } = withSessions(t, hq);
  const dir = hq.hub.cfg("ana")!.workspacePath!;
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, SETTINGS), "{}\n", { mode: 0o644 });
  if (posix) chmodSync(join(dir, SETTINGS), 0o644);
  const outside = join(hq.scratch, "outside.json");
  writeFileSync(outside, "untouched");
  if (posix) symlinkSync(outside, join(dir, MCP_CONFIG));
  await sessions.start("ana");
  assert.equal(readFileSync(outside, "utf8"), "untouched");
  assert.ok(!lstatSync(join(dir, MCP_CONFIG)).isSymbolicLink());
  if (posix) {
    assert.equal(statSync(join(dir, MCP_CONFIG)).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, SETTINGS)).mode & 0o777, 0o600);
  }
  const ignored = execFileSync("git", ["check-ignore", MCP_CONFIG, SETTINGS], { cwd: dir, encoding: "utf8" });
  assert.deepEqual(ignored.trim().split(/\r?\n/), [MCP_CONFIG, SETTINGS]);
  const mcp = readFileSync(join(dir, MCP_CONFIG), "utf8");
  assert.ok(!/X-HQ-Agent/i.test(mcp));
});

test("SR-B-23 [T-S1.10] codex config holds the secret, no agent header, mode 0600", async (t) => {
  const hq = await makeHq(t);
  const { sessions } = withSessions(t, hq, { ben: "codex" });
  await sessions.start("ben");
  const dir = hq.hub.cfg("ben")!.workspacePath!;
  const toml = readFileSync(join(dir, CODEX_CONFIG), "utf8");
  const secret = /Bearer (hqa_[A-Za-z0-9_-]{43})/.exec(toml)?.[1];
  assert.ok(secret, "codex config has an HQ secret");
  assert.ok(!/X-HQ-Agent/i.test(toml));
  if (posix) assert.equal(statSync(join(dir, CODEX_CONFIG)).mode & 0o777, 0o600);
  assert.equal((await mcpCall(hq, secret!, "get_my_task")).status, 200);
});

test("a new agent never reuses a retired agent's id", async (t) => {
  const hq = await makeHq(t);
  const { sessions } = withSessions(t, hq);
  const stub = { forget() {}, refresh: async () => {} } as never;
  const commands = makeCommands(hq.hub, sessions, hq.planner, hq.inbox, stub, stub, hq.company);
  commands.addAgent.run(OWNER_CTX, { name: "Cara", mode: "local" });
  assert.equal(hq.company.agents.get(hq.slug, "cara")?.role, "builder");
  await commands.removeAgent.run(OWNER_CTX, "cara", { deleteSandbox: false, deleteFolder: false });
  assert.equal(hq.company.agents.get(hq.slug, "cara")?.status, "retired");
  commands.addAgent.run(OWNER_CTX, { name: "Cara", mode: "local" });
  assert.ok(hq.hub.cfg("cara-2"));
  assert.equal(hq.company.agents.get(hq.slug, "cara-2")?.status, "active");
});

test("a reattached agent with no live secret gets a restart notice", async (t) => {
  const hq = await makeHq(t);
  const { sessions, backend, name } = withSessions(t, hq);
  backend.live.add(name("ana")); // started by an HQ from before M0-B
  await sessions.pollOnce();
  assert.equal(hq.hub.status("ana")?.session.state, "running");
  const notices = hq.hub.snap.activity.filter((a) => a.text.includes("old HQ key"));
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /Restart Ana once/);
});

test("completing the welcome screen again keeps the earlier team usable", async (t) => {
  const hq = await makeHq(t);
  const { sessions } = withSessions(t, hq);
  const stub = { forget() {}, refresh: async () => {} } as never;
  (sessions as unknown as { recheckSetup: () => Promise<void> }).recheckSetup = async () => {};
  const commands = makeCommands(hq.hub, sessions, hq.planner, hq.inbox, stub, stub, hq.company);
  const oldTeam = hq.hub.snap.config.team;
  // A checkout without .jsmhq/config.json: the welcome screen shows, and a team is made.
  hq.hub.snap.welcome = true;
  await commands.completeWelcome.run(OWNER_CTX, { lead: { name: "Lead" }, workers: [{ name: "Ana", role: "Developer" }] });
  assert.deepEqual(hq.hub.snap.config.team.map((a) => a.id), ["lead-2", "ana-2"]);
  assert.equal(hq.planner.ctoId(), "lead-2");
  assert.equal(hq.company.agents.get(hq.slug, "lead-2")?.role, "cto");
  // Back on the branch with the committed config: the earlier team still works.
  hq.hub.snap.config.team = oldTeam;
  hq.hub.snap.agents = oldTeam.map((a) => ({ ...hq.hub.status("lead-2")!, agentId: a.id, session: { state: "stopped", detail: null, workspace: null, sandbox: null } }));
  for (const id of ["lead", "ana", "ben"]) assert.equal(hq.company.agents.get(hq.slug, id)?.status, "active", id);
  assert.equal(hq.planner.ctoId(), "lead");
  await sessions.start("ana");
  assert.equal(hq.hub.status("ana")?.session.state, "running", hq.hub.status("ana")?.session.detail ?? "");
});

// M0-E Task 7: the hook secret leaves the command line (PR #2 review), and a
// secret is never readable while it is written (M0-B final review).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { codexConfig } from "./adapters";
import { HOOK_AUTH, hookCommand, writeClaudeFiles } from "./agentFiles";
import { HQ_OWN_FILES } from "./agentIsolation";
import { agentWrite } from "./lib/agentFs";
import { newAgent } from "./store";
import { makeHq } from "./testing/hqFixture";

const SECRET = "hqa_" + "S".repeat(43);

function folder(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "hq agent files "));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const cfg = { project: { id: "site", name: "Site", repo: "acme/site", hqPort: 7420 }, team: [], workflow: { review: { enabled: true, tool: "human", command: "" }, merge: { by: "human" }, deploy: { enabled: false, tool: "instacloud", command: "", perAgentEnvironments: false } } } as never;
const extras = { role: "builder" as const, ctoId: null };

test("no hook command holds the agent's secret", (t) => {
  const dir = folder(t);
  const agent = newAgent("ana", "Ana", "Developer", "#000000", false);
  writeClaudeFiles(dir, agent, cfg, SECRET, extras);
  const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  const commands = Object.values(settings.hooks).flatMap((entries) => entries.flatMap((e) => e.hooks.map((h) => h.command)));
  assert.ok(commands.length >= 7);
  for (const c of commands) assert.equal(c.includes(SECRET), false, c);
  // Resolved inside the sandbox, never a host path (final review).
  assert.ok(commands.some((c) => c.includes('-H @"${CLAUDE_PROJECT_DIR:-.}/' + HOOK_AUTH + '"')));
  assert.equal(readFileSync(join(dir, HOOK_AUTH), "utf8"), `Authorization: Bearer ${SECRET}\n`);
  // Codex: its hook lines read the same file. (Its MCP header holds the secret, in a 0600 file.)
  const toml = codexConfig(agent, cfg, SECRET, dir, extras);
  for (const line of toml.split("\n").filter((l) => l.startsWith("command ="))) assert.equal(line.includes(SECRET), false, line);
  assert.ok(HQ_OWN_FILES.includes(HOOK_AUTH), "a repo that commits the auth file is refused");
  assert.match(readFileSync(join(dir, ".git", "info", "exclude"), "utf8"), new RegExp(HOOK_AUTH.replace(/\./g, "\\.")));
});

test("the auth file is owner-only", { skip: process.platform === "win32" && "file modes are POSIX" }, (t) => {
  const dir = folder(t);
  writeClaudeFiles(dir, newAgent("ana", "Ana", "Developer", "#000000", false), cfg, SECRET, extras);
  assert.equal(statSync(join(dir, HOOK_AUTH)).mode & 0o777, 0o600);
});

test("a hook reaches HQ with the secret read from its file", async (t) => {
  const has = (cmd: string) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
  if (!has("sh") || !has("curl")) return t.skip("needs sh and curl");
  const hq = await makeHq(t);
  const dir = folder(t);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, HOOK_AUTH), `Authorization: Bearer ${hq.secretFor("ana")}\n`);
  const cmd = hookCommand(hq.url, "ana", "SessionStart");
  assert.equal(cmd.includes(hq.secretFor("ana")), false);
  // Claude Code sets CLAUDE_PROJECT_DIR to the agent's folder when it runs a hook.
  const r = spawnSync("sh", ["-c", cmd], { input: "{}", encoding: "utf8", timeout: 20_000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.equal(r.status, 0, r.stderr);
  for (let i = 0; i < 50 && hq.hub.status("ana")?.note !== "Ready"; i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(hq.hub.status("ana")?.note, "Ready", "HQ took the hook as ana's");
});

test("rewriting a 0644 file with a secret never leaves it readable", { skip: process.platform === "win32" && "file modes are POSIX" }, (t) => {
  const dir = folder(t);
  writeFileSync(join(dir, "secret.json"), "old", { mode: 0o644 });
  const before = statSync(join(dir, "secret.json")).ino;
  agentWrite(dir, "secret.json", SECRET, { mode: 0o600 });
  const after = statSync(join(dir, "secret.json"));
  assert.equal(after.mode & 0o777, 0o600);
  assert.notEqual(after.ino, before, "written to a new 0600 file, then renamed over the old one");
  assert.equal(readFileSync(join(dir, "secret.json"), "utf8"), SECRET);
});

test("a write with a mode goes through a fresh file and a rename", (t) => {
  const dir = folder(t);
  writeFileSync(join(dir, "secret.json"), "old");
  agentWrite(dir, "secret.json", SECRET, { mode: 0o600 });
  assert.equal(readFileSync(join(dir, "secret.json"), "utf8"), SECRET);
  assert.deepEqual(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }).split("\n").filter((l) => /hq-tmp/.test(l)),
    [],
    "no temporary file is left behind",
  );
});

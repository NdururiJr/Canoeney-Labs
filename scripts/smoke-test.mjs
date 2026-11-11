// Installs a packed jsm-hq tarball into an empty folder like a new user would,
// then checks the parts that differ by OS: the terminal library loads and can
// spawn, and HQ starts on a fresh repo and serves the page and a snapshot.
// HQ's company store goes to a folder inside this run's temp folder
// (HQ_COMPANY_HOME), never to the real ~/.jsmhq/_company.
//
//   node scripts/smoke-test.mjs <path/to/package.tgz> [port]

import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tarball = resolve(process.argv[2] ?? "");
const port = Number(process.argv[3] ?? 7431);
const win = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "jsmhq-smoke-"));
const app = join(work, "app");
const repo = join(work, "jsmhq-smoke-repo"); // also HQ's project id → ~/.jsmhq/jsmhq-smoke-repo
const companyHome = join(work, "company home"); // a space on purpose
const hqEnv = { ...process.env, HQ_COMPANY_HOME: companyHome };
let hq = null;

// No shell: arguments reach the program as they are, spaces and all.
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8" });
// On Windows npm is npm.cmd, which only runs through cmd.exe, and cmd.exe
// splits on spaces: quote every argument (Windows paths cannot contain ").
const npm = (args, cwd) =>
  win
    ? execSync(["npm", ...args.map((a) => `"${a}"`)].join(" "), { cwd, stdio: "pipe", encoding: "utf8" })
    : sh("npm", args, cwd);
const step = (msg) => console.log(`• ${msg}`);
function fail(msg) {
  console.error(`✗ ${msg}`);
  cleanup();
  process.exit(1);
}
function cleanup() {
  if (hq && hq.exitCode === null) {
    if (win) spawnSyncKill(hq.pid);
    else hq.kill("SIGTERM");
  }
  try {
    rmSync(join(homedir(), ".jsmhq", "jsmhq-smoke-repo"), { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a file; the runner is thrown away anyway */
  }
}
function spawnSyncKill(pid) {
  try {
    execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

// 1. Install the tarball into an empty folder.
step(`installing ${tarball}`);
mkdirSync(app);
writeFileSync(join(app, "package.json"), '{ "name": "smoke", "private": true }\n');
try {
  npm(["install", "--no-audit", "--no-fund", tarball], app);
} catch (e) {
  fail(`npm install failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
}
const pkgRoot = join(app, "node_modules", "@therealjsmastery", "jsm-hq");
const bin = join(pkgRoot, "bin", "jsm-hq.mjs");
step(`version ${sh(process.execPath, [bin, "--version"]).trim()}`);

// 2. The terminal library loads its prebuilt binary and can spawn a process.
const req = createRequire(join(pkgRoot, "package.json"));
const pty = req("@lydell/node-pty");
await new Promise((done) => {
  const p = pty.spawn(process.execPath, ["-e", "console.log('pty-ok')"], { cols: 80, rows: 10 });
  let out = "";
  p.onData((d) => (out += d));
  p.onExit(() => (out.includes("pty-ok") ? done() : fail(`pty spawn printed: ${JSON.stringify(out)}`)));
  setTimeout(() => fail("pty spawn timed out"), 15_000);
});
step("terminal library spawns processes");

// 3. A fresh repo, and HQ started on it.
mkdirSync(repo);
sh("git", ["init", "-q", "-b", "main"], repo);
writeFileSync(join(repo, "README.md"), "# smoke\n");
sh("git", ["add", "."], repo);
sh("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.com", "commit", "-qm", "init"], repo);

const startHq = () =>
  spawn(process.execPath, [bin, "--repo", repo, "--port", String(port), "--no-open"], { stdio: ["ignore", "pipe", "pipe"], env: hqEnv });
hq = startHq();
let log = "";
const token = await new Promise((done) => {
  const onData = (d) => {
    log += d;
    const m = log.match(/token=([a-f0-9]+)/);
    if (m) done(m[1]);
  };
  hq.stdout.on("data", onData);
  hq.stderr.on("data", onData);
  hq.on("exit", (code) => fail(`HQ exited early (code ${code}):\n${log}`));
  setTimeout(() => fail(`HQ didn't start in 60s:\n${log}`), 60_000);
});
hq.removeAllListeners("exit");
step("HQ started");

const companyDb = join(companyHome, "company.db");
if (!existsSync(companyDb)) fail(`no company store at ${companyDb}`);
step("company store opened in the smoke test's own folder");

// A second HQ on the same port must stop on EADDRINUSE without recording a start.
const second = startHq();
let secondLog = "";
second.stdout.on("data", (d) => (secondLog += d));
second.stderr.on("data", (d) => (secondLog += d));
const secondCode = await new Promise((done) => {
  second.on("exit", done);
  setTimeout(() => fail(`a second HQ on port ${port} didn't exit in 60s:
${secondLog}`), 60_000);
});
if (secondCode !== 1 || !/in use/.test(secondLog)) fail(`second HQ: expected exit 1 with "in use", got ${secondCode}:
${secondLog}`);
const { DatabaseSync } = await import("node:sqlite");
const store = new DatabaseSync(companyDb, { readOnly: true });
const starts = store.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'hq.started'").get().n;
store.close();
if (starts !== 1) fail(`expected 1 hq.started event, found ${starts}: a start that never served was recorded`);
step("a second HQ on a busy port exits without recording a start");

const page = await fetch(`http://127.0.0.1:${port}/?token=${token}`);
const html = await page.text();
if (!page.ok || !html.includes("<div id=")) fail(`page: HTTP ${page.status}`);
step("page served");

const WebSocket = req("ws");
const snap = await new Promise((done) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  ws.on("message", (raw) => {
    const e = JSON.parse(String(raw));
    if (e.type === "snapshot") {
      ws.close();
      done(e.snapshot);
    }
  });
  ws.on("error", (err) => fail(`websocket: ${err.message}`));
  setTimeout(() => fail("no snapshot in 15s"), 15_000);
});
if (snap.welcome !== true) fail("expected the welcome screen on a fresh repo");
step(`snapshot ok (welcome, ${snap.setup.checks.length} setup checks)`);
for (const c of snap.setup.checks) console.log(`    ${c.status === "ok" ? "✓" : c.status === "warning" ? "!" : "✗"} ${c.label}: ${c.detail}`);

cleanup();
console.log("✓ smoke test passed");
process.exit(0);

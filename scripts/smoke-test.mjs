// Installs a packed jsm-hq tarball into an empty folder like a new user would,
// then checks the parts that differ by OS: the terminal library loads and can
// spawn, and HQ starts on a fresh repo and serves the page and a snapshot.
// HQ's company store goes to a folder inside this run's temp folder
// (HQ_COMPANY_HOME), never to the real ~/.jsmhq/_company.
//
//   node scripts/smoke-test.mjs <path/to/package.tgz> [port]

import { execFileSync, execSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// Waits for fn to call done, and fails if that takes longer than ms. The timer
// is cleared once done is called: a timer left running would end a later,
// slower step with this step's message. `why` may be a function, so the
// message can include output gathered while waiting.
function within(ms, why, fn) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => fail(typeof why === "function" ? why() : why), ms);
    fn((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
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
await within(15_000, "pty spawn timed out", (done) => {
  const p = pty.spawn(process.execPath, ["-e", "console.log('pty-ok')"], { cols: 80, rows: 10 });
  let out = "";
  p.onData((d) => (out += d));
  p.onExit(() => (out.includes("pty-ok") ? done() : fail(`pty spawn printed: ${JSON.stringify(out)}`)));
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
await within(60_000, () => `HQ didn't start in 60s:\n${log}`, (done) => {
  const onData = (d) => {
    log += d;
    if (/No owner yet/.test(log)) done();
  };
  hq.stdout.on("data", onData);
  hq.stderr.on("data", onData);
  hq.on("exit", (code) => fail(`HQ exited early (code ${code}):\n${log}`));
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
const secondCode = await within(60_000, () => `a second HQ on port ${port} didn't exit in 60s:\n${secondLog}`, (done) => {
  second.on("exit", done);
});
if (secondCode !== 1 || !/in use/.test(secondLog)) fail(`second HQ: expected exit 1 with "in use", got ${secondCode}:
${secondLog}`);
const { DatabaseSync } = await import("node:sqlite");
const store = new DatabaseSync(companyDb, { readOnly: true });
const starts = store.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'hq.started'").get().n;
store.close();
if (starts !== 1) fail(`expected 1 hq.started event, found ${starts}: a start that never served was recorded`);
step("a second HQ on a busy port exits without recording a start");

const origin = `http://127.0.0.1:${port}`;
const page = await fetch(`${origin}/`);
const html = await page.text();
if (!page.ok || !html.includes("<div id=")) fail(`page: HTTP ${page.status}`);
step("page served");

// Owner login (M0-C): no credential in HQ's output, enrollment with the setup code from the file.
const setupCode = readFileSync(join(companyHome, "owner-setup.txt"), "utf8").trim();
if (/token=/.test(log) || log.includes(setupCode)) fail(`HQ printed a credential:\n${log}`);
const WebSocket = req("ws");
const refused = await within(15_000, "the WebSocket answered nothing in 15s", (done) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: origin } });
  ws.on("unexpected-response", (_req, res) => done(res.statusCode));
  ws.on("open", () => done(101));
  ws.on("error", () => {});
});
if (refused !== 401) fail(`a WebSocket with no session got ${refused}, expected 401`);
step("the WebSocket refuses a browser with no session");

const authPost = async (path, body) => {
  const res = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
  return { res, json: await res.json().catch(() => null) };
};
const enrolled = await authPost("/auth/enroll", { setupCode, displayName: "Smoke", password: "smoke test password", pin: "135790" });
if (enrolled.res.status !== 200) fail(`enroll: HTTP ${enrolled.res.status} ${JSON.stringify(enrolled.json)}`);
const base32 = (s) => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) (out.push((value >>> (bits - 8)) & 0xff), (bits -= 8));
  }
  return Buffer.from(out);
};
const totp = (seed) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", seed).update(counter).digest();
  const o = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
};
const confirmed = await authPost("/auth/enroll/confirm", { code: totp(base32(enrolled.json.secret)) });
const cookie = (confirmed.res.headers.get("set-cookie") ?? "").split(";")[0];
if (confirmed.res.status !== 200 || !cookie.startsWith("hq_session=")) fail(`enroll confirm: HTTP ${confirmed.res.status}`);
step("owner enrolled and logged in");

const snap = await within(15_000, "no snapshot in 15s", (done) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: origin, Cookie: cookie } });
  ws.on("message", (raw) => {
    const e = JSON.parse(String(raw));
    if (e.type === "snapshot") {
      ws.close();
      done(e.snapshot);
    }
  });
  ws.on("error", (err) => fail(`websocket: ${err.message}`));
});
if (snap.welcome !== true) fail("expected the welcome screen on a fresh repo");
step(`snapshot ok (welcome, ${snap.setup.checks.length} setup checks)`);
for (const c of snap.setup.checks) console.log(`    ${c.status === "ok" ? "✓" : c.status === "warning" ? "!" : "✗"} ${c.label}: ${c.detail}`);

cleanup();
console.log("✓ smoke test passed");
process.exit(0);

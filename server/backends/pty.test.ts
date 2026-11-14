import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolveCommand, shimCommandLine } from "./pty";

/** Arguments that would start a second command, or be changed, if cmd.exe saw them unescaped. */
const HOSTILE = ['a"&echo hacked&"b', "100%", "^x", "(y)", "back\\", "two words", 'q"uote', "!bang!", "<in>|out"];

test("the shim command line escapes every argument for cmd.exe, twice", () => {
  const line = shimCommandLine("C:\\Program Files\\nodejs\\claude.cmd", ["--model", 'a"&b']);
  assert.match(line, /^\/d \/s \/c "/);
  assert.match(line, /C:\\Program\^ Files\\nodejs\\claude\.cmd/);
  // The quote inside the argument is escaped, and & is escaped twice: cmd.exe and the shim's %* each undo one.
  assert.ok(line.includes('^^^&'), line);
  assert.equal(line.includes(' & '), false);
});

test("a cmd shim receives each argument unchanged", { skip: process.platform !== "win32" && "cmd.exe shims exist only on Windows" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hq shim "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shim = join(dir, "echoargs.cmd");
  writeFileSync(shim, `@"${process.execPath}" -e "console.log('ARGS' + JSON.stringify(process.argv.slice(1)))" %*\r\n`);
  const { file, args } = await resolveCommand(shim, HOSTILE);
  assert.equal(file, "cmd.exe");
  assert.equal(typeof args, "string", "one command line, passed to Windows as it is");
  // node-pty hands a string command line to Windows unchanged; spawnSync with
  // windowsVerbatimArguments does the same, without ConPTY's handles that outlive the test.
  const r = spawnSync(file, [args as string], { cwd: dir, encoding: "utf8", windowsVerbatimArguments: true, timeout: 20_000 });
  const m = r.stdout.match(/^ARGS(.*)$/m);
  assert.ok(m, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(m[1]), HOSTILE);
  assert.equal(r.stdout.replace(m[0], "").includes("hacked"), false, "nothing ran echo");
});

// HQ's startup output, from a real process: it names where the setup code is
// and never prints a credential (SR-C-01).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openCompany } from "./company";
import { base32Encode, stepOf, totpAt } from "./company/totp";

function startOutput(repo: string, home: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "server/main.ts", "--repo", repo, "--port", "0", "--no-open"], {
      env: { ...process.env, HQ_COMPANY_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`HQ did not start in 90 s:\n${out}`));
    }, 90_000);
    const onData = (d: Buffer) => {
      out += d;
      // The setup line, when there is one, comes right after the "running" line.
      if (/is running/.test(out)) {
        setTimeout(() => {
          clearTimeout(timer);
          child.kill();
        }, 500);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

test("SR-C-01 [T-S5.1] HQ's startup output contains no credential", { timeout: 200_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hq startup "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  const home = join(dir, "company home");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# x\n");

  // No owner: HQ says where the setup code is, and never prints it.
  const first = await startOutput(repo, home);
  const setupFile = join(home, "owner-setup.txt");
  const setupCode = readFileSync(setupFile, "utf8").trim();
  assert.match(first, /No owner yet/);
  assert.ok(first.includes("owner-setup.txt"));
  assert.ok(!first.includes(setupCode), "the setup code was printed");
  assert.doesNotMatch(first, /token=/);

  // With an owner: nothing about setup, and still no credential.
  const company = openCompany({ home, repoRoot: null });
  const { seed } = await company.humans.startEnrollment({ id: "owner", displayName: "O", role: "owner" }, "startup test password", "135790");
  assert.ok(await company.humans.confirmEnrollment("owner", totpAt(seed, stepOf(new Date()))));
  company.close();
  const second = await startOutput(repo, home);
  assert.match(second, /is running/);
  assert.doesNotMatch(second, /No owner yet|token=/);
  for (const secret of [setupCode, base32Encode(seed), "startup test password"]) assert.ok(!second.includes(secret));
  // No long run of base64url characters (a session id or a key) anywhere in the output.
  assert.doesNotMatch(second.replace(/[^\n]*[\\/][^\n]*/g, ""), /[A-Za-z0-9_-]{32,}/);
});

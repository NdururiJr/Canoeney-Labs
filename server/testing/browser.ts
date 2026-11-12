// A real browser for the tests that must see what a browser does with a page
// (SR-C-10 to SR-C-12): Chrome or Edge, headless, with a throwaway profile.
// GitHub's Ubuntu, macOS and Windows runners have Chrome. Locally, a missing
// browser skips the test; in CI (process.env.CI) it fails it.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const CANDIDATES: Record<string, string[]> = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
};
const ON_PATH = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];

export function findBrowser(): string | null {
  const fromEnv = process.env.HQ_TEST_BROWSER;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  for (const p of CANDIDATES[process.platform] ?? []) if (existsSync(p)) return p;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of ON_PATH) if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

/**
 * The browser for a test, or null after skipping it. In CI a missing browser
 * is a failure, so a runner image that drops Chrome cannot quietly pass.
 */
export function browserFor(t: { skip(msg?: string): void }): string | null {
  const bin = findBrowser();
  if (bin) return bin;
  if (process.env.CI) throw new Error("No Chrome or Edge found in CI. Set HQ_TEST_BROWSER to its path.");
  t.skip("no Chrome or Edge found; set HQ_TEST_BROWSER to run this test");
  return null;
}

/** Loads the page headless, lets its scripts run, and returns the DOM it ends with. */
export function dumpDom(bin: string, url: string): Promise<string> {
  const profile = mkdtempSync(join(tmpdir(), "hq-browser-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--user-data-dir=${profile}`,
    "--virtual-time-budget=3000",
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    "--dump-dom",
    url,
  ];
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      // The browser can hold its profile for a moment after it exits.
      setTimeout(() => rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), 500);
      if (err && !stdout) reject(err);
      else resolve(String(stdout));
    });
  });
}

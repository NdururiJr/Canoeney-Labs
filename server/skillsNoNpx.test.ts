// SR-F-02: no installer fetched from a registry runs on the host (M0-F Task 5).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";

/** The help texts main.ts prints for a busy or reserved port: shown to the user, never run. */
const ALLOWED_HELP = [
  "another HQ may be running. Stop it, or pick another port: npx @therealjsmastery/jsm-hq --port 7421",
  "Pick another: npx @therealjsmastery/jsm-hq --port 8420\\n  See the reserved ranges",
  "Not allowed to use port ${port}. Pick another: npx @therealjsmastery/jsm-hq --port 8420",
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(ts|mts|cts|js|mjs|cjs)$/.test(e.name) && !/\.test\.[a-z]+$/.test(e.name) ? [p] : [];
  });
}

test("SR-F-02 [T-S12.2] server/ holds no npx call", () => {
  const root = import.meta.dirname;
  const found: string[] = [];
  for (const file of sources(root)) {
    const rel = relative(root, file).split(sep).join("/");
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!/\bnpx\b/.test(line)) return;
        // npx as an argument to a process is never allowed, even in main.ts.
        const asArgument = /["'`]npx["'`]/.test(line);
        const help = rel === "main.ts" && ALLOWED_HELP.some((h) => line.includes(h));
        if (asArgument || !help) found.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(found, []);
});

test("the npx check sees an npx call", () => {
  const line = `const [cmd, cmdArgs] = ["npx", args];`;
  assert.ok(/\bnpx\b/.test(line) && /["'`]npx["'`]/.test(line));
});

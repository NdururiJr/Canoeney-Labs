// SR-C-10: React escapes every string it renders, so agent text is only
// dangerous where code turns a string into markup or code. No file in src/
// may do that, and every link target goes through safeHref.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "testing" ? [] : files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

const FORBIDDEN: [RegExp, string][] = [
  [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML"],
  [/\.innerHTML\b/, "innerHTML"],
  [/\.outerHTML\b/, "outerHTML"],
  [/insertAdjacentHTML/, "insertAdjacentHTML"],
  [/document\.write/, "document.write"],
  [/\bsrcdoc\b|srcDoc/, "srcdoc"],
  [/\beval\s*\(/, "eval("],
  [/new Function\s*\(/, "new Function"],
];

test("SR-C-10 [T-S10.2] no source file can turn a string into markup or code", () => {
  const found: string[] = [];
  for (const f of files(SRC)) {
    const text = readFileSync(f, "utf8");
    const where = relative(SRC, f);
    for (const [re, name] of FORBIDDEN) if (re.test(text)) found.push(`${where}: ${name}`);
    // A link target from data goes through safeHref (or otpauthHref, the enrollment link).
    for (const m of text.matchAll(/href=\{(?!(safeHref|otpauthHref)\()/g)) found.push(`${where}: href={${text.slice(m.index! + 6, m.index! + 40)}`);
  }
  assert.deepEqual(found, []);
});

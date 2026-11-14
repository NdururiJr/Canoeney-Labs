// Workflow files in a managed repo (SR-E-11). A privileged trigger runs with
// write access outside every HQ gate; an action pinned by tag can change under
// the same tag. Line rules only: no YAML package (spec §7).
import { basename } from "node:path";
import type { Finding } from "./repoGuard";

const PRIVILEGED = ["pull_request_target", "workflow_run", "issue_comment"] as const;
const SHA = /@[0-9a-f]{40}$/;

/** Drops a `#` comment that is not inside quotes. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

export function scanWorkflow(path: string, yaml: string): Finding[] {
  const file = basename(path);
  const lines = yaml.split(/\r?\n/).map(stripComment);
  const text = lines.join("\n");
  const findings: Finding[] = [];
  for (const t of PRIVILEGED) {
    // As a key (`trigger:`), a bare value (`on: trigger`) or a list item (`[a, trigger]`, `- trigger`).
    if (new RegExp(`(^|[\\s\\[,'"-])${t}(['"]?\\s*(:|,|\\]|$))`, "m").test(text)) {
      findings.push({ name: `workflow-trigger:${file}:${t}`, detail: `${path} runs on ${t}, which runs with write access outside HQ's gates.`, fixable: false });
    }
  }
  for (const line of lines) {
    const m = line.match(/^\s*-?\s*uses:\s*['"]?([^'"\s]+)/);
    if (!m) continue;
    const uses = m[1];
    if (uses.startsWith("./") || SHA.test(uses)) continue;
    findings.push({ name: `workflow-unpinned:${file}:${uses}`, detail: `${path} uses ${uses}, which is not pinned to a commit.`, fixable: false });
  }
  return findings;
}

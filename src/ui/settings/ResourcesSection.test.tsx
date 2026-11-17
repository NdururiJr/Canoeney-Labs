/** @jsxRuntime automatic */
// (tsx compiles this test outside tsconfig.json, which excludes tests: the pragma picks the same JSX runtime.)
// M0-F final review: a start refused for sbx's shared skills tells the owner to press Recreate sandbox
// in Settings → Sandbox, so the button is there for every existing sandbox, not only on a size mismatch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentConfig, AgentStatus, MachineInfo } from "../../data/types";
import { recreateConfirmText, ResourcesSection } from "./ResourcesSection";

const machine: MachineInfo = { cpus: 8, memoryGb: 16 };
const agent: AgentConfig = {
  id: "ana",
  name: "Ana",
  role: "Developer",
  isLead: false,
  cli: "claude",
  model: "",
  mode: "sandbox",
  color: "#29adff",
  skills: [],
  roleMd: "",
  sandbox: { resources: { cpus: null, memoryGb: null }, allow: [], deny: [] },
  workspacePath: null,
};
const status = (sandbox: { cpus: number; memoryGb: number } | null): AgentStatus => ({
  agentId: "ana",
  state: "idle",
  currentTaskId: null,
  stateSince: "2026-11-17T10:00:00.000Z",
  note: "Could not start",
  session: { state: "failed", detail: "refused", workspace: "/w", sandbox },
});
const render = (s: AgentStatus | undefined, a: AgentConfig = agent) => renderToStaticMarkup(<ResourcesSection agent={a} status={s} team={[a]} machine={machine} />);
const BUTTON = /<button[^>]*>Recreate sandbox<\/button>/;

test("Recreate sandbox shows for a sandbox agent with a sandbox even when its size matches", () => {
  // The sbx default on this machine: 8 CPUs, 8 GB. The sandbox has that, so there is no mismatch.
  const html = render(status({ cpus: 8, memoryGb: 8 }));
  assert.match(html, BUTTON);
  assert.doesNotMatch(html, /Size is fixed when a sandbox is created/, "the size sentence is only for a mismatch");
  assert.doesNotMatch(html, /border-orange/, "no warning box without a mismatch");
});

test("Recreate sandbox on a size mismatch keeps the warning and the size sentence", () => {
  const html = render(status({ cpus: 2, memoryGb: 4 }));
  assert.match(html, BUTTON);
  assert.match(html, /Size is fixed when a sandbox is created/);
  assert.match(html, /border-orange/);
});

test("no Recreate sandbox without a sandbox", () => {
  assert.doesNotMatch(render(status(null)), BUTTON);
  assert.doesNotMatch(render(undefined), BUTTON);
});

test("the recreate confirm names a size only when the size changes", () => {
  const eff = { cpus: 4, memoryGb: 4 };
  const plain = recreateConfirmText("Ana", eff, false);
  assert.match(plain, /^Recreate Ana's sandbox\?/);
  assert.doesNotMatch(plain, /CPUs|GB/);
  assert.match(plain, /folder and code are kept/);
  const sized = recreateConfirmText("Ana", eff, true);
  assert.match(sized, /^Recreate Ana's sandbox with 4 CPUs and 4 GB\?/);
  assert.match(sized, /folder and code are kept/);
});

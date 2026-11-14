/** @jsxRuntime automatic */
// (tsx compiles this test outside tsconfig.json, which excludes tests: the pragma picks the same JSX runtime.)
// M0-E: Local mode is refused for every agent (SR-E-06); the setup screen never offers it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupChecklistView } from "./SetupChecklistView";

test("SR-E-06 the setup screen never offers Local mode, even when sandboxes are not ready", () => {
  const setup = {
    machine: { cpus: 8, memoryGb: 16, persistentAgents: false },
    checks: [{ id: "sbx", label: "Docker Sandboxes (sbx)", status: "missing", detail: "Not installed.", neededFor: "sandbox", fix: null }],
    sandboxReady: false,
    checkedAt: "2026-11-15T00:00:00.000Z",
  } as never;
  const html = renderToStaticMarkup(<SetupChecklistView setup={setup} />);
  assert.match(html, /Sandboxes/);
  assert.doesNotMatch(html, /Local/);
});

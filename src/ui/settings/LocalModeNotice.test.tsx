/** @jsxRuntime automatic */
// (tsx compiles this test outside tsconfig.json, which excludes tests: the pragma picks the same JSX runtime.)
// PR #12 review, round 1: an agent stored in Local mode can be switched to Sandbox from the dashboard.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalModeNotice } from "./LocalModeNotice";

test("SR-E-06 the Local-mode notice offers a Switch to Sandbox button that sets mode sandbox", () => {
  const html = renderToStaticMarkup(<LocalModeNotice onSwitch={() => {}} />);
  assert.match(html, /HQ no longer runs/);
  assert.match(html, /<button[^>]*>Switch to Sandbox<\/button>/);
  // The click handler sends exactly { mode: "sandbox" }.
  const sent: unknown[] = [];
  const el = LocalModeNotice({ onSwitch: (patch) => sent.push(patch) }) as { props: { children: unknown[] } };
  const button = (el.props.children as { type?: string; props?: { onClick?: () => void } }[]).find((c) => c?.type === "button");
  button?.props?.onClick?.();
  assert.deepEqual(sent, [{ mode: "sandbox" }]);
});

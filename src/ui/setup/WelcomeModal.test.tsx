/** @jsxRuntime automatic */
// (tsx compiles this test outside tsconfig.json, which excludes tests: the pragma picks the same JSX runtime.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { presets } from "../../data/mock/presets";
import { World } from "../../data/mock/world";
import { useOffice } from "../../store/office";
import { WelcomeModal } from "./WelcomeModal";

/** Server rendering reads the store's initial state, so the snapshot goes there (and is put back). */
function withSnap(t: { after(fn: () => void): void }, snap: unknown): void {
  const initial = useOffice.getInitialState() as { snap: unknown };
  const before = initial.snap;
  initial.snap = snap;
  t.after(() => void (initial.snap = before));
}

test("with the welcome open on one of two projects, the other can still be selected", (t) => {
  const snap = structuredClone(new World(presets[0]).snap);
  snap.welcome = true;
  snap.projectId = "site";
  snap.projects = [
    { id: "site", name: "Website", state: "open" },
    { id: "shop", name: "Shop", state: "open" },
  ];
  withSnap(t, snap);
  const html = renderToStaticMarkup(<WelcomeModal />);
  // The welcome covers the top bar, so it carries the project choice itself.
  assert.match(html, /<select[^>]*aria-label="Project"/);
  assert.match(html, /<option value="shop"[^>]*>Shop<\/option>/);
  assert.doesNotMatch(html, /Add project/);
});

test("with one project, the welcome shows no project choice", (t) => {
  const snap = structuredClone(new World(presets[0]).snap);
  snap.welcome = true;
  snap.projectId = "site";
  snap.projects = [{ id: "site", name: "Website", state: "open" }];
  withSnap(t, snap);
  const html = renderToStaticMarkup(<WelcomeModal />);
  assert.match(html, /Welcome to/, "the welcome rendered");
  assert.doesNotMatch(html, /aria-label="Project"/);
});

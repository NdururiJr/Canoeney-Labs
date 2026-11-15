// M0-E Task 6 leftover (found in the exit check): Local mode is refused for every
// agent (SR-E-06), so the setup checks never offer it, check for it, or call it ready.
import assert from "node:assert/strict";
import { test } from "node:test";
import { newAgent } from "./store";
import { runSetupChecks } from "./setup";

test("SR-E-06 the setup checks never offer Local mode", async () => {
  const codex = { ...newAgent("cara", "Cara", "Developer", "#000000", false), cli: "codex" as const, mode: "local" as const };
  const setup = await runSetupChecks({ root: ".", name: "site", originUrl: null, github: "acme/site" } as never, [codex]);
  assert.equal("localReady" in setup, false, "no Local mode readiness");
  for (const c of setup.checks) {
    assert.notEqual(c.neededFor as string, "local", c.id);
    assert.doesNotMatch(`${c.label} ${c.detail} ${c.fix?.command ?? ""}`, /Local mode/, c.id);
  }
  assert.equal(setup.checks.some((c) => (c.id as string) === "claude" || (c.id as string) === "codex"), false, "no host CLI check: agents run in sandboxes, which have them");
});

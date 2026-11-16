// M0-F Task 7 fix: how HQ's answers to the skills commands (and addProject) settle in the store.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { SkillsPinPreview } from "../data/types";
import { asSkillsPreview, officeActions, settleCommand, useOffice } from "./office";

const preview = (over: Partial<SkillsPinPreview> = {}): SkillsPinPreview => ({
  repo: "acme/skills",
  commit: "a".repeat(40),
  lockHash: "f".repeat(64),
  skills: [{ name: "alpha", hash: "1".repeat(64), files: 1, scripts: [] }],
  refused: [],
  added: ["alpha"],
  changed: [],
  removed: [],
  rolesLosing: [],
  findings: [],
  links: { commit: "https://github.com/acme/skills/commit/aaa", compare: null },
  ...over,
});

const get = () => useOffice.getState();

beforeEach(() => {
  useOffice.setState({ skillsPin: { state: "idle" }, skillsRoleErrors: {}, addProject: { state: "idle" } });
});

test("a failed preview shows HQ's reason, or a readable fallback", () => {
  settleCommand("previewSkillsPin", { ok: false, error: "failed", message: "That commit is not on the skills repo's default branch." }, ["acme/skills", "a".repeat(40)]);
  assert.deepEqual(get().skillsPin, { state: "failed", message: "That commit is not on the skills repo's default branch." });
  settleCommand("previewSkillsPin", { ok: false, error: "failed" }, []);
  assert.deepEqual(get().skillsPin, { state: "failed", message: "HQ could not preview that commit." });
});

test("a preview whose data is not shaped like one is a failed state, not a crash", () => {
  for (const data of [undefined, null, "x", {}, { ...preview(), skills: "nope" }, { ...preview(), links: undefined }, { ...preview(), rolesLosing: [{ role: 1, skills: [] }] }]) {
    useOffice.setState({ skillsPin: { state: "previewing" } });
    settleCommand("previewSkillsPin", { ok: true, data }, []);
    assert.equal(get().skillsPin.state, "failed", JSON.stringify(data));
  }
  assert.equal(asSkillsPreview(preview())?.lockHash, "f".repeat(64));
  assert.equal(asSkillsPreview({ ...preview(), skills: null }), null);
});

test("a good preview becomes ready with exactly what HQ sent", () => {
  const p = preview();
  settleCommand("previewSkillsPin", { ok: true, data: p }, []);
  assert.deepEqual(get().skillsPin, { state: "ready", preview: p });
});

test("a refused pin keeps the preview and shows HQ's reason; a PIN prompt leaves it alone", () => {
  const p = preview();
  useOffice.setState({ skillsPin: { state: "ready", preview: p } });
  for (const error of ["pin-required", "pin-wrong", "pin-locked"]) {
    settleCommand("pinSkills", { ok: false, error }, ["acme/skills", p.commit, p.lockHash]);
    assert.deepEqual(get().skillsPin, { state: "ready", preview: p }, error);
  }
  settleCommand("pinSkills", { ok: false, error: "failed", message: "This commit no longer reads the way it did." }, []);
  assert.deepEqual(get().skillsPin, { state: "ready", preview: p, error: "This commit no longer reads the way it did." });
  settleCommand("pinSkills", { ok: false, error: "failed" }, []);
  assert.equal((get().skillsPin as { error?: string }).error, "HQ did not pin it.");
  // No preview on screen: nothing to attach the error to.
  useOffice.setState({ skillsPin: { state: "idle" } });
  settleCommand("pinSkills", { ok: false, error: "failed", message: "x" }, []);
  assert.deepEqual(get().skillsPin, { state: "idle" });
});

test("a pin that succeeds ends the flow", () => {
  useOffice.setState({ skillsPin: { state: "ready", preview: preview() } });
  settleCommand("pinSkills", { ok: true }, []);
  assert.deepEqual(get().skillsPin, { state: "idle" });
});

test("a refused role save sets that role's error, and only that role's", () => {
  settleCommand("setRoleSkills", { ok: false, error: "failed", message: "A role's skills are a list of skill names." }, ["qa", ["x"]]);
  assert.deepEqual(get().skillsRoleErrors, { qa: "A role's skills are a list of skill names." });
  settleCommand("setRoleSkills", { ok: false, error: "failed" }, ["builder", []]);
  assert.equal(get().skillsRoleErrors.builder, "HQ did not save that role's skills.");
  assert.equal(get().skillsRoleErrors.qa, "A role's skills are a list of skill names.");
});

test("a PIN prompt for a role save is not an error, and a saved role clears its error", () => {
  useOffice.setState({ skillsRoleErrors: { qa: "old" } });
  for (const error of ["pin-required", "pin-wrong", "pin-locked"]) {
    settleCommand("setRoleSkills", { ok: false, error }, ["qa", []]);
    assert.deepEqual(get().skillsRoleErrors, { qa: "old" }, error);
  }
  settleCommand("setRoleSkills", { ok: false, error: "pin-required" }, ["cto", []]);
  assert.equal("cto" in get().skillsRoleErrors, false);
  settleCommand("setRoleSkills", { ok: true }, ["qa", []]);
  assert.deepEqual(get().skillsRoleErrors, {});
  // An answer whose args did not come back names no role, so there is nothing to mark.
  settleCommand("setRoleSkills", { ok: false, error: "failed", message: "m" }, []);
  assert.deepEqual(get().skillsRoleErrors, {});
});

test("saving a role again clears its earlier error", () => {
  useOffice.setState({ skillsRoleErrors: { qa: "old", cto: "other" } });
  officeActions.setRoleSkills("qa", []);
  assert.deepEqual(get().skillsRoleErrors, { cto: "other" });
});

test("addProject still settles: done on success, failed with the reason, waiting through a PIN prompt", () => {
  useOffice.setState({ addProject: { state: "adding" } });
  settleCommand("addProject", { ok: false, error: "pin-required" }, ["/x"]);
  assert.deepEqual(get().addProject, { state: "adding" });
  settleCommand("addProject", { ok: false, error: "pin-wrong" }, ["/x"]);
  assert.deepEqual(get().addProject, { state: "adding" });
  settleCommand("addProject", { ok: false, error: "failed", message: "Not a repo." }, ["/x"]);
  assert.deepEqual(get().addProject, { state: "failed", message: "Not a repo." });
  useOffice.setState({ addProject: { state: "adding" } });
  settleCommand("addProject", { ok: true }, ["/x"]);
  assert.deepEqual(get().addProject, { state: "done" });
  // An answer that arrives when no add is under way changes nothing.
  useOffice.setState({ addProject: { state: "idle" } });
  settleCommand("addProject", { ok: true }, ["/x"]);
  assert.deepEqual(get().addProject, { state: "idle" });
});

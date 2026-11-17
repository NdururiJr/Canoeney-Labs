// The owner's skills commands (M0-F Task 3): preview a commit of the skills repo,
// confirm it with the PIN, and change a role's skill set with the PIN.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CompanySkills, type PinPreview } from "./company/companySkills";
import type { OfficeSnapshot } from "../src/data/types";
import { viewFor, type CommandCtx } from "./dashboard";
import { makeSkillsRepo } from "./testing/skillsRepo";
import { makeHq, OWNER_PIN } from "./testing/hqFixture";

const OWNER = { kind: "human", id: "owner" } as const;
const ownerCtx = (projectId: string | null): CommandCtx => ({ actor: OWNER, role: "owner", remote: false, sessionId: "s1", projectId });
const message = (r: unknown) => (r as { message?: string }).message ?? "";

test("setRoleSkills needs the PIN and a known role and skill names", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  const ctx = ownerCtx(hq.slug);
  const before = JSON.stringify(hq.company.skills.roleSet("qa"));
  const roleSetRows = () => hq.company.audit.query({ action: "skills.role-set" }).length;

  const noPin = await hq.dashboard.dispatch(ctx, { cmd: "setRoleSkills", args: ["qa", ["brainstorming"]] });
  assert.deepEqual(noPin, { ok: false, error: "pin-required" });
  assert.equal(JSON.stringify(hq.company.skills.roleSet("qa")), before);

  const badRole = await hq.dashboard.dispatch(ctx, { cmd: "setRoleSkills", args: ["janitor", ["brainstorming"]], pin: OWNER_PIN });
  assert.equal(badRole.ok, false);
  assert.match(message(badRole), /not a role/);
  const badName = await hq.dashboard.dispatch(ctx, { cmd: "setRoleSkills", args: ["qa", ["../x"]], pin: OWNER_PIN });
  assert.match(message(badName), /not a skill name/);
  assert.equal(roleSetRows(), 0);
  assert.equal(JSON.stringify(hq.company.skills.roleSet("qa")), before);

  const ok = await hq.dashboard.dispatch(ctx, { cmd: "setRoleSkills", args: ["qa", ["brainstorming"]], pin: OWNER_PIN });
  assert.deepEqual(ok, { ok: true, data: { added: ["brainstorming"], removed: [] } });
  assert.deepEqual(hq.company.skills.roleSet("qa"), ["brainstorming"]);
  const row = hq.company.audit.query({ action: "skills.role-set" }).at(-1)!;
  assert.equal(row.actorId, "owner");
  assert.equal(row.data.authority, "pin");
});

test("previewSkillsPin and pinSkills: only what was previewed is pinned, and the pin needs the PIN", async (t) => {
  const hq = await makeHq(t);
  await hq.enroll();
  const ctx = ownerCtx(hq.slug);

  const root = mkdtempSync(join(tmpdir(), "hq-skills-cmd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = makeSkillsRepo(root);
  const a = origin.commit({ "skills/alpha/SKILL.md": "alpha v1" });
  // The command reads the company's skills at call time; give it the local origin.
  hq.company.skills = new CompanySkills(hq.company.db, hq.company.clock, hq.company.settings, {
    home: join(root, "company home"),
    urlFor: () => origin.url,
    allowFile: true,
  });

  const pv = await hq.dashboard.dispatch(ctx, { cmd: "previewSkillsPin", args: ["acme/skills", a] });
  assert.equal(pv.ok, true);
  const preview = (pv as { data: PinPreview }).data;
  assert.equal(preview.commit, a);
  assert.deepEqual(preview.added, ["alpha"]);
  assert.equal(hq.company.skills.source(), null, "a preview pins nothing");

  const noPin = await hq.dashboard.dispatch(ctx, { cmd: "pinSkills", args: ["acme/skills", a, preview.lockHash] });
  assert.deepEqual(noPin, { ok: false, error: "pin-required" });
  assert.equal(hq.company.skills.source(), null);

  // A changed lock hash is refused with the reason in the reply and in the audit.
  const changed = await hq.dashboard.dispatch(ctx, { cmd: "pinSkills", args: ["acme/skills", a, "f".repeat(64)], pin: OWNER_PIN });
  assert.equal(changed.ok, false);
  assert.match(message(changed), /Preview it again/);
  assert.equal(hq.company.audit.query({ action: "skills.pin-refused" }).at(-1)!.data.reason, "lock-changed");
  assert.equal(hq.company.skills.source(), null);

  const done = await hq.dashboard.dispatch(ctx, { cmd: "pinSkills", args: ["acme/skills", a, preview.lockHash], pin: OWNER_PIN });
  assert.equal(done.ok, true);
  assert.deepEqual(hq.company.skills.source(), { repo: "acme/skills", commit: a, lockHash: preview.lockHash });
  assert.equal(hq.company.audit.query({ action: "skills.pinned" }).at(-1)!.actorId, "owner");

  // A repo name that is not owner/name is refused before any git call.
  for (const cmd of ["previewSkillsPin", "pinSkills"]) {
    const bad = await hq.dashboard.dispatch(ctx, { cmd, args: ["not a repo", a, preview.lockHash], pin: OWNER_PIN });
    assert.equal(bad.ok, false);
    assert.match(message(bad), /owner\/name/);
  }
});

test("the supervisor's view has no skills: not in the snapshot, and the update is owner only", () => {
  const skills = { source: { repo: "acme/skills", commit: "a".repeat(40), lockHash: "L" }, lock: [], roles: {} };
  const snapshot = { welcome: false, skills, config: { project: {}, team: [], workflow: {} }, agents: [] } as unknown as OfficeSnapshot;
  const seen = viewFor("supervisor", { type: "snapshot", snapshot });
  assert.ok(seen && seen.type === "snapshot");
  assert.equal("skills" in seen.snapshot, false);
  assert.equal(viewFor("supervisor", { type: "skills.updated", skills }), null);
  assert.ok(viewFor("owner", { type: "skills.updated", skills }));
});

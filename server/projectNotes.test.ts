import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { OfficeSnapshot } from "../src/data/types";
import { roleMd } from "./agentFiles";
import { makeCommands } from "./commands";
import { AuthorityError } from "./company/authority";
import { Dashboard, viewFor, type CommandCtx } from "./dashboard";
import { refreshProjectNotes } from "./projectNotesSync";
import { makeHq, type Hq } from "./testing/hqFixture";

const OWNER: CommandCtx = { actor: { kind: "human", id: "owner" }, role: "owner", remote: false, sessionId: "s1" };
const WITH_PIN: CommandCtx = { ...OWNER, pin: true };
const stub = new Proxy({}, { get: () => async () => {} }) as never;

const commandsFor = (hq: Hq) => makeCommands(hq.hub, stub, hq.planner, hq.inbox, stub, stub, hq.company);
const notesFile = (hq: Hq) => join(hq.repoRoot, "CLAUDE.md");
const roleOf = (hq: Hq, id: string) =>
  roleMd(hq.hub.cfg(id)!, hq.hub.snap.config, { role: "builder", ctoId: "lead", notes: hq.company.notes.current(hq.slug) });

test("SR-D-07 [T-S7.3] a changed CLAUDE.md reaches agents only after the owner approves it", async (t) => {
  const hq = await makeHq(t);
  const commands = commandsFor(hq);
  writeFileSync(notesFile(hq), "alpha notes");
  refreshProjectNotes(hq.hub, hq.company);
  assert.equal(roleOf(hq, "ana").includes("alpha notes"), false, "nothing reaches agents before approval");
  await commands.approveProjectNotes.run(WITH_PIN, hq.hub.snap.projectNotes!.pending!.sha256);
  assert.match(roleOf(hq, "ana"), /## Project notes \(CLAUDE\.md, version 1, approved by the owner\)\nalpha notes/);

  writeFileSync(notesFile(hq), "beta notes");
  refreshProjectNotes(hq.hub, hq.company);
  assert.match(roleOf(hq, "ana"), /alpha notes/);
  assert.equal(roleOf(hq, "ana").includes("beta notes"), false);
  assert.equal(hq.hub.snap.projectNotes?.pending?.text, "beta notes");

  await commands.approveProjectNotes.run(WITH_PIN, hq.hub.snap.projectNotes!.pending!.sha256);
  assert.match(roleOf(hq, "ana"), /version 2[^\n]*\nbeta notes/);
  assert.equal(hq.hub.snap.projectNotes?.pending, null);
  const row = hq.company.audit.query({ action: "project-notes.approved" }).at(-1)!;
  assert.deepEqual(Object.keys(row.data).sort(), ["authority", "sha256", "version"]);
});

test("SR-D-07 [T-S7.3] approving without the PIN is refused and changes nothing", async (t) => {
  const hq = await makeHq(t);
  const commands = commandsFor(hq);
  writeFileSync(notesFile(hq), "gamma notes");
  refreshProjectNotes(hq.hub, hq.company);
  const sha = hq.hub.snap.projectNotes!.pending!.sha256;
  const dashboard = new Dashboard(commands, { ownerAuth: hq.ownerAuth, audit: hq.company.audit, clock: hq.clock });
  assert.deepEqual(await dashboard.dispatch(OWNER, { cmd: "approveProjectNotes", args: [sha] }), { ok: false, error: "pin-required" });
  await assert.rejects(Promise.resolve().then(() => commands.approveProjectNotes.run(OWNER, sha)), AuthorityError);
  const refused = hq.company.audit.query({ action: "settings.refused" }).at(-1)!;
  assert.deepEqual([refused.actorId, refused.data.change, refused.data.reason], ["owner", "notes-approved", "pin-or-decision-required"]);
  assert.equal(hq.company.notes.current(hq.slug), null);
});

test("an approval for text the owner did not see is refused", async (t) => {
  const hq = await makeHq(t);
  const commands = commandsFor(hq);
  writeFileSync(notesFile(hq), "seen text");
  refreshProjectNotes(hq.hub, hq.company);
  const seen = hq.hub.snap.projectNotes!.pending!.sha256;
  writeFileSync(notesFile(hq), "swapped text");
  refreshProjectNotes(hq.hub, hq.company);
  await commands.approveProjectNotes.run(WITH_PIN, seen);
  assert.equal(hq.company.notes.current(hq.slug), null);
  assert.ok(hq.hub.snap.activity.some((a) => /changed after you read it/.test(a.text)));
});

test("approved notes are append-only", async (t) => {
  const hq = await makeHq(t);
  writeFileSync(notesFile(hq), "first");
  refreshProjectNotes(hq.hub, hq.company);
  await commandsFor(hq).approveProjectNotes.run(WITH_PIN, hq.hub.snap.projectNotes!.pending!.sha256);
  assert.throws(() => hq.company.db.prepare("UPDATE project_notes SET content = 'x'").run(), /append-only/);
  assert.throws(() => hq.company.db.prepare("DELETE FROM project_notes").run(), /append-only/);
});

test("a CLAUDE.md that is a link, or longer than 20,000 characters, is not offered", async (t) => {
  const hq = await makeHq(t);
  writeFileSync(notesFile(hq), "x".repeat(20_001));
  assert.deepEqual(hq.company.notes.readFrom(hq.repoRoot), { error: "too-long" });
  refreshProjectNotes(hq.hub, hq.company);
  assert.equal(hq.hub.snap.projectNotes?.pending, null);

  const target = join(hq.scratch, "elsewhere.md");
  writeFileSync(target, "linked notes");
  const link = join(hq.scratch, "linked repo");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(link);
  try {
    symlinkSync(target, join(link, "CLAUDE.md"), "file");
  } catch {
    t.skip("this machine cannot create file links");
    return;
  }
  assert.deepEqual(hq.company.notes.readFrom(link), { error: "link" });
});

test("the supervisor's view has no project notes", () => {
  const projectNotes = { approved: null, pending: { sha256: "a".repeat(64), text: "secret plans" } };
  const snapshot = { welcome: false, projectNotes, config: { project: {}, team: [], workflow: {} }, agents: [] } as unknown as OfficeSnapshot;
  const seen = viewFor("supervisor", { type: "snapshot", snapshot });
  assert.ok(seen && seen.type === "snapshot");
  assert.equal("projectNotes" in seen.snapshot, false);
  assert.equal(viewFor("supervisor", { type: "projectNotes.updated", projectNotes }), null);
});

// No skills from sbx's machine-wide shared skills store (M0-F Task 6). A skill added to
// that store on the host would reach every agent with no pin, so HQ creates sandboxes
// with `--skills off`, and starts an older one only while the store is empty.
// Nothing here runs the real sbx: the exec is injected.
import assert from "node:assert/strict";
import test from "node:test";
import { companyAgentId, type Actor } from "./company/agents";
import type { RunResult } from "./lib/exec";
import { Sbx } from "./sbx";
import { sbxRunArgs } from "./sessions";
import { makeHq } from "./testing/hqFixture";
import { withSessions } from "./testing/sessionFixture";

const OWNER: Actor = { kind: "human", id: "owner" };

type Answer = "empty" | "some" | "unknown";

/** Sessions on the fixture, with sbx's shared skills store answering `answer` and the sandbox existing or not. */
async function setup(t: Parameters<typeof makeHq>[0], answer: Answer = "empty", o: { realLs?: boolean } = {}) {
  const hq = await makeHq(t);
  const s = withSessions(t, hq);
  const state = { exists: false, asked: 0, removed: [] as string[], ls: "ok" as "ok" | "fail" | "garbage" | "timeout" };
  s.sessions.sharedSkills = async () => {
    state.asked++;
    return answer;
  };
  const exec = async (_cmd: string, args: string[]): Promise<RunResult> => {
    if (args[0] === "ls") {
      if (state.ls === "fail") return { ok: false, code: 1, stdout: "", stderr: "daemon is not running" };
      if (state.ls === "timeout") return { ok: false, code: null, stdout: "", stderr: "Command failed: timed out" };
      if (state.ls === "garbage") return { ok: true, code: 0, stdout: "A new version of sbx is available.", stderr: "" };
      return { ok: true, code: 0, stdout: JSON.stringify(state.exists ? [{ name: `hq-${hq.slug}-ana` }] : []), stderr: "" };
    }
    if (args[0] === "rm") {
      state.removed.push(args[args.length - 1]);
      state.exists = false;
    }
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  Object.assign(s.sessions as unknown as Record<string, unknown>, { sbxExec: exec });
  // Most tests say whether the sandbox exists; the `sbx ls` ones read it through the injected exec.
  // The fixture stubs the sandbox check; deleting its stub brings back the real one, which runs the injected exec.
  if (o.realLs) delete (s.sessions as unknown as Record<string, unknown>).sandboxState;
  else Object.assign(s.sessions as unknown as Record<string, unknown>, { sandboxState: async () => (state.exists ? "yes" : "no") });
  const cid = companyAgentId(hq.slug, "ana");
  const refusals = () => hq.company.audit.query({ action: "workspace.refused" });
  return { hq, ...s, state, cid, refusals };
}

test("sbxRunArgs puts --skills off before the agent name, only when asked", () => {
  const base = { name: "hq-p-ana", size: ["--cpus", "2"], envFile: null, sbxAgent: "claude", dir: "/w", launchArgs: ["--x"] };
  const on = sbxRunArgs({ ...base, skillsOff: true });
  assert.deepEqual(on, ["run", "--name", "hq-p-ana", "--cpus", "2", "--skills", "off", "claude", "/w", "--", "--x"]);
  assert.ok(!sbxRunArgs({ ...base, skillsOff: false }).includes("--skills"));
});

test("a new sandbox is created with sbx's shared skills off", async (t) => {
  const { hq, sessions, backend, state, cid } = await setup(t, "some");
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "running", hq.hub.status("ana")?.session.detail ?? "");
  const args = backend.created[0].spec.args;
  const at = args.indexOf("--skills");
  assert.ok(at > 0 && args[at + 1] === "off", args.join(" "));
  assert.ok(at < args.indexOf("claude"), "before the agent name");
  assert.equal(state.asked, 0, "a sandbox HQ creates needs no look at the store");
  assert.equal(hq.company.skills.skillsOffAt(cid), hq.clock.now().toISOString(), "recorded, with the injected clock's time");
  // The next start finds the sandbox and its record: no flag again, and still no look at the store.
  await sessions.stop("ana");
  state.exists = true;
  backend.created.length = 0;
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "running", hq.hub.status("ana")?.session.detail ?? "");
  assert.ok(!backend.created[0].spec.args.includes("--skills"), "an existing sandbox keeps what it was made with");
  assert.equal(state.asked, 0);
});

test("a failed create leaves no record that skills are off", async (t) => {
  const { hq, sessions, backend, cid } = await setup(t);
  backend.createThrows = true;
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.equal(hq.company.skills.skillsOffAt(cid), null);
});

test("an old sandbox starts only while sbx's shared skills store is empty", async (t) => {
  // Empty: it starts, with no flag (an existing sandbox cannot take one), and nothing is recorded.
  {
    const { hq, sessions, backend, state, cid, refusals } = await setup(t, "empty");
    state.exists = true;
    await sessions.start("ana", OWNER);
    assert.equal(hq.hub.status("ana")?.session.state, "running", hq.hub.status("ana")?.session.detail ?? "");
    assert.ok(!backend.created[0].spec.args.includes("--skills"));
    assert.equal(hq.company.skills.skillsOffAt(cid), null, "HQ did not make it, so it records nothing");
    assert.equal(refusals().length, 0);
  }
  // Some, and unknown: the start is refused, audited with the caller, and nothing is created or recorded.
  const refused: [Answer, RegExp][] = [
    [
      "some",
      /^.+'s sandbox was made before HQ turned sbx's shared skills off, and that store has skills in it\. Press Recreate sandbox in Settings → Sandbox; its folder and code are kept\.$/,
    ],
    ["unknown", /^HQ couldn't read sbx's shared skills store, so it can't tell whether skills would reach .+'s sandbox\. Check that sbx is running, then start .+ again\.$/],
  ];
  for (const [answer, text] of refused) {
    const { hq, sessions, backend, state, cid, name, refusals } = await setup(t, answer);
    state.exists = true;
    const files = JSON.stringify(hq.hub.cfg("ana"));
    await sessions.start("ana", OWNER);
    const st = hq.hub.status("ana")!.session;
    assert.equal(st.state, "failed", answer);
    assert.match(st.detail ?? "", text, answer);
    assert.deepEqual(
      refusals().map((r) => [r.actorKind, r.actorId, r.target, r.data.reason]),
      [["human", "owner", cid, "shared-skills"]],
      answer,
    );
    assert.equal(backend.live.has(name("ana")), false, "no session was created");
    assert.equal(backend.created.length, 0, answer);
    assert.equal(hq.company.skills.skillsOffAt(cid), null, "no record was written");
    assert.equal(hq.company.secrets.hasLive(cid), false, "no live secret is left behind");
    assert.equal(JSON.stringify(hq.hub.cfg("ana")), files, "the agent's settings are unchanged");
  }
});

test("a start that cannot read sbx's sandbox list is refused, never taken for a new sandbox", async (t) => {
  for (const ls of ["fail", "timeout", "garbage"] as const) {
    for (const exists of [false, true]) {
      const { hq, sessions, backend, state, cid, name, refusals } = await setup(t, "empty", { realLs: true });
      state.ls = ls;
      state.exists = exists; // whatever is really there, HQ cannot see it
      await sessions.start("ana", OWNER);
      const why = `${ls}, sandbox ${exists ? "exists" : "absent"}`;
      const st = hq.hub.status("ana")!.session;
      assert.equal(st.state, "failed", why);
      const who = hq.hub.cfg("ana")!.name;
      assert.equal(st.detail, `HQ couldn't read sbx's sandbox list, so it can't tell whether ${who}'s sandbox is new. Check that sbx is running, then start ${who} again.`, why);
      assert.deepEqual(
        refusals().map((r) => [r.actorKind, r.actorId, r.target, r.data.reason]),
        [["human", "owner", cid, "shared-skills"]],
        why,
      );
      assert.equal(backend.created.length, 0, why);
      assert.equal(backend.live.has(name("ana")), false, why);
      assert.equal(hq.company.skills.skillsOffAt(cid), null, `no record: ${why}`);
      assert.equal(hq.company.secrets.hasLive(cid), false, `no live secret: ${why}`);
      assert.equal(state.asked, 0, why);
    }
  }
});

test("a start that cannot read sbx's sandbox list is refused even when HQ holds a record", async (t) => {
  // A record says HQ made a sandbox once; it does not say the sandbox is still there. If it was removed by
  // hand, `sbx run` would create a new one with the shared store on.
  const { hq, sessions, backend, state, cid, refusals } = await setup(t, "empty", { realLs: true });
  hq.company.skills.recordSkillsOff(cid);
  state.ls = "fail";
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.deepEqual(refusals().map((r) => r.data.reason), ["shared-skills"]);
  assert.equal(backend.created.length, 0);
});

test("a readable sbx sandbox list decides: listed means existing, not listed means new", async (t) => {
  const absent = await setup(t, "some", { realLs: true });
  await absent.sessions.start("ana", OWNER);
  assert.equal(absent.hq.hub.status("ana")?.session.state, "running", absent.hq.hub.status("ana")?.session.detail ?? "");
  assert.ok(absent.backend.created[0].spec.args.includes("--skills"));
  const listed = await setup(t, "empty", { realLs: true });
  listed.state.exists = true;
  await listed.sessions.start("ana", OWNER);
  assert.equal(listed.hq.hub.status("ana")?.session.state, "running", listed.hq.hub.status("ana")?.session.detail ?? "");
  assert.ok(!listed.backend.created[0].spec.args.includes("--skills"));
});

test("an old sandbox that HQ made with skills off starts whatever the store holds", async (t) => {
  const { hq, sessions, state, cid } = await setup(t, "some");
  hq.company.skills.recordSkillsOff(cid);
  state.exists = true;
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "running", hq.hub.status("ana")?.session.detail ?? "");
  assert.equal(state.asked, 0);
});

test("recreating a sandbox records skills off", async (t) => {
  const { hq, sessions, backend, state, cid } = await setup(t, "some");
  hq.company.skills.recordSkillsOff(cid);
  state.exists = true;
  const first = hq.company.skills.skillsOffAt(cid);
  hq.clock.advance(60_000);
  await sessions.recreate("ana");
  assert.equal(hq.hub.status("ana")?.session.state, "running", hq.hub.status("ana")?.session.detail ?? "");
  assert.deepEqual(state.removed, [`hq-${hq.slug}-ana`]);
  const args = backend.created[0].spec.args;
  assert.equal(args[args.indexOf("--skills") + 1], "off");
  const now = hq.company.skills.skillsOffAt(cid);
  assert.equal(now, hq.clock.now().toISOString());
  assert.notEqual(now, first, "the record is of the new sandbox");
  // No size changed, so the line says only that the sandbox is recreated.
  const name = hq.hub.cfg("ana")!.name;
  assert.ok(hq.hub.snap.activity.some((e) => e.text === `Recreating ${name}'s sandbox`), JSON.stringify(hq.hub.snap.activity.map((e) => e.text)));
});

test("a start refused for sbx's shared skills recovers with Recreate sandbox", async (t) => {
  const { hq, sessions, backend, state, cid } = await setup(t, "some");
  state.exists = true;
  await sessions.start("ana", OWNER);
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.match(hq.hub.status("ana")?.session.detail ?? "", /Settings → Sandbox/);
  await sessions.recreate("ana");
  assert.equal(hq.hub.status("ana")?.session.state, "running", hq.hub.status("ana")?.session.detail ?? "");
  assert.equal(backend.created[0].spec.args[backend.created[0].spec.args.indexOf("--skills") + 1], "off");
  assert.equal(hq.company.skills.skillsOffAt(cid), hq.clock.now().toISOString());
});

test("a removed sandbox's record is cleared", async (t) => {
  const { hq, sessions, state, cid } = await setup(t);
  hq.company.skills.recordSkillsOff(cid);
  state.exists = true;
  await sessions.removeResources("ana", { deleteSandbox: true, deleteFolder: false });
  assert.equal(hq.company.skills.skillsOffAt(cid), null);
});

test("Sbx.sharedSkills reads `sbx skills ls`: empty, some, or unknown", async (t) => {
  const hq = await makeHq(t);
  const ask = async (r: Partial<RunResult>) => {
    const calls: string[][] = [];
    const exec = async (_c: string, args: string[]): Promise<RunResult> => {
      calls.push(args);
      return { ok: true, code: 0, stdout: "", stderr: "", ...r };
    };
    return { answer: await new Sbx(hq.hub, hq.company, { exec }).sharedSkills(), calls };
  };
  const empty = await ask({ stdout: "No skills found.\n" });
  assert.equal(empty.answer, "empty");
  assert.deepEqual(empty.calls, [["skills", "ls"]]);
  assert.equal((await ask({ stdout: "NAME  SOURCE\nfrontend-design  local\n" })).answer, "some");
  assert.equal((await ask({ ok: false, code: 1, stderr: "daemon is not running" })).answer, "unknown", "a failed run");
  assert.equal((await ask({ ok: false, code: null, stderr: "Command failed: timed out" })).answer, "unknown", "a timeout");
  assert.equal((await ask({ ok: false, code: 1, stdout: "No skills found.\n" })).answer, "unknown", "a failed run is never empty");
  assert.equal((await ask({ stdout: "  \n" })).answer, "unknown", "no output at all is not an answer");
});

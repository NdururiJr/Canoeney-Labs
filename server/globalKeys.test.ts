// SR-E-05: no sandbox key with global scope gives a consequential power (M0-E Task 3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCommands } from "./commands";
import type { CommandCtx } from "./dashboard";
import type { RunResult } from "./lib/exec";
import { Sbx } from "./sbx";
import { checkGithubSecret } from "./setup";
import { makeHq, OWNER_PIN, type Hq } from "./testing/hqFixture";
import { withSessions } from "./testing/sessionFixture";

const OWNER: CommandCtx = { actor: { kind: "human", id: "owner" }, role: "owner", remote: false, sessionId: "s1" };
const stub = () => new Proxy({} as Record<string, unknown>, { get: () => async () => {} }) as never;

/** A fake sbx: `secret ls` lists `keys`; every call is recorded. */
function fakeSbx(hq: Hq, keys: { scope: string; name: string }[] = []) {
  const calls: string[][] = [];
  const exec = async (_cmd: string, args: string[]): Promise<RunResult> => {
    calls.push(args);
    if (args[0] === "secret" && args[1] === "ls") return { ok: true, code: 0, stdout: JSON.stringify({ secrets: keys.map((k) => ({ ...k, type: "service" })) }), stderr: "" };
    return { ok: true, code: 0, stdout: "[]", stderr: "" };
  };
  return { sbx: new Sbx(hq.hub, hq.company, { exec }), calls };
}

async function withCommands(t: Parameters<typeof makeHq>[0], keys: { scope: string; name: string }[] = []) {
  const hq = await makeHq(t);
  await hq.enroll();
  hq.hub.snap.setup = { ...hq.hub.snap.setup, sandboxReady: true };
  const fake = fakeSbx(hq, keys);
  const commands = makeCommands(hq.hub, stub(), hq.planner, hq.inbox, fake.sbx, stub(), hq.company);
  return { hq, ...fake, commands };
}

test("SR-E-05 [T-S3.1] a github key for every sandbox is refused", async (t) => {
  const { hq, calls } = await withCommands(t);
  const { Dashboard } = await import("./dashboard");
  const fake = fakeSbx(hq);
  const d = new Dashboard(makeCommands(hq.hub, stub(), hq.planner, hq.inbox, fake.sbx, stub(), hq.company), { ownerAuth: hq.ownerAuth, audit: hq.company.audit, clock: hq.clock });
  const r = await d.dispatch(OWNER, { cmd: "setSecret", args: [null, "github", "ghp_notarealtokenvalue1234567890"], pin: OWNER_PIN });
  assert.equal(r.ok, false);
  assert.match((r as { message?: string }).message ?? "", /own GitHub identity/);
  const refused = hq.company.audit.query({ action: "settings.refused" });
  assert.equal(refused.length, 1);
  assert.deepEqual([refused[0].actorId, refused[0].data.service, refused[0].data.scope], ["owner", "github", "global"]);
  assert.equal(JSON.stringify(refused).includes("ghp_"), false);
  assert.equal([...calls, ...fake.calls].some((c) => c[0] === "secret" && c[1] === "set"), false, "sbx was never asked to store it");
});

test("SR-E-05 [T-S3.1] with a global github key present, the startup check reports it and no agent starts", async (t) => {
  // The setup check: a global github key is a problem, with the command that removes it.
  const exec = async (_c: string, args: string[]): Promise<RunResult> => ({ ok: true, code: 0, stdout: JSON.stringify({ secrets: [{ name: "github", scope: "global", type: "service" }] }), stderr: "" + args.length * 0 });
  const check = await checkGithubSecret(true, exec);
  assert.equal(check.status, "missing");
  assert.match(check.detail, /every sandbox/);
  assert.equal(check.fix?.command, "sbx secret rm github --force");
  const clean = await checkGithubSecret(true, async () => ({ ok: true, code: 0, stdout: JSON.stringify({ secrets: [{ name: "github", scope: "hq-site-ana", type: "service" }] }), stderr: "" }));
  assert.equal(clean.status, "ok", "an agent's own github key is not a global one");

  // No agent starts while it exists.
  const hq = await makeHq(t);
  const s = withSessions(t, hq);
  hq.hub.snap.setup = { ...hq.hub.snap.setup, sandboxReady: true };
  hq.hub.cfg("ana")!.mode = "sandbox";
  Object.assign(s.sessions as unknown as Record<string, unknown>, { policyOk: true, sandboxState: async () => "no", whenSandboxExists: async () => false, refreshSandboxSizes: async () => {} });
  const { sbx } = fakeSbx(hq, [{ scope: "global", name: "github" }]);
  s.sessions.globalGithubKey = async () => {
    await sbx.refresh();
    return sbx.globalGithubKey();
  };
  await s.sessions.start("ana", { kind: "human", id: "owner" });
  assert.equal(hq.hub.status("ana")?.session.state, "failed");
  assert.equal(s.backend.live.has(s.name("ana")), false);
  const rows = hq.company.audit.query({ action: "workspace.refused" });
  assert.deepEqual(rows.map((r) => [r.actorId, r.data.reason]), [["owner", "global-github-key"]]);
});

test("a global model key is recorded when set or removed", async (t) => {
  const { hq, commands } = await withCommands(t);
  await commands.setSecret.run({ ...OWNER, pin: true }, null, "anthropic", "sk-ant-notarealkey000000000000000000");
  await commands.removeSecret.run(OWNER, null, "anthropic");
  const rows = hq.company.audit.query({ action: "sbx.key-changed" });
  assert.deepEqual(rows.map((r) => [r.actorId, r.data.service, r.data.scope, r.data.change]), [
    ["owner", "anthropic", "global", "set"],
    ["owner", "anthropic", "global", "removed"],
  ]);
  assert.equal(JSON.stringify(rows).includes("sk-ant"), false);
});

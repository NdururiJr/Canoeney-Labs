import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Authority } from "./company/authority";
import { FakeClock } from "./company/clock";
import { openCompany } from "./company";
import { SkillPinRefused } from "./company/companySkills";
import { seal } from "./company/sealed";
import type { AuditEventInput, AuditSink } from "./company/slots/types";
import type { GitHubApi } from "./github/api";
import { checkSkillsRepo, SkillsRepoWatch } from "./skillsRepoCheck";
import { makeSkillsRepo } from "./testing/skillsRepo";

const REPO = "NdururiJr/canoeney-skills";
const OWNER = "NdururiJr";
const NOW = "2026-11-16T08:00:00.000Z";
const HOUR = 3_600_000;

interface Setup {
  repo: { private: boolean; default_branch: string };
  rules: { type: string }[];
  collaborators: { login: string }[];
  keys: { id: number; read_only: boolean }[];
  /** An HTTP status to answer in place of the data, by what is read. */
  status: Partial<Record<"repository" | "rules" | "collaborators" | "keys", number>>;
  /** What is read, by name, throws instead of answering. */
  throws: Partial<Record<"repository" | "rules" | "collaborators" | "keys", boolean>>;
}

/** A skills repo set up as HQ wants it: private, rules on `main`, only the owner, no keys. */
function goodRepo(): Setup {
  return {
    repo: { private: true, default_branch: "main" },
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
    collaborators: [{ login: OWNER }],
    keys: [],
    status: {},
    throws: {},
  };
}

/** A fake GitHub over `r` for REPO, recording every call. */
function fake(r: Setup, repo = REPO) {
  const calls: string[] = [];
  const ok = (json: unknown) => ({ status: 200, json: json as never });
  const api: GitHubApi = {
    async request(method, path) {
      calls.push(`${method} ${path}`);
      const p = path.replace(`/repos/${repo}`, "");
      const what: keyof Setup["status"] | null = p === "" ? "repository" : p.startsWith("/rules/branches/") ? "rules" : p.startsWith("/collaborators") ? "collaborators" : p.startsWith("/keys") ? "keys" : null;
      if (what && r.throws[what]) throw new Error("gh is not installed");
      const status = what ? r.status[what] : undefined;
      if (status !== undefined) return { status, json: { message: "no" } as never };
      if (method !== "GET") return { status: 405, json: null };
      if (what === "repository") return ok(r.repo);
      if (what === "rules") return ok(r.rules);
      if (what === "collaborators") return ok(r.collaborators);
      if (what === "keys") return ok(r.keys);
      return { status: 404, json: null };
    },
  };
  return { api, calls };
}

const names = async (r: Setup, agents: { id: string; installed: boolean | "unknown" }[] = []) =>
  (await checkSkillsRepo(fake(r).api, REPO, { owner: OWNER, agents })).map((f) => f.name);

test("a skills repo set up as HQ wants it has no findings, and only five GETs are made", async () => {
  const f = fake(goodRepo());
  assert.deepEqual(await checkSkillsRepo(f.api, REPO, { owner: OWNER, agents: [{ id: "p/ana", installed: false }] }), []);
  assert.deepEqual(f.calls, [
    `GET /repos/${REPO}`,
    `GET /repos/${REPO}/rules/branches/main`,
    `GET /repos/${REPO}/collaborators?per_page=100`,
    `GET /repos/${REPO}/keys?per_page=100`,
  ]);
});

test("SR-F-08 [T-S12.8] an agent App installed on the skills repo is a finding", async () => {
  const agents = [
    { id: "site/ana", installed: true },
    { id: "site/bo", installed: false },
  ];
  const r = await checkSkillsRepo(fake(goodRepo()).api, REPO, { owner: OWNER, agents });
  assert.deepEqual(r.map((f) => f.name), ["skills-app-installed:site/ana"]);
  assert.equal(r[0].fixable, false);
  assert.match(r[0].detail, /site\/ana/);
});

test("SR-F-08 [T-S12.8] a second collaborator is a finding", async () => {
  const r = goodRepo();
  r.collaborators = [{ login: "ndururijr" }, { login: "ana-bot" }, { login: "someone" }];
  assert.deepEqual(await names(r), ["skills-collaborator:ana-bot", "skills-collaborator:someone"]);
  // The owner alone, in any letter case, is not one.
  r.collaborators = [{ login: "NDURURIJR" }];
  assert.deepEqual(await names(r), []);
});

test("SR-F-08 [T-S12.8] a deploy key with write access is a finding, and a read-only key is not", async () => {
  const r = goodRepo();
  r.keys = [
    { id: 11, read_only: true },
    { id: 12, read_only: false },
  ];
  assert.deepEqual(await names(r), ["skills-deploy-key:12"]);
  r.keys = [{ id: 11, read_only: true }];
  assert.deepEqual(await names(r), []);
});

test("SR-F-08 [T-S12.8] a missing deletion or non-fast-forward rule is a finding", async () => {
  const r = goodRepo();
  r.rules = [{ type: "non_fast_forward" }];
  assert.deepEqual(await names(r), ["skills-rules-missing:deletion"]);
  r.rules = [{ type: "deletion" }];
  assert.deepEqual(await names(r), ["skills-rules-missing:non_fast_forward"]);
  r.rules = [{ type: "pull_request" }];
  assert.deepEqual(await names(r), ["skills-rules-missing:deletion", "skills-rules-missing:non_fast_forward"]);
});

test("SR-F-08 [T-S12.8] a private repo whose rules GitHub will not read (403) is a finding", async () => {
  const r = goodRepo();
  r.status.rules = 403;
  assert.deepEqual(await names(r), ["skills-private-unprotected"]);
  // A public repo's rules are always readable, so a 403 there is only a failed read.
  r.repo.private = false;
  assert.deepEqual(await names(r), ["read-failed:rules"]);
  // A public repo with its rules is fine.
  r.status.rules = undefined;
  assert.deepEqual(await names(r), []);
});

test("a failed read is a read-failed finding, never a pass", async () => {
  for (const what of ["repository", "rules", "collaborators", "keys"] as const) {
    for (const status of [401, 404, 500, 0]) {
      const r = goodRepo();
      r.status[what] = status;
      const out = await checkSkillsRepo(fake(r).api, REPO, { owner: OWNER, agents: [] });
      // A private repo's 403 on rules is its own finding; every other read is read-failed.
      assert.deepEqual(out.map((f) => f.name), [`read-failed:${what}`], `${what} ${status}`);
      assert.match(out[0].detail, new RegExp(REPO));
      assert.equal(out[0].fixable, false);
    }
    // A request that throws (gh missing, offline) is the same.
    const r = goodRepo();
    r.throws[what] = true;
    assert.deepEqual(await names(r), [`read-failed:${what}`], `${what} throws`);
  }
  // An App HQ could not look up is a finding, not a pass.
  assert.deepEqual(await names(goodRepo(), [{ id: "site/ana", installed: "unknown" }]), ["read-failed:app:site/ana"]);
  // A repo that names no default branch cannot have its rules read.
  const r = goodRepo();
  r.repo.default_branch = "";
  assert.deepEqual(await names(r), ["read-failed:repository"]);
});

/** A sink that keeps the rows. */
function sink() {
  const rows: AuditEventInput[] = [];
  const audit = { append: (e: AuditEventInput) => void rows.push(e) } as unknown as AuditSink;
  return { rows, audit };
}

function watchOf(r: Setup, o: { repo?: string | null; agents?: { id: string; installed: boolean | "unknown" }[] } = {}) {
  const clock = new FakeClock(NOW);
  const s = sink();
  const f = fake(r);
  const lines: string[] = [];
  const states: unknown[] = [];
  const watch = new SkillsRepoWatch({
    api: f.api,
    clock,
    audit: s.audit,
    repo: () => (o.repo === undefined ? REPO : o.repo),
    agents: async () => o.agents ?? [],
  });
  watch.notify = (text) => void lines.push(text);
  watch.report = (state) => void states.push(state);
  return { watch, clock, rows: s.rows, lines, states, calls: f.calls };
}

test("a new finding writes one skills.repo-findings row and one activity line, once per finding", async () => {
  const r = goodRepo();
  const w = watchOf(r);
  await w.watch.check(REPO);
  assert.equal(w.rows.length, 0, "a clean repo writes nothing");
  r.collaborators.push({ login: "ana-bot" });
  await w.watch.check(REPO);
  await w.watch.check(REPO);
  r.keys.push({ id: 7, read_only: false });
  await w.watch.check(REPO);
  const rows = w.rows.filter((x) => x.action === "skills.repo-findings");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].data, { repo: REPO, findings: ["skills-collaborator:ana-bot"] });
  assert.deepEqual(rows[1].data, { repo: REPO, findings: ["skills-deploy-key:7"] });
  assert.deepEqual([rows[0].actorKind, rows[0].actorId, rows[0].target], ["hq", "hq", REPO]);
  assert.equal(w.lines.filter((l) => /ana-bot/.test(l)).length, 1);
  assert.equal(w.lines.length, 2);
  // A finding the owner fixed and that comes back is new again.
  r.collaborators.pop();
  await w.watch.check(REPO);
  r.collaborators.push({ login: "ana-bot" });
  await w.watch.check(REPO);
  assert.equal(w.rows.filter((x) => x.action === "skills.repo-findings").length, 3);
  // Every check reports its whole result, and its time comes from the clock.
  const last = w.states.at(-1) as { repo: string; checkedAt: string; findings: { name: string }[] };
  assert.equal(last.repo, REPO);
  assert.equal(last.checkedAt, NOW);
  assert.deepEqual(last.findings.map((f) => f.name), ["skills-collaborator:ana-bot", "skills-deploy-key:7"]);
  assert.deepEqual(w.watch.state(), last);
});

test("the check runs again 24 hours after HQ starts", async () => {
  const w = watchOf(goodRepo());
  const runs = () => w.calls.filter((c) => c === `GET /repos/${REPO}`).length;
  await w.watch.start();
  try {
    assert.equal(runs(), 1, "it runs when HQ starts");
    w.clock.advance(23 * HOUR + 59 * 60_000);
    await w.watch.tick();
    assert.equal(runs(), 1, "not before 24 hours");
    w.clock.advance(60_000);
    await w.watch.tick();
    assert.equal(runs(), 2, "24 hours after the start");
    await w.watch.tick();
    assert.equal(runs(), 2, "once per day");
    w.clock.advance(24 * HOUR);
    await w.watch.tick();
    assert.equal(runs(), 3);
  } finally {
    w.watch.stop();
  }
});

test("the daily check does nothing before a skills repo is pinned, and the state stays null", async () => {
  const w = watchOf(goodRepo(), { repo: null });
  try {
    await w.watch.start();
  } finally {
    w.watch.stop();
  }
  assert.deepEqual(w.calls, []);
  assert.equal(w.watch.state(), null);
});

test("a check at pin time and the daily check report a finding once between them", async () => {
  const r = goodRepo();
  r.collaborators.push({ login: "ana-bot" });
  const w = watchOf(r);
  await w.watch.check(REPO);
  try {
    await w.watch.start();
  } finally {
    w.watch.stop();
  }
  assert.equal(w.rows.filter((x) => x.action === "skills.repo-findings").length, 1);
});

// ------------------------------------------------ production wiring (Ruling C)

const PIN: Authority = { via: "pin", humanId: "owner" };

test("SR-F-08 [T-S12.8] a pin through the production wiring is refused while the check has a finding", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hq-skillscheck-"));
  const origin = makeSkillsRepo(root);
  const sha = origin.commit({ "skills/alpha/SKILL.md": "alpha" });
  const r = goodRepo();
  r.collaborators.push({ login: "ana-bot" });
  const company = openCompany({
    home: join(root, "company home"),
    repoRoot: null,
    clock: new FakeClock(NOW),
    ownerGh: fake(r, "NdururiJr/canoeney-skills").api,
    skills: { urlFor: () => origin.url, allowFile: true },
  });
  t.after(() => company.close());
  // After the store closes: the folder holds its open file.
  t.after(() => rmSync(root, { recursive: true, force: true }));
  company.db.prepare("INSERT INTO humans(id, display_name, role, created_at) VALUES ('owner', 'owner', 'owner', ?)").run(NOW);

  // The preview shows the finding (the owner's gh read it), and the pin is refused.
  const preview = await company.skills.preview(REPO, sha, PIN);
  assert.deepEqual(preview.findings.map((f) => f.name), ["skills-collaborator:ana-bot"]);
  await assert.rejects(() => company.skills.pin(REPO, sha, preview.lockHash, PIN), (e: unknown) => e instanceof SkillPinRefused && e.reason === "repo-check");
  const refused = company.audit.query({ action: "skills.pin-refused" });
  assert.deepEqual([refused.at(-1)?.actorId, refused.at(-1)?.data.reason], ["owner", "repo-check"]);
  assert.equal(company.skills.source(), null, "nothing was pinned");
  assert.ok(company.audit.query({ action: "skills.repo-findings" }).length >= 1, "the finding was audited");
  assert.deepEqual(company.skillsWatch.state()?.findings.map((f) => f.name), ["skills-collaborator:ana-bot"]);

  // The owner removes the collaborator on GitHub: the same pin goes through.
  r.collaborators.pop();
  await company.skills.pin(REPO, sha, preview.lockHash, PIN);
  assert.equal(company.skills.source()?.commit, sha);
});

/** A company with one agent that has a GitHub App (a real, sealed key) and a skills repo behind a local path. */
function withApp(t: { after(fn: () => void): void }, o: { sealedKey: boolean; app: GitHubApi }) {
  const root = mkdtempSync(join(tmpdir(), "hq-skillscheck-"));
  const origin = makeSkillsRepo(root);
  const sha = origin.commit({ "skills/alpha/SKILL.md": "alpha" });
  const home = join(root, "company home");
  const company = openCompany({ home, repoRoot: null, clock: new FakeClock(NOW), githubApi: o.app, ownerGh: fake(goodRepo()).api, skills: { urlFor: () => origin.url, allowFile: true } });
  t.after(() => company.close());
  // After the store closes: the folder holds its open file.
  t.after(() => rmSync(root, { recursive: true, force: true }));
  company.db.prepare("INSERT INTO humans(id, display_name, role, created_at) VALUES ('owner', 'owner', 'owner', ?)").run(NOW);
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const sealed = o.sealedKey ? seal(join(home, "owner.key"), Buffer.from(pem)) : "v1:broken:broken:broken";
  company.agents.ensureProject({ slug: "site", name: "site", root: join(root, "no repo"), github: "acme/site" });
  company.agents.register("site", { id: "ana", name: "Ana", cli: "claude" }, "builder", { kind: "hq", id: "hq" }, "import");
  company.db
    .prepare("INSERT INTO agent_github_apps(agent_id, app_id, slug, bot_user_id, key_sealed, installation_id, created_at) VALUES ('site/ana', 9, 'ana-app', 10, ?, NULL, ?)")
    .run(sealed, NOW);
  return { company, sha };
}

test("SR-F-08 [T-S12.8] an agent App installed on the skills repo refuses the pin through the production wiring", async (t) => {
  const seen: string[] = [];
  const app: GitHubApi = {
    async request(_m, path, o) {
      seen.push(`${path} ${o?.jwt ? "jwt" : "no-jwt"}`);
      return path === `/repos/${REPO}/installation` ? { status: 200, json: { id: 5, repository_selection: "selected" } as never } : { status: 404, json: null };
    },
  };
  const { company, sha } = withApp(t, { sealedKey: true, app });
  const preview = await company.skills.preview(REPO, sha, PIN);
  assert.deepEqual(preview.findings.map((f) => f.name), ["skills-app-installed:site/ana"]);
  assert.deepEqual(seen, [`/repos/${REPO}/installation jwt`]);
  await assert.rejects(() => company.skills.pin(REPO, sha, preview.lockHash, PIN), (e: unknown) => e instanceof SkillPinRefused && e.reason === "repo-check");
  assert.equal(company.skills.source(), null);

  // The App that is not installed (GitHub answers 404) is no finding.
  const none = withApp(t, { sealedKey: true, app: { async request() { return { status: 404, json: null }; } } });
  const p2 = await none.company.skills.preview(REPO, none.sha, PIN);
  assert.deepEqual(p2.findings, []);
});

test("SR-F-08 [T-S12.8] an App HQ cannot look up is a finding, not a pass", async (t) => {
  const { company, sha } = withApp(t, { sealedKey: false, app: { async request() { return { status: 404, json: null }; } } });
  const preview = await company.skills.preview(REPO, sha, PIN);
  assert.deepEqual(preview.findings.map((f) => f.name), ["read-failed:app:site/ana"]);
  await assert.rejects(() => company.skills.pin(REPO, sha, preview.lockHash, PIN), (e: unknown) => e instanceof SkillPinRefused && e.reason === "repo-check");
});

test("SR-F-08 [T-S12.8] an App lookup that fails with 401, 403, 500 or no answer is a finding, never 'not installed'", async (t) => {
  for (const status of [401, 403, 500, 0]) {
    const { company, sha } = withApp(t, { sealedKey: true, app: { async request() { return { status, json: { message: "no" } as never }; } } });
    const refusedBefore = company.audit.query({ action: "skills.pin-refused" }).length;
    const preview = await company.skills.preview(REPO, sha, PIN);
    assert.deepEqual(preview.findings.map((f) => f.name), ["read-failed:app:site/ana"], `HTTP ${status}`);
    await assert.rejects(() => company.skills.pin(REPO, sha, preview.lockHash, PIN), (e: unknown) => e instanceof SkillPinRefused && e.reason === "repo-check", `HTTP ${status}`);
    const refused = company.audit.query({ action: "skills.pin-refused" });
    assert.equal(refused.length, refusedBefore + 1, `HTTP ${status}: one refusal row`);
    assert.deepEqual([refused.at(-1)?.actorId, refused.at(-1)?.data.reason], ["owner", "repo-check"]);
    assert.equal(company.skills.source(), null, `HTTP ${status}: nothing was pinned`);
  }
  // An answer that is a real 404 stays "not installed" and the pin goes through.
  const ok = withApp(t, { sealedKey: true, app: { async request() { return { status: 404, json: null }; } } });
  const p = await ok.company.skills.preview(REPO, ok.sha, PIN);
  await ok.company.skills.pin(REPO, ok.sha, p.lockHash, PIN);
  assert.equal(ok.company.skills.source()?.commit, ok.sha);
});

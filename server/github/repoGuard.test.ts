import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitHubApi } from "./api";
import { applyRepoGuard, checkRepo, desiredRulesets, mainProtection, RepoWatch, type GuardAgent } from "./repoGuard";
import { scanWorkflow } from "./workflowScan";

const REPO = "acme/site";
const AGENTS: GuardAgent[] = [{ id: "ana", appId: 101, installed: true, selection: "selected" }];
const D1 = ["CLAUDE.md", "AGENTS.md", "ROLE.md", ".claude/", ".mcp.json", ".agents/", ".codex/", ".github/"];
/** CODEOWNERS takes one pattern per line. */
const OWNERS = ["* @acme", ...D1.map((p) => `${p} @acme`)].join("\n") + "\n";

/** A repo whose settings are all as HQ wants them; each test spoils one. */
function goodRepo() {
  const rulesets = desiredRulesets(AGENTS).map((r, i) => ({ id: i + 1, ...r }));
  return {
    repo: { private: false, allow_auto_merge: false },
    protection: mainProtection() as Record<string, unknown> | null,
    rulesets,
    actions: { enabled: true, allowed_actions: "selected" },
    selected: { github_owned_allowed: true, verified_allowed: false, patterns_allowed: [] as string[] },
    workflow: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
    secrets: 0,
    runners: 0,
    codeowners: OWNERS as string | null,
    workflows: {} as Record<string, string>,
  };
}
type Repo = ReturnType<typeof goodRepo>;

/** A fake GitHub over `r`, recording every call. */
function fake(r: Repo) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const ok = (json: unknown) => ({ status: 200, json: json as never });
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const api: GitHubApi = {
    async request(method, path, o = {}) {
      calls.push({ method, path, body: o.body });
      const p = path.replace(`/repos/${REPO}`, "");
      if (method !== "GET") return { status: 200, json: {} as never };
      if (p === "") return ok({ ...r.repo, visibility: r.repo.private ? "private" : "public" });
      if (p === "/branches/main/protection") return r.protection ? ok(r.protection) : { status: 404, json: null };
      if (p === "/rulesets") return ok(r.rulesets.map(({ id, name }) => ({ id, name })));
      const rs = p.match(/^\/rulesets\/(\d+)$/);
      if (rs) return ok(r.rulesets.find((x) => x.id === Number(rs[1])));
      if (p === "/actions/permissions") return ok(r.actions);
      if (p === "/actions/permissions/selected-actions") return ok(r.selected);
      if (p === "/actions/permissions/workflow") return ok(r.workflow);
      if (p === "/actions/secrets") return ok({ total_count: r.secrets, secrets: [] });
      if (p === "/actions/runners") return ok({ total_count: r.runners, runners: [] });
      if (p === "/contents/CODEOWNERS" || p === "/contents/.github/CODEOWNERS" || p === "/contents/docs/CODEOWNERS")
        return r.codeowners !== null && p === "/contents/.github/CODEOWNERS" ? ok({ content: b64(r.codeowners), encoding: "base64" }) : { status: 404, json: null };
      if (p === "/contents/.github/workflows") return Object.keys(r.workflows).length ? ok(Object.keys(r.workflows).map((name) => ({ name, path: `.github/workflows/${name}`, type: "file" }))) : { status: 404, json: null };
      const wf = p.match(/^\/contents\/\.github\/workflows\/(.+)$/);
      if (wf && r.workflows[wf[1]] !== undefined) return ok({ content: b64(r.workflows[wf[1]]), encoding: "base64" });
      return { status: 404, json: null };
    },
  };
  return { api, calls };
}

const names = async (r: Repo, o: Partial<Parameters<typeof checkRepo>[2]> = {}) =>
  (await checkRepo(fake(r).api, REPO, { agents: AGENTS, spendingConfirmed: false, ...o })).map((f) => f.name);

test("a repo set up as HQ wants it has no findings", async () => {
  assert.deepEqual(await names(goodRepo()), []);
});

test("SR-E-09 [T-S9.6] each bad setting is reported by name", async () => {
  const cases: [string, (r: Repo) => void][] = [
    ["workflow-token-write", (r) => (r.workflow.default_workflow_permissions = "write")],
    ["actions-unrestricted", (r) => (r.actions.allowed_actions = "all")],
    ["repo-secrets", (r) => (r.secrets = 1)],
    ["self-hosted-runner", (r) => (r.runners = 1)],
    ["admins-not-enforced", (r) => ((r.protection as { enforce_admins: { enabled: boolean } }).enforce_admins.enabled = false)],
    ["codeowners-path:.codex/", (r) => (r.codeowners = OWNERS.replace(".codex/ @acme\n", ""))],
  ];
  for (const [want, spoil] of cases) {
    const r = goodRepo();
    spoil(r);
    assert.deepEqual(await names(r), [want], want);
  }
});

test("SR-E-03 [T-S3.3] the settings check asserts code-owner review, no bypass actors, and that Actions cannot approve PRs", async () => {
  const pr = (r: Repo) => (r.protection as { required_pull_request_reviews: Record<string, unknown> }).required_pull_request_reviews;
  const cases: [string, (r: Repo) => void][] = [
    ["code-owner-review-off", (r) => (pr(r).require_code_owner_reviews = false)],
    ["bypass-allowance", (r) => (pr(r).bypass_pull_request_allowances = { users: [{ login: "someone" }], teams: [], apps: [] })],
    ["actions-approve-prs", (r) => (r.workflow.can_approve_pull_request_reviews = true)],
    ["agent-ruleset-missing:ana", (r) => (r.rulesets = r.rulesets.filter((x) => x.name !== "hq-agent-ana"))],
    ["agent-ruleset-bypass:ana", (r) => (r.rulesets.find((x) => x.name === "hq-agent-ana")!.bypass_actors.push({ actor_id: 999, actor_type: "Integration", bypass_mode: "always" }))],
    ["main-ruleset-missing", (r) => (r.rulesets = r.rulesets.filter((x) => x.name !== "hq-main"))],
  ];
  for (const [want, spoil] of cases) {
    const r = goodRepo();
    spoil(r);
    assert.deepEqual(await names(r), [want], want);
  }
});

test("SR-E-01 [T-S3.1] auto-merge on is a finding, and the guard turns it off", async () => {
  const r = goodRepo();
  r.repo.allow_auto_merge = true;
  assert.deepEqual(await names(r), ["auto-merge-on"]);
  const f = fake(r);
  await applyRepoGuard(f.api, REPO, { agents: AGENTS, spendingConfirmed: false });
  assert.ok(f.calls.some((c) => c.method === "PATCH" && c.path === `/repos/${REPO}` && (c.body as { allow_auto_merge?: boolean }).allow_auto_merge === false));
});

test("SR-E-11 [T-S9.3 T-S9.4] a privileged trigger or a tag-pinned action is a finding", () => {
  const sha = "a".repeat(40);
  for (const trigger of ["pull_request_target", "workflow_run", "issue_comment"]) {
    assert.deepEqual(scanWorkflow(".github/workflows/x.yml", `on:\n  ${trigger}:\njobs: {}\n`).map((f) => f.name), [`workflow-trigger:x.yml:${trigger}`], trigger);
  }
  assert.deepEqual(scanWorkflow(".github/workflows/x.yml", "on: [pull_request_target]\n").map((f) => f.name), ["workflow-trigger:x.yml:pull_request_target"]);
  assert.deepEqual(scanWorkflow(".github/workflows/x.yml", "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n").map((f) => f.name), ["workflow-unpinned:x.yml:actions/checkout@v4"]);
  assert.deepEqual(scanWorkflow(".github/workflows/x.yml", `on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@${sha}\n      - uses: ./local-action\n`), []);
});

test("SR-E-11 [T-S9.3] the repo check scans every workflow file", async () => {
  const r = goodRepo();
  r.workflows["ci.yml"] = "on: [push]\njobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n";
  assert.deepEqual(await names(r), ["workflow-unpinned:ci.yml:actions/setup-node@v4"]);
});

test("SR-E-14 [T-S9.5] a public repo reports the spending limit as not applicable; a private one is a finding until the owner confirms its limit with the PIN", async () => {
  const r = goodRepo();
  assert.deepEqual(await names(r), []);
  r.repo.private = true;
  assert.deepEqual(await names(r), ["spending-limit-unconfirmed"]);
  assert.deepEqual(await names(r, { spendingConfirmed: true }), []);
});

test("an App installed on all repositories is a finding", async () => {
  assert.deepEqual(await names(goodRepo(), { agents: [{ ...AGENTS[0], selection: "all" }] }), ["app-all-repositories:ana"]);
});

test("an App that is not installed yet is a finding, and its ruleset waits for it", async () => {
  const notYet: GuardAgent[] = [{ id: "ana", appId: 101, installed: false, selection: null }];
  const r = goodRepo();
  r.rulesets = r.rulesets.filter((x) => x.name !== "hq-agent-ana");
  r.rulesets.find((x) => x.name === "hq-unclaimed")!.conditions = desiredRulesets(notYet).find((x) => x.name === "hq-unclaimed")!.conditions;
  assert.deepEqual(await names(r, { agents: notYet }), ["app-not-installed:ana"]);
  assert.equal(desiredRulesets(notYet).some((x) => x.name === "hq-agent-ana"), false);
});

test("a repo with no main branch yet asks for the owner's first commit", async () => {
  const r = goodRepo();
  r.protection = null;
  r.codeowners = null;
  assert.deepEqual(await names(r), ["main-missing-or-unprotected", "codeowners-missing"]);
});

test("applying the guard sets only fixable settings, and never writes CODEOWNERS or workflow files", async () => {
  const r = goodRepo();
  r.repo.allow_auto_merge = true;
  r.workflow = { default_workflow_permissions: "write", can_approve_pull_request_reviews: true };
  r.rulesets = [];
  r.codeowners = null;
  const f = fake(r);
  await applyRepoGuard(f.api, REPO, { agents: AGENTS, spendingConfirmed: false });
  const writes = f.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path.replace(`/repos/${REPO}`, "")}`);
  assert.deepEqual(writes.sort(), [
    "PATCH ",
    "POST /rulesets",
    "POST /rulesets",
    "POST /rulesets",
    "POST /rulesets",
    "PUT /actions/permissions",
    "PUT /actions/permissions/selected-actions",
    "PUT /actions/permissions/workflow",
    "PUT /branches/main/protection",
  ]);
  assert.equal(f.calls.some((c) => c.path.includes("/contents/")) && f.calls.some((c) => c.method === "PUT" && c.path.includes("/contents/")), false);
});

test("drift found by the daily check is an activity line and a github.drift row, once per finding", async () => {
  const r = goodRepo();
  const rows: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const watch = new RepoWatch({
    api: fake(r).api,
    repo: REPO,
    agents: async () => AGENTS,
    spendingConfirmed: () => false,
    audit: { append: (row: Record<string, unknown>) => void rows.push(row) } as never,
    report: (findings) => void lines.push(findings.map((f) => f.name).join(",")),
    notify: (text) => void lines.push(text),
  });
  await watch.check();
  r.secrets = 2;
  await watch.check();
  await watch.check();
  r.runners = 1;
  await watch.check();
  const drift = rows.filter((x) => x.action === "github.drift").map((x) => (x.data as { findings: string[] }).findings);
  assert.deepEqual(drift, [["repo-secrets"], ["self-hosted-runner"]]);
  assert.equal(lines.filter((l) => /repository secret/.test(l)).length, 1);
});

test("applying the guard needs the PIN; a supervisor may not; the row names what it fixed", async (t) => {
  const { makeHq, OWNER_PIN } = await import("../testing/hqFixture");
  const { Dashboard } = await import("../dashboard");
  const { guardCommands } = await import("./guardCommands");
  const hq = await makeHq(t);
  await hq.enroll();
  const r = goodRepo();
  r.repo.allow_auto_merge = true;
  const f = fake(r);
  const watch = new RepoWatch({ api: f.api, repo: REPO, agents: async () => AGENTS, spendingConfirmed: () => false, audit: hq.company.audit, report: () => {}, notify: () => {} });
  const table = guardCommands({ company: hq.company, slug: hq.slug, watch, apply: () => applyRepoGuard(f.api, REPO, { agents: AGENTS, spendingConfirmed: false }).then((x) => ((r.repo.allow_auto_merge = false), x.filter((y) => y.name !== "auto-merge-on"))) });
  const d = new Dashboard(table, { ownerAuth: hq.ownerAuth, audit: hq.company.audit, clock: hq.clock });
  const owner = { actor: { kind: "human" as const, id: "owner" }, role: "owner" as const, remote: false, sessionId: "s1" };
  assert.deepEqual(await d.dispatch({ ...owner, actor: { kind: "human", id: "sup1" }, role: "supervisor" }, { cmd: "applyRepoGuard", pin: OWNER_PIN }), { ok: false, error: "forbidden" });
  assert.deepEqual(await d.dispatch(owner, { cmd: "applyRepoGuard" }), { ok: false, error: "pin-required" });
  assert.equal(f.calls.some((c) => c.method !== "GET"), false, "nothing was written before the PIN");
  assert.deepEqual(await d.dispatch(owner, { cmd: "applyRepoGuard", pin: OWNER_PIN }), { ok: true });
  const row = hq.company.audit.query({ action: "github.guard-applied" })[0];
  assert.deepEqual([row?.actorId, row?.data.fixed], ["owner", ["auto-merge-on"]]);
});

test("gh api output is read as status and JSON", async () => {
  const { ghCliApi } = await import("./api");
  const seen: string[][] = [];
  const api = ghCliApi(async (_cmd, args) => {
    seen.push(args);
    return { ok: false, stdout: 'HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"message":"Not Found"}' };
  });
  assert.deepEqual(await api.request("GET", "/repos/acme/site/branches/main/protection"), { status: 404, json: { message: "Not Found" } });
  assert.deepEqual(seen[0].slice(0, 5), ["api", "-i", "-X", "GET", "repos/acme/site/branches/main/protection"]);
  const ok = ghCliApi(async () => ({ ok: true, stdout: "HTTP/2.0 200 OK\nX: y\n\n[1,2]" }));
  assert.deepEqual(await ok.request("PUT", "/x", { body: { a: 1 } }), { status: 200, json: [1, 2] });
});

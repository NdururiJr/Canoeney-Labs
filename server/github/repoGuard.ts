// The repo guard (M0-E, SR-E-01, 02, 03, 09, 11, 14). GitHub enforces the limits
// on agents, not HQ: branch protection with the owner's code-owner review,
// rulesets so only the owner updates `main` and each agent's App alone writes
// its own branches, and Actions that run read-only and cannot approve PRs.
// HQ reads these settings when a project opens and daily, names anything that
// drifted, and applies the fixable ones with the owner's PIN. CODEOWNERS and
// workflow files are the owner's: HQ reads them, never writes them.
import type { Actor } from "../company/agents";
import type { AuditSink } from "../company/slots/types";
import type { GitHubApi } from "./api";
import { scanWorkflow } from "./workflowScan";

export interface Finding {
  name: string;
  detail: string;
  /** applyRepoGuard can set it; otherwise the owner acts on GitHub. */
  fixable: boolean;
}

export interface GuardAgent {
  id: string;
  appId: number;
  installed: boolean;
  selection: "selected" | "all" | null;
}

/** The paths D1 makes owner-reviewed, each on its own CODEOWNERS line. */
export const CODEOWNERS_PATHS = ["CLAUDE.md", "AGENTS.md", "ROLE.md", ".claude/", ".mcp.json", ".agents/", ".codex/", ".github/"];

/** The repository admin role, the only bypass besides an agent's own App. */
const ADMIN = { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" };

interface Ruleset {
  name: string;
  target: "branch";
  enforcement: "active";
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: { type: string }[];
  bypass_actors: { actor_id: number; actor_type: string; bypass_mode: string }[];
}

const rules = (...types: string[]) => types.map((type) => ({ type }));

/** The rulesets HQ wants: `main`, one per installed agent App, and every other branch. */
export function desiredRulesets(agents: GuardAgent[]): Ruleset[] {
  const installed = agents.filter((a) => a.installed);
  const branch = (include: string[], exclude: string[]) => ({ ref_name: { include, exclude } });
  return [
    { name: "hq-main", target: "branch", enforcement: "active", conditions: branch(["refs/heads/main"], []), rules: rules("update", "deletion", "non_fast_forward"), bypass_actors: [{ ...ADMIN }] },
    ...installed.map(
      (a): Ruleset => ({
        name: `hq-agent-${a.id}`,
        target: "branch",
        enforcement: "active",
        conditions: branch([`refs/heads/${a.id}/**`], []),
        // The App bypasses non-fast-forward on purpose: an agent may rebase its own branches.
        rules: rules("creation", "update", "deletion", "non_fast_forward"),
        bypass_actors: [{ actor_id: a.appId, actor_type: "Integration", bypass_mode: "always" }, { ...ADMIN }],
      }),
    ),
    {
      name: "hq-unclaimed",
      target: "branch",
      enforcement: "active",
      conditions: branch(["~ALL"], ["refs/heads/main", ...installed.map((a) => `refs/heads/${a.id}/**`)]),
      rules: rules("creation", "update"),
      bypass_actors: [{ ...ADMIN }],
    },
  ];
}

/** `main`'s branch protection as GitHub reports it when it is right. */
export function mainProtection() {
  return {
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      required_approving_review_count: 1,
      bypass_pull_request_allowances: { users: [] as unknown[], teams: [] as unknown[], apps: [] as unknown[] },
    },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
}

/** The body that sets it. */
const PROTECTION_BODY = {
  required_status_checks: null,
  enforce_admins: true,
  required_pull_request_reviews: { dismiss_stale_reviews: true, require_code_owner_reviews: true, required_approving_review_count: 1, bypass_pull_request_allowances: { users: [], teams: [], apps: [] } },
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
};

const sortedJson = (v: unknown) => JSON.stringify(v, (_k, x) => (Array.isArray(x) ? [...x].map((y) => (typeof y === "object" ? JSON.stringify(y) : y)).sort() : x));
const sameRuleBody = (a: Partial<Ruleset>, b: Ruleset) =>
  a.enforcement === b.enforcement &&
  sortedJson((a.rules ?? []).map((r) => r.type)) === sortedJson(b.rules.map((r) => r.type)) &&
  sortedJson(a.conditions?.ref_name ?? {}) === sortedJson(b.conditions.ref_name);
const sameBypass = (a: Partial<Ruleset>, b: Ruleset) =>
  sortedJson((a.bypass_actors ?? []).map((x) => ({ actor_id: x.actor_id, actor_type: x.actor_type, bypass_mode: x.bypass_mode }))) === sortedJson(b.bypass_actors);

const decode = (j: { content?: string } | null) => (j?.content ? Buffer.from(j.content, "base64").toString("utf8") : null);

export async function checkRepo(gh: GitHubApi, repo: string, o: { agents: GuardAgent[]; spendingConfirmed: boolean }): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (name: string, detail: string, fixable: boolean) => out.push({ name, detail, fixable });
  const get = <T>(path: string) => gh.request<T>("GET", `/repos/${repo}${path}`);

  const info = (await get<{ private?: boolean; allow_auto_merge?: boolean }>("")).json ?? {};
  if (info.allow_auto_merge) add("auto-merge-on", "Auto-merge is on: an agent could set its PR to merge the moment you approve it.", true);

  const prot = await get<ReturnType<typeof mainProtection>>("/branches/main/protection");
  if (prot.status !== 200 || !prot.json) {
    add("main-missing-or-unprotected", "`main` is missing or unprotected. Make the first commit (with CODEOWNERS), then apply the protection.", true);
  } else {
    const p = prot.json;
    const pr = p.required_pull_request_reviews;
    if (pr?.require_code_owner_reviews !== true) add("code-owner-review-off", "A pull request into `main` does not need your code-owner review.", true);
    if ((pr?.required_approving_review_count ?? 0) < 1) add("review-count", "A pull request into `main` needs no approving review.", true);
    if (pr && pr.dismiss_stale_reviews !== true) add("stale-reviews-kept", "An approval stays after new commits are pushed.", true);
    const bp = pr?.bypass_pull_request_allowances;
    if (bp && [bp.users, bp.teams, bp.apps].some((x) => Array.isArray(x) && x.length)) add("bypass-allowance", "Someone may bypass the pull-request rules on `main`.", true);
    if (p.enforce_admins?.enabled !== true) add("admins-not-enforced", "`main`'s protection does not apply to admins.", true);
    if (p.allow_force_pushes?.enabled) add("force-push-allowed", "`main` allows force-pushes.", true);
    if (p.allow_deletions?.enabled) add("deletion-allowed", "`main` can be deleted.", true);
  }

  const list = (await get<{ id: number; name: string }[]>("/rulesets")).json ?? [];
  const byName = new Map<string, Partial<Ruleset>>();
  for (const r of list.filter((x) => x.name.startsWith("hq-"))) byName.set(r.name, (await get<Partial<Ruleset>>(`/rulesets/${r.id}`)).json ?? {});
  for (const want of desiredRulesets(o.agents)) {
    const have = byName.get(want.name);
    const agent = want.name.startsWith("hq-agent-") ? want.name.slice("hq-agent-".length) : null;
    if (!have) {
      if (want.name === "hq-main") add("main-ruleset-missing", "No rule stops agents from updating `main`.", true);
      else if (agent) add(`agent-ruleset-missing:${agent}`, `Nothing keeps other agents off ${agent}'s branches.`, true);
      else add("unclaimed-ruleset-missing", "Agents may create branches outside their own names.", true);
      continue;
    }
    if (agent && !sameBypass(have, want)) add(`agent-ruleset-bypass:${agent}`, `Someone besides ${agent}'s App and you may write ${agent}'s branches.`, true);
    else if (!sameBypass(have, want) || !sameRuleBody(have, want)) add(`ruleset-changed:${want.name}`, `The ${want.name} rule was changed on GitHub.`, true);
  }
  for (const a of o.agents) {
    if (!a.installed) add(`app-not-installed:${a.id}`, `${a.id}'s GitHub App is not installed on ${repo}.`, false);
    else if (a.selection === "all") add(`app-all-repositories:${a.id}`, `${a.id}'s GitHub App is installed on all your repositories. Reinstall it on ${repo} only.`, false);
  }

  const actions = (await get<{ enabled?: boolean; allowed_actions?: string }>("/actions/permissions")).json ?? {};
  if (actions.enabled !== false) {
    let restricted = actions.allowed_actions === "selected";
    if (restricted) {
      const sel = (await get<{ github_owned_allowed?: boolean; verified_allowed?: boolean; patterns_allowed?: string[] }>("/actions/permissions/selected-actions")).json ?? {};
      restricted = sel.verified_allowed !== true && !(sel.patterns_allowed ?? []).length;
    }
    if (!restricted) add("actions-unrestricted", "Workflows may use any action, not only GitHub's own.", true);
  }
  const wf = (await get<{ default_workflow_permissions?: string; can_approve_pull_request_reviews?: boolean }>("/actions/permissions/workflow")).json ?? {};
  if (wf.default_workflow_permissions !== "read") add("workflow-token-write", "Workflows get a token that can write to the repo.", true);
  if (wf.can_approve_pull_request_reviews) add("actions-approve-prs", "Workflows may approve pull requests.", true);
  if (((await get<{ total_count?: number }>("/actions/secrets")).json?.total_count ?? 0) > 0) add("repo-secrets", "The repo has a repository secret, which a workflow could read. Remove it on GitHub.", false);
  if (((await get<{ total_count?: number }>("/actions/runners")).json?.total_count ?? 0) > 0) add("self-hosted-runner", "A self-hosted runner is registered. Remove it on GitHub.", false);

  let owners: string | null = null;
  for (const at of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    const r = await get<{ content?: string }>(`/contents/${at}`);
    if (r.status === 200 && (owners = decode(r.json)) !== null) break;
  }
  if (owners === null) add("codeowners-missing", "The repo has no CODEOWNERS file, so nothing needs your review.", false);
  else {
    const owner = `@${repo.split("/")[0]}`.toLowerCase();
    const owned = new Set(
      owners
        .split(/\r?\n/)
        .map((l) => l.replace(/#.*/, "").trim().split(/\s+/))
        .filter((parts) => parts.length > 1 && parts.slice(1).some((x) => x.toLowerCase() === owner))
        .map((parts) => parts[0].replace(/^\//, "")),
    );
    for (const path of ["*", ...CODEOWNERS_PATHS]) if (!owned.has(path)) add(`codeowners-path:${path}`, `CODEOWNERS does not make ${path} yours to review.`, false);
  }

  const files = await get<{ name: string; path: string; type: string }[]>("/contents/.github/workflows");
  for (const f of files.status === 200 ? (files.json ?? []) : []) {
    if (f.type !== "file" || !/\.ya?ml$/i.test(f.name)) continue;
    const text = decode((await get<{ content?: string }>(`/contents/${f.path}`)).json);
    if (text !== null) out.push(...scanWorkflow(f.path, text));
  }

  if (info.private && !o.spendingConfirmed) add("spending-limit-unconfirmed", "This private repo's Actions spending limit is not confirmed. Set it on GitHub, then confirm it in HQ.", false);
  return out;
}

/** Sets every fixable setting, then reads the repo again. CODEOWNERS and workflow files are never written. */
export async function applyRepoGuard(gh: GitHubApi, repo: string, o: { agents: GuardAgent[]; spendingConfirmed: boolean }): Promise<Finding[]> {
  const r = (method: string, path: string, body?: unknown) => gh.request(method, `/repos/${repo}${path}`, { body });
  await r("PATCH", "", { allow_auto_merge: false });
  await r("PUT", "/branches/main/protection", PROTECTION_BODY);
  const existing = new Map(((await r("GET", "/rulesets")).json as { id: number; name: string }[] | null ?? []).map((x) => [x.name, x.id]));
  for (const want of desiredRulesets(o.agents)) {
    const id = existing.get(want.name);
    if (id !== undefined) await r("PUT", `/rulesets/${id}`, want);
    else await r("POST", "/rulesets", want);
  }
  // Actions the owner turned off entirely stay off.
  const actions = (await r("GET", "/actions/permissions")).json as { enabled?: boolean } | null;
  if (actions?.enabled !== false) {
    await r("PUT", "/actions/permissions", { enabled: true, allowed_actions: "selected" });
    await r("PUT", "/actions/permissions/selected-actions", { github_owned_allowed: true, verified_allowed: false, patterns_allowed: [] });
  }
  await r("PUT", "/actions/permissions/workflow", { default_workflow_permissions: "read", can_approve_pull_request_reviews: false });
  return checkRepo(gh, repo, o);
}

const HQ: Actor = { kind: "hq", id: "hq" };

/** Checks a repo at open and daily; reports each new finding once (an activity line and a github.drift row). */
export class RepoWatch {
  private seen = new Set<string>();

  constructor(
    private readonly o: {
      api: GitHubApi;
      repo: string;
      agents: () => Promise<GuardAgent[]>;
      spendingConfirmed: () => boolean;
      audit: AuditSink;
      /** Every check's full result, for the dashboard. */
      report: (findings: Finding[]) => void;
      /** One line per new finding. */
      notify: (text: string) => void;
    },
  ) {}

  async check(): Promise<Finding[]> {
    const findings = await checkRepo(this.o.api, this.o.repo, { agents: await this.o.agents(), spendingConfirmed: this.o.spendingConfirmed() });
    this.o.report(findings);
    const fresh = findings.filter((f) => !this.seen.has(f.name));
    this.seen = new Set(findings.map((f) => f.name));
    if (fresh.length) {
      this.o.audit.append({ actorKind: HQ.kind, actorId: HQ.id, action: "github.drift", target: this.o.repo, data: { repo: this.o.repo, findings: fresh.map((f) => f.name) } });
      for (const f of fresh) this.o.notify(`GitHub protection on ${this.o.repo}: ${f.detail}`);
    }
    return findings;
  }
}

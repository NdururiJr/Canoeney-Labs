// The company skills repo's own settings (M0-F, threat model SR-F-08, T-S12.8).
// Every agent's skills come from one repo, so whoever can write to it can write
// into every agent's instructions. HQ checks, with the owner's own `gh` login,
// that only the owner can: rules on the default branch against deletion and
// non-fast-forward pushes, the owner the only collaborator, no deploy key that
// can write, and none of the agents' GitHub Apps installed on it. It reads, at
// pin time and every 24 hours from HQ's start, and writes nothing to GitHub.
//
// Not covered: GitHub Apps that belong to someone else. The owner's `gh` cannot
// list them, so the M0 exit check covers them by hand.
import type { SkillsGuardState } from "../src/data/types";
import type { Clock } from "./company/clock";
import type { AuditSink } from "./company/slots/types";
import type { GitHubApi } from "./github/api";
import type { Finding } from "./github/repoGuard";
import { log } from "./lib/log";

/** An agent that has a GitHub App, and whether that App is installed on the skills repo. */
export interface AgentInstall {
  id: string;
  /** "unknown": HQ could not look it up, which is a finding and never a pass. */
  installed: boolean | "unknown";
}

/** The rules the default branch must carry. */
const REQUIRED_RULES = ["deletion", "non_fast_forward"] as const;

const DAY_MS = 24 * 3_600_000;

export async function checkSkillsRepo(api: GitHubApi, repo: string, o: { owner: string; agents: AgentInstall[] }): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (name: string, detail: string) => out.push({ name, detail, fixable: false });
  /** A request that throws (gh missing, offline) is a read that failed, like a bad status. */
  const get = async <T>(path: string): Promise<{ status: number; json: T | null }> => {
    try {
      return await api.request<T>("GET", `/repos/${repo}${path}`);
    } catch {
      return { status: 0, json: null };
    }
  };
  /** A read HQ could not make is a finding of its own, never a false "missing" and never a silent all-clear. */
  const failed = (key: string, what: string, status: number) =>
    add(`read-failed:${key}`, `HQ couldn't read ${what} of the skills repo ${repo} (HTTP ${status || "no answer"}). Check that gh is signed in, then check again.`);

  const info = await get<{ private?: boolean; default_branch?: string }>("");
  const branch = info.status === 200 ? info.json?.default_branch : undefined;
  if (typeof branch !== "string" || branch === "") {
    failed("repository", "the settings", info.status);
  } else {
    const rules = await get<{ type?: string }[]>(`/rules/branches/${branch.split("/").map(encodeURIComponent).join("/")}`);
    if (rules.status === 200 && Array.isArray(rules.json)) {
      const have = new Set(rules.json.map((r) => r?.type));
      for (const rule of REQUIRED_RULES) {
        if (!have.has(rule)) add(`skills-rules-missing:${rule}`, `The skills repo's ${branch} branch has no ${rule.replace(/_/g, "-")} rule, so an agent that could write there could rewrite or delete its history.`);
      }
    } else if (rules.status === 403 && info.json?.private !== false) {
      // A private repo on a plan without rules: GitHub refuses to read them, and none can be in force.
      add("skills-private-unprotected", `The skills repo is private and GitHub will not read or enforce branch rules on it. Make it public or move it to a plan that has rules.`);
    } else {
      failed("rules", "the branch rules", rules.status);
    }
  }

  const people = await get<{ login?: string }[]>("/collaborators?per_page=100");
  if (people.status === 200 && Array.isArray(people.json)) {
    for (const p of people.json) {
      if (typeof p?.login === "string" && p.login.toLowerCase() !== o.owner.toLowerCase()) add(`skills-collaborator:${p.login}`, `${p.login} is a collaborator on the skills repo ${repo}. Only you may be.`);
    }
  } else {
    failed("collaborators", "the collaborators", people.status);
  }

  const keys = await get<{ id?: number; read_only?: boolean }[]>("/keys?per_page=100");
  if (keys.status === 200 && Array.isArray(keys.json)) {
    for (const k of keys.json) {
      // A key that does not say it is read-only is treated as one that can write.
      if (k?.read_only !== true) add(`skills-deploy-key:${k?.id}`, `A deploy key (${k?.id}) on the skills repo ${repo} can write to it. Remove it or make it read-only on GitHub.`);
    }
    if (keys.json.length >= 100) failed("keys-over-100", "every deploy key (more than 100)", 200);
  } else {
    failed("keys", "the deploy keys", keys.status);
  }

  for (const a of o.agents) {
    if (a.installed === true) add(`skills-app-installed:${a.id}`, `${a.id}'s GitHub App is installed on the skills repo ${repo}, so that agent could write to it. Uninstall it on GitHub.`);
    else if (a.installed === "unknown") add(`read-failed:app:${a.id}`, `HQ couldn't tell whether ${a.id}'s GitHub App is installed on the skills repo ${repo}. Check again.`);
  }
  return out;
}

/**
 * Checks the skills repo at pin time (through `CompanySkills`) and daily. A new
 * finding writes a `skills.repo-findings` row and an activity line, once; one
 * the owner fixed and that comes back is new again (as `RepoWatch` does). The
 * daily timer is a minute-by-minute look at the injected clock: the check is
 * due 24 hours after the last one, so tests move the clock, not real time.
 */
export class SkillsRepoWatch {
  private seen = new Set<string>();
  private last: SkillsGuardState | null = null;
  private nextDue: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  /** Every check's full result, for the dashboard. Set by whoever holds the snapshots. */
  report: (state: SkillsGuardState) => void = () => {};
  /** One line per new finding. */
  notify: (text: string) => void = () => {};

  constructor(
    private readonly o: {
      api: GitHubApi;
      clock: Clock;
      audit: AuditSink;
      /** The pinned skills repo, or null before the first pin. */
      repo: () => string | null;
      /** Each agent with an App, and whether it is installed on `repo`. */
      agents: (repo: string) => Promise<AgentInstall[]>;
    },
  ) {}

  /** What the last check found, or null before any. */
  state(): SkillsGuardState | null {
    return this.last ? structuredClone(this.last) : null;
  }

  /** Checks `repo` now. Throws if the agent lookup or the audit write fails; the caller refuses then. */
  async check(repo: string): Promise<Finding[]> {
    const findings = await checkSkillsRepo(this.o.api, repo, { owner: repo.split("/")[0], agents: await this.o.agents(repo) });
    const key = (f: Finding) => `${repo}\0${f.name}`;
    const fresh = findings.filter((f) => !this.seen.has(key(f)));
    if (fresh.length) {
      this.o.audit.append({ actorKind: "hq", actorId: "hq", action: "skills.repo-findings", target: repo, data: { repo, findings: fresh.map((f) => f.name) } });
      for (const f of fresh) this.notify(`Skills repo ${repo}: ${f.detail}`);
    }
    this.seen = new Set(findings.map(key));
    this.last = { repo, checkedAt: this.o.clock.now().toISOString(), findings };
    this.report(structuredClone(this.last));
    return findings;
  }

  /** Runs the check if it is due. The first call after `start` is due at once. */
  async tick(): Promise<void> {
    const now = this.o.clock.now().getTime();
    if (this.nextDue !== null && now < this.nextDue) return;
    this.nextDue = now + DAY_MS;
    const repo = this.o.repo();
    if (repo) await this.check(repo);
  }

  /**
   * Starts the daily check: now, then 24 hours after each run. Returns the first
   * run, which never rejects (a failed check is logged).
   */
  start(): Promise<void> {
    if (this.timer) return Promise.resolve();
    this.nextDue = null;
    const go = () => this.tick().catch((err) => log.warn(`The skills repo check failed: ${err instanceof Error ? err.message : err}`));
    this.timer = setInterval(() => void go(), 60_000);
    this.timer.unref();
    return go();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

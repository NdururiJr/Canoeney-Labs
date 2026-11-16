import { join } from "node:path";
import { AgentRegistry } from "./agents";
import { AgentSecrets } from "./agentSecrets";
import { SqliteAuditSink } from "./audit";
import { systemClock, type Clock } from "./clock";
import { openCompanyDb, type CompanyDb } from "./db";
import { isInside } from "./home";
import { CompanySkills, type CompanySkillsOptions } from "./companySkills";
import { HumanAccounts } from "./humanAccounts";
import { ghCliApi, fetchGitHubApi, type GitHubApi } from "../github/api";
import { GitHubApps } from "../github/apps";
import { run } from "../lib/exec";
import { SkillsRepoWatch, type AgentInstall } from "../skillsRepoCheck";
import { PlanStore } from "./planStore";
import { ProjectNotes } from "./projectNotes";
import { ProjectSettings } from "./projectSettings";
import { DashboardChannel } from "./slots/dashboardChannel";
import { SqliteKnowledgeStore } from "./slots/knowledge";
import { SqliteMemory } from "./slots/memory";
import { LocalRouter } from "./slots/router";
import type { AuditSink, Channel, Memory, Router } from "./slots/types";

export { SchemaTooNewError } from "./db";
export { COMPANY_DIRNAME, HQ_DIRNAME, companyHome, hqHome, isInside } from "./home";

export interface Company {
  db: CompanyDb;
  clock: Clock;
  audit: AuditSink;
  memory: Memory;
  knowledge: SqliteKnowledgeStore;
  router: Router;
  channels: Record<string, Channel>;
  /** Project agents, their roles and status (M0-B). */
  agents: AgentRegistry;
  /** Per-agent secrets, stored as hashes (M0-B). */
  secrets: AgentSecrets;
  /** Humans who log in to the dashboard, and their credentials (M0-C). */
  humans: HumanAccounts;
  /** Project and agent settings and grants: the only writer of configuration (M0-D1). */
  settings: ProjectSettings;
  /** Each project's boards and tasks (M0-D1). */
  plans: PlanStore;
  /** The owner-approved project notes (CLAUDE.md) agents read (M0-D1, SR-D-07). */
  notes: ProjectNotes;
  /** Each agent's own GitHub App, its private key sealed with the owner key (M0-E). */
  githubApps: GitHubApps;
  /** The GitHub REST client the Apps and tokens use (a fake in tests). */
  githubApi: GitHubApi;
  /** The skill lock and each role's skill set (M0-F). */
  skills: CompanySkills;
  /** The skills repo's own settings, checked at pin time and daily (M0-F, SR-F-08). */
  skillsWatch: SkillsRepoWatch;
  /** The company home: the store, the owner key file and the setup file live here. */
  home: string;
  close(): void;
}

/** Open the company store at `home` and build every slot on it. */
export function openCompany(opts: {
  home: string;
  repoRoot: string | null;
  clock?: Clock;
  githubApi?: GitHubApi;
  /** The owner's own `gh` login, which reads the skills repo's settings (a fake in tests). */
  ownerGh?: GitHubApi;
  /** Tests only: where the skills repo is fetched from. The check is always the real one. */
  skills?: Pick<CompanySkillsOptions, "urlFor" | "allowFile">;
}): Company {
  const { home, repoRoot } = opts;
  if (repoRoot !== null && isInside(home, repoRoot)) {
    throw new Error(`The company home ${home} is inside the repository ${repoRoot}. Set HQ_COMPANY_HOME to a folder outside it.`);
  }
  const clock = opts.clock ?? systemClock;
  const db = openCompanyDb(join(home, "company.db"));
  const audit = new SqliteAuditSink(db, clock);
  const dashboard = new DashboardChannel(db, clock);
  const secrets = new AgentSecrets(db, clock, audit);
  const agents = new AgentRegistry(db, clock, audit, secrets);
  const settings = new ProjectSettings(db, clock, audit, agents);
  const githubApi = opts.githubApi ?? fetchGitHubApi();
  const githubApps = new GitHubApps({ db, audit, clock, keyFile: join(home, "owner.key"), api: githubApi });
  // SR-F-08: the skills repo's own settings are checked with the owner's gh, at every
  // pin and daily. The check is never optional; only its GitHub client is injectable.
  const skillsWatch = new SkillsRepoWatch({
    api: opts.ownerGh ?? ghCliApi(run),
    clock,
    audit,
    repo: () => skills.source()?.repo ?? null,
    agents: async (repo) => {
      const out: AgentInstall[] = [];
      for (const row of db.prepare("SELECT agent_id FROM agent_github_apps ORDER BY agent_id").all<{ agent_id: string }>()) {
        // A lookup that fails is "unknown", which the check reports as a finding.
        out.push({ id: row.agent_id, installed: await githubApps.installation(row.agent_id, repo).then((i) => i !== null, () => "unknown" as const) });
      }
      return out;
    },
  });
  const skills: CompanySkills = new CompanySkills(db, clock, settings, { ...opts.skills, home, check: (repo) => skillsWatch.check(repo) });
  return {
    agents,
    secrets,
    settings,
    skills,
    skillsWatch,
    plans: new PlanStore(db),
    notes: new ProjectNotes(db, clock, settings),
    humans: new HumanAccounts(db, clock, audit, join(home, "owner.key")),
    githubApps,
    githubApi,
    home,
    db,
    clock,
    audit,
    memory: new SqliteMemory(db, clock),
    knowledge: new SqliteKnowledgeStore(db, clock, audit),
    router: new LocalRouter(),
    channels: { [dashboard.name]: dashboard },
    close: () => db.close(),
  };
}

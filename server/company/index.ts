import { join } from "node:path";
import { AgentRegistry } from "./agents";
import { AgentSecrets } from "./agentSecrets";
import { SqliteAuditSink } from "./audit";
import { systemClock, type Clock } from "./clock";
import { openCompanyDb, type CompanyDb } from "./db";
import { isInside } from "./home";
import { HumanAccounts } from "./humanAccounts";
import { ProjectSettings } from "./projectSettings";
import { DashboardChannel } from "./slots/dashboardChannel";
import { SqliteKnowledgeStore } from "./slots/knowledge";
import { SqliteMemory } from "./slots/memory";
import { LocalRouter } from "./slots/router";
import type { AuditSink, Channel, Memory, Router } from "./slots/types";

export { SchemaTooNewError } from "./db";
export { COMPANY_DIRNAME, HQ_DIRNAME, companyHome, isInside } from "./home";

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
  /** The company home: the store, the owner key file and the setup file live here. */
  home: string;
  close(): void;
}

/** Open the company store at `home` and build every slot on it. */
export function openCompany(opts: { home: string; repoRoot: string | null; clock?: Clock }): Company {
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
  return {
    agents,
    secrets,
    settings: new ProjectSettings(db, clock, audit, agents),
    humans: new HumanAccounts(db, clock, audit, join(home, "owner.key")),
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

// The agent registry (spec M0.2, M0.14). One row per project agent in the
// company store, holding its role and status. From M0-B the store, not
// `.jsmhq/config.json`, decides who an agent is and what it may do: `isLead`
// in the config seeds the role once, on a project's first import.
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AgentCli } from "../../src/data/types";
import type { AgentSecrets, RevokeReason } from "./agentSecrets";
import type { Clock } from "./clock";
import type { CompanyDb } from "./db";
import type { AuditSink } from "./slots/types";
import type { ActorKind, AgentStatus, RoleId } from "./types";

/** Project and agent ids name folders and sessions, so only plain slugs. */
const PLAIN_ID = /^[a-z0-9][a-z0-9-]*$/;

/** A folder name as a project id: lower-case letters, digits and "-". */
export const projectSlug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";

export function companyAgentId(projectSlug: string, agentId: string): string {
  if (!PLAIN_ID.test(projectSlug) || !PLAIN_ID.test(agentId)) {
    throw new Error(`Invalid agent id ${JSON.stringify(`${projectSlug}/${agentId}`)}: use lower-case letters, digits and "-".`);
  }
  return `${projectSlug}/${agentId}`;
}

export interface Actor {
  kind: ActorKind;
  id: string;
}

const HQ_ACTOR: Actor = { kind: "hq", id: "hq" };

export interface RegisteredAgent {
  companyId: string;
  projectSlug: string;
  agentId: string;
  name: string;
  role: RoleId;
  status: AgentStatus;
  managerId: string | null;
}

export interface ConfigAgent {
  id: string;
  name: string;
  cli: AgentCli;
}

interface Row {
  id: string;
  name: string;
  role_id: RoleId;
  status: AgentStatus;
  manager_id: string | null;
  project_id: string;
}

const toAgent = (r: Row): RegisteredAgent => ({
  companyId: r.id,
  projectSlug: r.project_id,
  agentId: r.id.slice(r.project_id.length + 1),
  name: r.name,
  role: r.role_id,
  status: r.status,
  managerId: r.manager_id,
});

const COLUMNS = "id, name, role_id, status, manager_id, project_id";

const samePath = (a: string, b: string): boolean => {
  const [x, y] = [resolve(a), resolve(b)];
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

const REVOKE_ON: Partial<Record<AgentStatus, RevokeReason>> = { paused: "paused", retired: "retired" };

export class AgentRegistry {
  constructor(
    private readonly db: CompanyDb,
    private readonly clock: Clock,
    private readonly audit: AuditSink,
    private readonly secrets: AgentSecrets,
  ) {}

  /** The project whose repo is at `root`, or null. */
  projectForRoot(root: string): string | null {
    const rows = this.db.prepare("SELECT id, repo FROM projects ORDER BY created_at, rowid").all<{ id: string; repo: string }>();
    return rows.find((r) => samePath(r.repo, root))?.id ?? null;
  }

  /**
   * The project id for the repo at `root` (M0-D1: the id comes from the store,
   * never from a file). A repo already registered keeps its id. Otherwise the id
   * is `slug` (by default the folder name as a slug); a project with that id
   * whose repo no longer exists was moved and takes the new path, and one whose
   * repo still exists makes the new id `<slug>-2`, `<slug>-3` and so on.
   */
  ensureProject(p: { name: string; root: string; slug?: string }): string {
    return this.tx(() => {
      const known = this.projectForRoot(p.root);
      if (known) return known;
      const base = p.slug ?? projectSlug(basename(resolve(p.root)));
      const at = this.clock.now().toISOString();
      for (let n = 1; ; n++) {
        const slug = n === 1 ? base : `${base}-${n}`;
        const row = this.db.prepare("SELECT repo FROM projects WHERE id = ?").get<{ repo: string }>(slug);
        if (!row) {
          this.db.prepare("INSERT INTO projects(id, name, repo, kind, created_at) VALUES (?, ?, ?, 'company', ?)").run(slug, p.name, p.root, at);
          this.audit.append({ actorKind: "hq", actorId: "hq", action: "project.registered", target: slug, data: { name: p.name } });
          return slug;
        }
        if (existsSync(row.repo)) continue;
        this.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(p.root, slug);
        this.audit.append({ actorKind: "hq", actorId: "hq", action: "project.moved", target: slug, data: { from: row.repo, to: p.root } });
        return slug;
      }
    });
  }

  register(
    projectSlug: string,
    a: ConfigAgent,
    role: "cto" | "builder",
    by: Actor,
    source: "import" | "dashboard" | "config",
    extra: Record<string, unknown> = {},
    /** A builder's manager; by default the project's CTO. */
    managerId?: string | null,
  ): RegisteredAgent {
    const id = companyAgentId(projectSlug, a.id);
    return this.tx(() => {
      if (this.getById(id)) throw new Error(`Agent ${id} is already registered.`);
      const manager = role !== "builder" ? null : managerId !== undefined ? managerId : (this.cto(projectSlug)?.companyId ?? null);
      this.db
        .prepare(
          `INSERT INTO agents(id, name, role_id, department_id, manager_id, project_id, cli, status, created_at)
           VALUES (?, ?, ?, 'delivery', ?, ?, ?, 'active', ?)`,
        )
        .run(id, a.name, role, manager, projectSlug, a.cli, this.clock.now().toISOString());
      this.audit.append({ actorKind: by.kind, actorId: by.id, action: "agent.registered", target: id, data: { role, source, ...extra } });
      return this.getById(id)!;
    });
  }

  /**
   * Registers config agents that have no row. On a project's first import (no
   * rows at all, retired ones included) the first agent marked `isLead` becomes
   * the CTO, registered before any builder. Afterwards `isLead` grants nothing:
   * such an agent is registered as a builder and reported in `ignoredLead`.
   */
  syncFromConfig(
    projectSlug: string,
    team: readonly (ConfigAgent & { isLead: boolean })[],
  ): { registered: RegisteredAgent[]; ignoredLead: string[]; skipped: string[]; inactive: { id: string; status: AgentStatus }[] } {
    const skipped = team.filter((a) => !PLAIN_ID.test(a.id)).map((a) => a.id);
    const valid = team.filter((a) => PLAIN_ID.test(a.id));
    const registered: RegisteredAgent[] = [];
    const ignoredLead: string[] = [];
    const inactive: { id: string; status: AgentStatus }[] = [];
    this.tx(() => {
      const firstImport = !this.db.prepare("SELECT 1 AS x FROM agents WHERE project_id = ? LIMIT 1").get(projectSlug);
      if (firstImport) {
        const lead = valid.find((a) => a.isLead);
        if (lead) registered.push(this.register(projectSlug, lead, "cto", HQ_ACTOR, "import"));
        for (const a of valid) {
          if (a === lead) continue;
          if (a.isLead) ignoredLead.push(a.id);
          registered.push(this.register(projectSlug, a, "builder", HQ_ACTOR, "import", a.isLead ? { ignoredIsLead: true } : {}));
        }
        return;
      }
      for (const a of valid) {
        const row = this.get(projectSlug, a.id);
        if (row) {
          // In the config but paused or retired in the store: it cannot start.
          if (row.status !== "active") inactive.push({ id: a.id, status: row.status });
          continue;
        }
        if (a.isLead) ignoredLead.push(a.id);
        registered.push(this.register(projectSlug, a, "builder", HQ_ACTOR, "config", a.isLead ? { ignoredIsLead: true } : {}));
      }
    });
    return { registered, ignoredLead, skipped, inactive };
  }

  get(projectSlug: string, agentId: string): RegisteredAgent | null {
    if (!PLAIN_ID.test(projectSlug) || !PLAIN_ID.test(agentId)) return null;
    return this.getById(`${projectSlug}/${agentId}`);
  }

  getById(companyId: string): RegisteredAgent | null {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM agents WHERE id = ? AND project_id IS NOT NULL`).get<Row>(companyId);
    return r ? toAgent(r) : null;
  }

  list(projectSlug: string): RegisteredAgent[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM agents WHERE project_id = ? ORDER BY created_at, rowid`)
      .all<Row>(projectSlug)
      .map(toAgent);
  }

  /**
   * The project's CTO that is not retired (a paused one still receives its
   * messages), or null. `among` limits it to some agent ids, such as the team
   * in the current config: a store can hold the CTO of an earlier team too.
   */
  cto(projectSlug: string, among?: (agentId: string) => boolean): RegisteredAgent | null {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM agents WHERE project_id = ? AND role_id = 'cto' AND status <> 'retired' ORDER BY created_at, rowid`)
      .all<Row>(projectSlug)
      .map(toAgent);
    return rows.find((a) => !among || among(a.agentId)) ?? null;
  }

  setRole(projectSlug: string, agentId: string, role: RoleId, by: Actor): void {
    this.tx(() => {
      const a = this.must(projectSlug, agentId);
      if (a.role === role) return;
      this.db.prepare("UPDATE agents SET role_id = ? WHERE id = ?").run(role, a.companyId);
      this.audit.append({ actorKind: by.kind, actorId: by.id, action: "agent.role-changed", target: a.companyId, data: { from: a.role, to: role } });
    });
  }

  /** Pausing or retiring revokes the agent's secret in the same transaction. Retired is final. */
  setStatus(projectSlug: string, agentId: string, status: AgentStatus, by: Actor): void {
    this.tx(() => {
      const a = this.must(projectSlug, agentId);
      if (a.status === "retired") throw new Error(`${a.name} was retired; a retired agent stays retired.`);
      if (a.status === status) return;
      const at = this.clock.now().toISOString();
      this.db.prepare("UPDATE agents SET status = ?, retired_at = ? WHERE id = ?").run(status, status === "retired" ? at : null, a.companyId);
      const reason = REVOKE_ON[status];
      if (reason) this.secrets.revoke(a.companyId, reason);
      this.audit.append({ actorKind: by.kind, actorId: by.id, action: "agent.status-changed", target: a.companyId, data: { from: a.status, to: status } });
    });
  }

  private must(projectSlug: string, agentId: string): RegisteredAgent {
    const a = this.get(projectSlug, agentId);
    if (!a) throw new Error(`No registered agent ${projectSlug}/${agentId}.`);
    return a;
  }

  private tx<T>(fn: () => T): T {
    return this.db.inTransaction ? fn() : this.db.transaction(fn, "immediate");
  }
}

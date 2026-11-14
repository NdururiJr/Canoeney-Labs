// The agent registry (spec M0.2, M0.14). One row per project agent in the
// company store, holding its role and status. From M0-B the store, not
// `.jsmhq/config.json`, decides who an agent is and what it may do: `isLead`
// in the config seeds the role once, on a project's first import.
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AgentCli } from "../../src/data/types";
import { sessionName } from "../paths";
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
   * is `slug` (by default the folder name as a slug). A project with that id was
   * moved, and takes the new path, only when its repo no longer exists and its
   * stored GitHub repo is the new repo's (M0-D2, owner decision 2026-11-14): a
   * different repo reusing a deleted repo's folder name must not inherit its
   * grants and notes. Otherwise the new id is `<slug>-2`, `<slug>-3` and so on.
   * `by` names who registered it (HQ by default).
   */
  ensureProject(p: { name: string; root: string; github: string | null; slug?: string }, by: { actor: Actor; authority?: string } = { actor: HQ_ACTOR }): string {
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
          const data = { name: p.name, ...(by.authority ? { authority: by.authority } : {}) };
          this.audit.append({ actorKind: by.actor.kind, actorId: by.actor.id, action: "project.registered", target: slug, data });
          return slug;
        }
        if (existsSync(row.repo) || !this.sameGithub(slug, p.github)) continue;
        this.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(p.root, slug);
        this.audit.append({ actorKind: by.actor.kind, actorId: by.actor.id, action: "project.moved", target: slug, data: { from: row.repo, to: p.root } });
        return slug;
      }
    });
  }

  /** True when the project's stored GitHub repo is `github`; both must be set. */
  private sameGithub(projectId: string, github: string | null): boolean {
    const stored = this.db.prepare("SELECT github FROM project_settings WHERE project_id = ?").get<{ github: string | null }>(projectId)?.github;
    return !!stored && !!github && stored.toLowerCase() === github.toLowerCase();
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
      // Sessions and sandboxes are named hq-<project>-<agent>, so project "a" agent "b-c" and
      // project "a-b" agent "c" would share one: session names are unique company-wide.
      const name = sessionName(projectSlug, a.id);
      const clash = this.db
        .prepare("SELECT id, project_id FROM agents WHERE project_id IS NOT NULL")
        .all<{ id: string; project_id: string }>()
        .find((r) => sessionName(r.project_id, r.id.slice(r.project_id.length + 1)) === name);
      if (clash) throw new Error(`Agent ${a.id} would have the session name ${name}, which ${clash.id} already has. Choose another id.`);
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

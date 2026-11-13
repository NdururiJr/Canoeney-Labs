// The one writer of a project's configuration (spec M0.11, threat model
// SR-D-03, SR-D-11; docs/adr/0008-company-store-holds-configuration.md).
// Every write names an Authority and runs in one immediate transaction:
// check the authority, write, append the audit row. A refusal is audited
// outside the failed transaction and thrown as an AuthorityError.
import type { AgentCli, AgentConfig, AgentMode, HqConfig, SandboxResources, WorkflowConfig } from "../../src/data/types";
import type { StackConfig } from "../../src/data/stack";
import { newAgent } from "../store";
import type { Actor, AgentRegistry, RegisteredAgent } from "./agents";
import { AuthorityError, hqMay, relaxes, type AgentField, type Authority, type AuthorityRefusal, type ConfigChange, type ProjectField } from "./authority";
import { canonicalJson } from "./canonicalJson";
import type { Clock } from "./clock";
import type { CompanyDb } from "./db";
import type { AuditEventInput, AuditSink } from "./slots/types";
import type { PermissionKind } from "./types";

/** Used for a project with no settings row yet: every control at its tightest. */
export const SAFE_WORKFLOW: WorkflowConfig = {
  review: { enabled: true, tool: "human", command: "" },
  merge: { by: "human" },
  deploy: { enabled: false, tool: "instacloud", command: "", perAgentEnvironments: false },
};

export interface WorkflowPatch {
  review?: Partial<WorkflowConfig["review"]>;
  merge?: Partial<WorkflowConfig["merge"]>;
  deploy?: Partial<WorkflowConfig["deploy"]>;
}

export interface ProjectPatch {
  name?: string;
  officeName?: string;
  exportPlan?: boolean;
  github?: string | null;
  /** null removes the stack. */
  stack?: StackConfig | null;
}

export interface AgentSettingsPatch {
  /** The agent's name (written to agents.name). */
  name?: string;
  displayRole?: string;
  color?: string;
  model?: string;
  mode?: AgentMode;
  cli?: AgentCli;
  workspacePath?: string | null;
  roleMd?: string;
  resources?: SandboxResources;
}

export interface NewAgent {
  id: string;
  name: string;
  cli: AgentCli;
  displayRole: string;
  color: string;
  mode: AgentMode;
  model: string;
}

export interface Grant {
  kind: PermissionKind;
  value: string;
}

interface SettingsRow {
  github: string | null;
  workflow_json: string;
  stack_json: string | null;
  office_name: string | null;
  export_plan: number;
}

interface AgentRow {
  display_role: string;
  color: string;
  model: string;
  mode: AgentMode;
  workspace_path: string | null;
  role_md: string;
  cpus: number | null;
  memory_gb: number | null;
}

interface Settings {
  displayRole: string;
  color: string;
  model: string;
  mode: AgentMode;
  workspacePath: string | null;
  roleMd: string;
  resources: SandboxResources;
}

const PROJECT_FIELDS: readonly ProjectField[] = ["name", "officeName", "exportPlan", "github", "stack"];
const AGENT_FIELDS: readonly AgentField[] = ["name", "displayRole", "color", "model", "mode", "cli", "workspacePath", "roleMd", "resources"];

const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** Thrown inside the transaction so it rolls back; turned into an audited AuthorityError outside. */
class Refused {
  constructor(
    readonly reason: AuthorityRefusal,
    readonly change: ConfigChange,
  ) {}
}

export class ProjectSettings {
  /** Inside transaction(): a refusal waits here and is written after the rollback, so it is not rolled back with it. */
  private batch: { refusal: AuditEventInput | null } | null = null;

  constructor(
    private readonly db: CompanyDb,
    private readonly clock: Clock,
    private readonly audit: AuditSink,
    private readonly agents: AgentRegistry,
  ) {}

  /**
   * Runs several writes in one immediate transaction. If one is refused, all of
   * them roll back and the settings.refused row is written afterwards.
   */
  transaction<T>(fn: () => T): T {
    if (this.db.inTransaction) return fn();
    const batch = { refusal: null as AuditEventInput | null };
    this.batch = batch;
    try {
      return this.db.transaction(fn, "immediate");
    } catch (err) {
      if (batch.refusal) this.audit.append(batch.refusal);
      throw err;
    } finally {
      this.batch = null;
    }
  }

  has(projectId: string): boolean {
    return !!this.db.prepare("SELECT 1 AS x FROM project_settings WHERE project_id = ?").get(projectId);
  }

  /** The project's first settings. This counts as an import, so it needs the PIN. */
  create(projectId: string, init: { github: string | null; workflow: WorkflowConfig; stack?: StackConfig; officeName?: string }, by: Authority): void {
    this.authorized([{ kind: "import" }], by, projectId, () => {
      if (this.has(projectId)) throw new Error(`Project ${projectId} already has settings.`);
      this.db
        .prepare(
          `INSERT INTO project_settings(project_id, github, workflow_json, stack_json, office_name, export_plan, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(projectId, init.github, JSON.stringify(init.workflow), init.stack ? JSON.stringify(init.stack) : null, init.officeName ?? null, this.now());
      this.record(by, "settings.changed", projectId, { change: "import" });
    });
  }

  /** The dashboard's config, built from the store alone. */
  view(projectId: string, runtime: { path: string; hqPort: number }): HqConfig {
    const project = this.db.prepare("SELECT name FROM projects WHERE id = ?").get<{ name: string }>(projectId);
    if (!project) throw new Error(`No project ${projectId}.`);
    const row = this.settingsRow(projectId);
    const team: AgentConfig[] = this.agents
      .list(projectId)
      .filter((a) => a.status !== "retired")
      .map((a) => this.agentConfig(a));
    const config: HqConfig = {
      project: {
        id: projectId,
        name: project.name,
        repo: row?.github ?? project.name,
        path: runtime.path,
        hqPort: runtime.hqPort,
        exportPlan: row ? row.export_plan === 1 : false,
      },
      team,
      workflow: row ? (JSON.parse(row.workflow_json) as WorkflowConfig) : structuredClone(SAFE_WORKFLOW),
    };
    if (row?.office_name) config.project.officeName = row.office_name;
    if (row?.stack_json) config.stack = JSON.parse(row.stack_json) as StackConfig;
    return config;
  }

  updateWorkflow(projectId: string, patch: WorkflowPatch, by: Authority): void {
    const row = this.mustSettings(projectId);
    const before = JSON.parse(row.workflow_json) as WorkflowConfig;
    const after: WorkflowConfig = {
      review: { ...before.review, ...patch.review },
      merge: { ...before.merge, ...patch.merge },
      deploy: { ...before.deploy, ...patch.deploy },
    };
    if (same(before, after)) return;
    this.authorized([{ kind: "workflow", before, after }], by, projectId, () => {
      this.db.prepare("UPDATE project_settings SET workflow_json = ?, updated_at = ? WHERE project_id = ?").run(JSON.stringify(after), this.now(), projectId);
      this.record(by, "settings.changed", projectId, { change: "workflow" });
    });
  }

  updateProject(projectId: string, patch: ProjectPatch, by: Authority): void {
    const row = this.mustSettings(projectId);
    const name = this.db.prepare("SELECT name FROM projects WHERE id = ?").get<{ name: string }>(projectId)!.name;
    const current: Record<ProjectField, unknown> = {
      name,
      officeName: row.office_name ?? "",
      exportPlan: row.export_plan === 1,
      github: row.github,
      stack: row.stack_json ? JSON.parse(row.stack_json) : null,
    };
    const changes = PROJECT_FIELDS.filter((f) => patch[f] !== undefined && !same(current[f], patch[f])).map(
      (field): ConfigChange => ({ kind: "project", field, before: current[field], after: patch[field] }),
    );
    if (changes.length === 0) return;
    this.authorized(changes, by, projectId, () => {
      const at = this.now();
      for (const c of changes) {
        if (c.kind !== "project") continue;
        if (c.field === "name") this.db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(String(c.after), projectId);
        else {
          const column = { officeName: "office_name", exportPlan: "export_plan", github: "github", stack: "stack_json" }[c.field];
          // An empty office name or a null stack clears the column.
          const value = c.field === "exportPlan" ? (c.after ? 1 : 0) : c.field === "stack" ? (c.after ? JSON.stringify(c.after) : null) : (c.after as string | null) || null;
          this.db.prepare(`UPDATE project_settings SET ${column} = ?, updated_at = ? WHERE project_id = ?`).run(value, at, projectId);
        }
        this.record(by, "settings.changed", projectId, { change: "project", field: c.field });
      }
    });
  }

  updateAgent(companyId: string, patch: AgentSettingsPatch, by: Authority): void {
    const agent = this.mustAgent(companyId);
    const cur = this.settingsOf(agent);
    const cli = this.cliOf(companyId);
    const current: Record<AgentField, unknown> = { ...cur, cli, name: agent.name };
    const changes = AGENT_FIELDS.filter((f) => patch[f] !== undefined && !same(current[f], patch[f])).map(
      (field): ConfigChange => ({ kind: "agent", field, before: current[field], after: patch[field] }),
    );
    if (changes.length === 0) return;
    this.authorized(changes, by, companyId, () => {
      const next: Settings = { ...cur };
      for (const c of changes) {
        if (c.kind !== "agent") continue;
        if (c.field === "cli") this.db.prepare("UPDATE agents SET cli = ? WHERE id = ?").run(c.after as AgentCli, companyId);
        else if (c.field === "name") this.db.prepare("UPDATE agents SET name = ? WHERE id = ?").run(String(c.after), companyId);
        else (next as unknown as Record<string, unknown>)[c.field] = c.after;
        this.record(by, "settings.changed", companyId, { change: "agent", field: c.field });
      }
      this.writeSettings(companyId, next);
    });
  }

  /** Registers the agent with a settings row and no grants (SR-D-11). Adding an agent relaxes a control. */
  addAgent(projectId: string, a: NewAgent, role: "cto" | "builder", by: Authority, managerId?: string | null): RegisteredAgent {
    return this.authorized([{ kind: "agent-added" }], by, projectId, () => {
      const registered = this.agents.register(projectId, { id: a.id, name: a.name, cli: a.cli }, role, this.actor(by), "dashboard", { authority: by.via }, managerId);
      const base = newAgent(a.id, a.name, a.displayRole, a.color, role === "cto");
      this.writeSettings(registered.companyId, {
        displayRole: a.displayRole,
        color: a.color,
        model: a.model,
        mode: a.mode,
        workspacePath: null,
        roleMd: base.roleMd,
        resources: { cpus: null, memoryGb: null },
      });
      return registered;
    });
  }

  grants(companyId: string, kind?: PermissionKind): Grant[] {
    const rows = kind
      ? this.db.prepare("SELECT kind, value FROM permissions WHERE agent_id = ? AND kind = ? AND revoked_at IS NULL ORDER BY id").all<Grant>(companyId, kind)
      : this.db.prepare("SELECT kind, value FROM permissions WHERE agent_id = ? AND revoked_at IS NULL ORDER BY id").all<Grant>(companyId);
    return rows.map((r) => ({ kind: r.kind, value: r.value }));
  }

  /** False when the grant was already active. */
  grant(companyId: string, kind: PermissionKind, value: string, by: Authority): boolean {
    this.mustAgent(companyId);
    return this.authorized([{ kind: "grant", permission: kind, value }], by, companyId, () => this.writeGrant(companyId, kind, value, by));
  }

  /** False when there was no active grant. */
  revoke(companyId: string, kind: PermissionKind, value: string, by: Authority): boolean {
    this.mustAgent(companyId);
    return this.authorized([{ kind: "revoke", permission: kind, value }], by, companyId, () => this.writeRevoke(companyId, kind, value, by));
  }

  /** Makes the active grants of one kind equal to `values`. Each addition and removal is checked in its own direction. */
  setGrants(companyId: string, kind: PermissionKind, values: string[], by: Authority): { added: string[]; removed: string[] } {
    this.mustAgent(companyId);
    const now = new Set(this.grants(companyId, kind).map((g) => g.value));
    const want = new Set(values);
    const added = [...want].filter((v) => !now.has(v));
    const removed = [...now].filter((v) => !want.has(v));
    const changes: ConfigChange[] = [
      ...added.map((value): ConfigChange => ({ kind: "grant", permission: kind, value })),
      ...removed.map((value): ConfigChange => ({ kind: "revoke", permission: kind, value })),
    ];
    if (changes.length === 0) return { added, removed };
    this.authorized(changes, by, companyId, () => {
      for (const v of added) this.writeGrant(companyId, kind, v, by);
      for (const v of removed) this.writeRevoke(companyId, kind, v, by);
    });
    return { added, removed };
  }

  // ------------------------------------------------------------ internals

  /** Checks every change against `by`, then runs `write` in one immediate transaction; a refusal is audited and thrown. */
  authorized<T>(changes: ConfigChange[], by: Authority, target: string, write: () => T): T {
    try {
      return this.tx(() => {
        for (const c of changes) {
          const reason = this.refusal(c, by);
          if (reason) throw new Refused(reason, c);
        }
        return write();
      });
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      const c = err.change;
      const row: AuditEventInput = {
        actorKind: by.via === "pin" || by.via === "session" ? "human" : "hq",
        actorId: by.via === "pin" || by.via === "session" ? by.humanId : "hq",
        action: "settings.refused",
        target,
        data: { change: c.kind, ...("field" in c ? { field: c.field } : {}), ...("permission" in c ? { kind: c.permission } : {}), reason: err.reason, authority: by.via },
      };
      if (this.batch) this.batch.refusal ??= row;
      else this.audit.append(row);
      throw new AuthorityError(err.reason, c);
    }
  }

  private refusal(c: ConfigChange, by: Authority): AuthorityRefusal | null {
    if (by.via === "pin" || by.via === "session") {
      const h = this.db.prepare("SELECT role, disabled_at FROM humans WHERE id = ?").get<{ role: string; disabled_at: string | null }>(by.humanId);
      if (!h || h.role !== "owner" || h.disabled_at !== null) return "not-owner";
    }
    if (by.via === "decision") {
      const d = this.db.prepare("SELECT status FROM decisions WHERE id = ?").get<{ status: string }>(by.decisionId);
      if (d?.status !== "approved") return "decision-not-approved";
    }
    if (by.via === "hq" && !hqMay(c)) return "hq-cannot-grant";
    if (relaxes(c) && by.via !== "pin" && by.via !== "decision") return "pin-or-decision-required";
    return null;
  }

  private writeGrant(companyId: string, kind: PermissionKind, value: string, by: Authority): boolean {
    const active = this.db.prepare("SELECT 1 AS x FROM permissions WHERE agent_id = ? AND kind = ? AND value = ? AND revoked_at IS NULL").get(companyId, kind, value);
    if (active) return false;
    this.db
      .prepare("INSERT INTO permissions(agent_id, kind, value, granted_by_decision_id, granted_by_human_id, granted_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(companyId, kind, value, by.via === "decision" ? by.decisionId : null, by.via === "pin" || by.via === "session" ? by.humanId : null, this.now());
    this.record(by, "permission.granted", companyId, { kind, value });
    return true;
  }

  private writeRevoke(companyId: string, kind: PermissionKind, value: string, by: Authority): boolean {
    const r = this.db
      .prepare("UPDATE permissions SET revoked_at = ? WHERE agent_id = ? AND kind = ? AND value = ? AND revoked_at IS NULL")
      .run(this.now(), companyId, kind, value);
    if (r.changes === 0) return false;
    this.record(by, "permission.revoked", companyId, { kind, value });
    return true;
  }

  /** Appends an audit row for a write done with `by` (actor, decision id and data.authority). */
  record(by: Authority, action: string, target: string, data: Record<string, unknown>): void {
    const actor = this.actor(by);
    this.audit.append({
      actorKind: actor.kind,
      actorId: actor.id,
      action,
      target,
      decisionId: by.via === "decision" ? by.decisionId : null,
      data: { ...data, authority: by.via },
    });
  }

  private actor(by: Authority): Actor {
    return by.via === "pin" || by.via === "session" ? { kind: "human", id: by.humanId } : { kind: "hq", id: "hq" };
  }

  private agentConfig(a: RegisteredAgent): AgentConfig {
    const s = this.settingsOf(a);
    const of = (kind: PermissionKind) => this.grants(a.companyId, kind).map((g) => g.value);
    return {
      id: a.agentId,
      name: a.name,
      role: s.displayRole,
      isLead: a.role === "cto",
      cli: this.cliOf(a.companyId),
      model: s.model,
      mode: s.mode,
      color: s.color,
      skills: of("skill"),
      roleMd: s.roleMd,
      sandbox: { resources: s.resources, allow: of("network-allow"), deny: of("network-deny") },
      workspacePath: s.workspacePath,
      mcp: of("mcp-server"),
    };
  }

  /** The agent's settings row, or the defaults for an agent that has none. */
  private settingsOf(a: RegisteredAgent): Settings {
    const r = this.db.prepare("SELECT * FROM agent_settings WHERE agent_id = ?").get<AgentRow>(a.companyId);
    if (r) {
      return {
        displayRole: r.display_role,
        color: r.color,
        model: r.model,
        mode: r.mode,
        workspacePath: r.workspace_path,
        roleMd: r.role_md,
        resources: { cpus: r.cpus, memoryGb: r.memory_gb },
      };
    }
    const lead = a.role === "cto";
    const d = newAgent(a.agentId, a.name, lead ? "Lead" : "Developer", lead ? "#ff77a8" : "#29adff", lead);
    return { displayRole: d.role, color: d.color, model: d.model, mode: d.mode, workspacePath: null, roleMd: d.roleMd, resources: { cpus: null, memoryGb: null } };
  }

  private writeSettings(companyId: string, s: Settings): void {
    this.db
      .prepare(
        `INSERT INTO agent_settings(agent_id, display_role, color, model, mode, workspace_path, role_md, cpus, memory_gb, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET display_role = excluded.display_role, color = excluded.color, model = excluded.model,
           mode = excluded.mode, workspace_path = excluded.workspace_path, role_md = excluded.role_md, cpus = excluded.cpus,
           memory_gb = excluded.memory_gb, updated_at = excluded.updated_at`,
      )
      .run(companyId, s.displayRole, s.color, s.model, s.mode, s.workspacePath, s.roleMd, s.resources.cpus, s.resources.memoryGb, this.now());
  }

  private cliOf(companyId: string): AgentCli {
    return this.db.prepare("SELECT cli FROM agents WHERE id = ?").get<{ cli: AgentCli }>(companyId)!.cli;
  }

  private settingsRow(projectId: string): SettingsRow | undefined {
    return this.db.prepare("SELECT github, workflow_json, stack_json, office_name, export_plan FROM project_settings WHERE project_id = ?").get<SettingsRow>(projectId);
  }

  private mustSettings(projectId: string): SettingsRow {
    const row = this.settingsRow(projectId);
    if (!row) throw new Error(`Project ${projectId} has no settings yet.`);
    return row;
  }

  private mustAgent(companyId: string): RegisteredAgent {
    const a = this.agents.getById(companyId);
    if (!a) throw new Error(`No registered agent ${companyId}.`);
    return a;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private tx<T>(fn: () => T): T {
    return this.db.inTransaction ? fn() : this.db.transaction(fn, "immediate");
  }
}

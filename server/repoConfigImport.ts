// The one reader of a repo's .jsmhq/config.json and .jsmhq/plan.json (M0-D1,
// SR-D-02). An install from before M0-D1 keeps its configuration in those
// files. The owner previews what an import would write, then confirms it with
// the PIN, and the confirmation is bound to the hash of the files the preview
// showed (D3). Every other part of HQ reads the company store only.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentCli, AgentMode, Board, HqConfig, ImportLine, Task, WorkflowConfig } from "../src/data/types";
import type { Company } from "./company";
import { companyAgentId } from "./company/agents";
import { relaxes, type Authority, type ConfigChange } from "./company/authority";
import { MODEL_NAME, SAFE_WORKFLOW } from "./company/projectSettings";
import type { PermissionKind } from "./company/types";
import { DOMAIN } from "./access";
import { MCP_NAME } from "./sbxMcp";
import { cleanStack, stackValues } from "./stackClean";
import { newAgent } from "./store";

const PLAIN_ID = /^[a-z0-9][a-z0-9-]*$/;

/** One write of the import: exactly one audit row, and one preview line when it relaxes a control. */
interface Step {
  change: ConfigChange;
  text: string;
  fromFile: string[];
  apply: (by: Authority) => void;
}

export interface ImportPlan {
  steps: Step[];
  boards: Board[];
  tasks: Task[];
  /** Agent ids in the file that are not plain ids, so not imported. */
  skipped: string[];
  /** Domains and MCP names the dashboard would refuse, so not imported. */
  dropped: number;
}

export interface ReadImport {
  sha256: string;
  plan: ImportPlan;
}

const hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const files = (root: string) => ({ config: join(root, ".jsmhq", "config.json"), plan: join(root, ".jsmhq", "plan.json") });

export const hasRepoConfig = (root: string): boolean => existsSync(files(root).config);

/**
 * Startup: the welcome shows while the store has no settings, and the import is
 * offered when the old file exists. Only existsSync is used: nothing is read
 * until the owner asks for the preview (review focus 1).
 */
export function offerImport(hub: { snap: { welcome?: boolean; importable?: true }; slug: string; repo: { root: string } }, company: Company): void {
  hub.snap.welcome = !company.settings.has(hub.slug);
  if (hub.snap.welcome && hasRepoConfig(hub.repo.root)) hub.snap.importable = true;
  else delete hub.snap.importable;
}

/**
 * Reads each file's bytes once, hashes them, and builds the plan from those
 * same bytes, so what is applied is what was hashed.
 */
export function readImport(root: string, company: Company, slug: string): ReadImport {
  const f = files(root);
  const configBytes = readOwnFile(f.config, ".jsmhq/config.json");
  const planBytes = existsSync(f.plan) ? readOwnFile(f.plan, ".jsmhq/plan.json") : null;
  const sha256 = hex(Buffer.from(JSON.stringify({ config: hex(configBytes), plan: planBytes ? hex(planBytes) : null })));
  const config = parseJson(configBytes, ".jsmhq/config.json") as Partial<HqConfig>;
  const planFile = planBytes ? (parseJson(planBytes, ".jsmhq/plan.json") as { boards?: Board[]; tasks?: Task[] }) : {};
  return { sha256, plan: buildPlan(config, planFile, company, slug) };
}

/** A file in the repo itself, never one a link points to (outside the repo, or HQ's own). */
function readOwnFile(path: string, label: string): Buffer {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`\`${label}\` is a link. HQ imports only a file kept in the repo itself.`);
  return readFileSync(path);
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`\`${label}\` is not valid JSON; fix or delete it.`);
  }
}

/** The preview: every step that relaxes a control, in the order the import applies them. */
export function previewImport(plan: ImportPlan): ImportLine[] {
  return plan.steps.filter((s) => relaxes(s.change)).map((s) => ({ text: s.text, fromFile: s.fromFile }));
}

/** Applies every step with the owner's authority, and writes the boards and tasks. Run it inside one transaction. */
export function applyImport(plan: ImportPlan, company: Company, slug: string, by: Authority): { agents: number; grants: number; tasks: number } {
  for (const s of plan.steps) s.apply(by);
  const known = new Set(company.agents.list(slug).map((a) => a.agentId));
  for (const b of plan.boards) company.plans.putBoard(slug, b);
  for (const t of plan.tasks) company.plans.putTask(slug, { ...t, ownerId: t.ownerId && known.has(t.ownerId) ? t.ownerId : null });
  return {
    agents: plan.steps.filter((s) => s.change.kind === "agent-added").length,
    grants: plan.steps.filter((s) => s.change.kind === "grant").length,
    tasks: plan.tasks.length,
  };
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const list = (v: unknown, max = 200): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, max)).filter(Boolean))] : [];

/** Preview texts are HQ's own words; the agent's name and the value from the file go in fromFile. */
const GRANT_TEXT: Record<PermissionKind, string> = {
  "network-allow": "An agent's sandbox may reach a site",
  "network-deny": "An agent's sandbox is blocked from a site",
  "mcp-server": "An agent gets an MCP server",
  "secret-name": "An agent gets a key",
  tool: "An agent gets a tool",
  skill: "An agent gets a skill",
};

const REVIEW_TOOLS = ["coderabbit", "greptile", "copilot", "human", "custom"] as const;
const DEPLOY_TOOLS = ["instacloud", "vercel", "custom"] as const;

/** The file's workflow with every field checked: a value outside its list falls back to the safe default. */
function workflowOf(raw: unknown): WorkflowConfig {
  const w = (raw ?? {}) as { review?: Record<string, unknown>; merge?: Record<string, unknown>; deploy?: Record<string, unknown> };
  const pick = <T extends string>(v: unknown, list: readonly T[], dflt: T): T => (list.includes(v as T) ? (v as T) : dflt);
  return {
    review: { enabled: w.review?.enabled !== false, tool: pick(w.review?.tool, REVIEW_TOOLS, "human"), command: str(w.review?.command, 300) },
    merge: { by: w.merge?.by === "lead" ? "lead" : "human" },
    deploy: {
      enabled: w.deploy?.enabled === true,
      tool: pick(w.deploy?.tool, DEPLOY_TOOLS, "instacloud"),
      command: str(w.deploy?.command, 300),
      perAgentEnvironments: w.deploy?.perAgentEnvironments === true,
    },
  };
}

function workflowText(w: WorkflowConfig): string {
  const parts: string[] = [];
  if (!w.review.enabled) parts.push("review off");
  else parts.push(`review by ${w.review.tool}${w.review.command ? " with a custom command" : ""}`);
  if (w.merge.by === "lead") parts.push("the lead merges");
  if (w.deploy.enabled) parts.push(`deploy with ${w.deploy.tool}${w.deploy.command ? " and a custom command" : ""}`);
  return `Workflow: ${parts.join(", ")}`;
}

function buildPlan(config: Partial<HqConfig>, planFile: { boards?: Board[]; tasks?: Task[] }, company: Company, slug: string): ImportPlan {
  const s = company.settings;
  const steps: Step[] = [];
  const project = (config.project ?? {}) as Partial<HqConfig["project"]>;
  const workflow = workflowOf(config.workflow);
  const github = str(project.repo, 200).trim() || null;

  steps.push({ change: { kind: "import" }, text: "Import the settings in .jsmhq/config.json", fromFile: [], apply: (by) => s.create(slug, { github: null, workflow: SAFE_WORKFLOW }, by) });
  if (github) {
    steps.push({
      change: { kind: "project", field: "github", before: null, after: github },
      text: "GitHub repo",
      fromFile: [github],
      apply: (by) => s.updateProject(slug, { github }, by),
    });
  }
  const stack = cleanStack(config.stack);
  if (stack) {
    // Checked against the catalog; its free text goes into every agent's role, so it is shown.
    steps.push({ change: { kind: "project", field: "stack", before: null, after: stack }, text: "The project's stack (it goes into every agent's instructions)", fromFile: stackValues(stack), apply: (by) => s.updateProject(slug, { stack }, by) });
  }
  const officeName = str(project.officeName, 40).trim();
  if (officeName) steps.push({ change: { kind: "project", field: "officeName", before: "", after: officeName }, text: "Office name", fromFile: [officeName], apply: (by) => s.updateProject(slug, { officeName }, by) });
  if (project.exportPlan === true) steps.push({ change: { kind: "project", field: "exportPlan", before: false, after: true }, text: "Plan export on", fromFile: [], apply: (by) => s.updateProject(slug, { exportPlan: true }, by) });
  if (JSON.stringify(workflow) !== JSON.stringify(SAFE_WORKFLOW)) {
    steps.push({ change: { kind: "workflow", before: SAFE_WORKFLOW, after: workflow }, text: workflowText(workflow), fromFile: workflow.review.command || workflow.deploy.command ? [workflow.review.command, workflow.deploy.command].filter(Boolean) : [], apply: (by) => s.updateWorkflow(slug, workflow, by) });
  }

  const team = Array.isArray(config.team) ? config.team : [];
  let dropped = 0;
  /** Keeps the values `ok` accepts (after `clean`), counting the others as dropped: the dashboard's own rules. */
  const keep = (values: string[], clean: (v: string) => string, ok: RegExp): string[] => {
    const out: string[] = [];
    for (const v of values) {
      const c = clean(v);
      if (ok.test(c)) {
        if (!out.includes(c)) out.push(c);
      } else dropped++;
    }
    return out;
  };
  const skipped = team.map((a) => str(a?.id, 80)).filter((id) => !PLAIN_ID.test(id));
  const valid = team.filter((a) => PLAIN_ID.test(str(a?.id, 80)));
  const registered = new Map(company.agents.list(slug).map((a) => [a.agentId, a]));
  const firstImport = registered.size === 0;
  const lead = firstImport ? valid.find((a) => a.isLead === true) : undefined;
  const ordered = lead ? [lead, ...valid.filter((a) => a !== lead)] : valid;
  const view = s.view(slug, { path: "", hqPort: 0 });

  for (const raw of ordered) {
    const id = str(raw.id, 80);
    const name = str(raw.name, 40).trim() || id;
    const cli: AgentCli = raw.cli === "codex" ? "codex" : "claude";
    const mode: AgentMode = raw.mode === "local" ? "local" : "sandbox";
    const displayRole = str(raw.role, 40).trim() || "Developer";
    const color = /^#[0-9a-fA-F]{6}$/.test(str(raw.color, 7)) ? str(raw.color, 7) : "#29adff";
    // A model name that is not plain is dropped (the CLI's default is used): it goes onto a command line.
    const rawModel = str(raw.model, 60).trim();
    const model = MODEL_NAME.test(rawModel) ? rawModel : "";
    const companyId = companyAgentId(slug, id);
    const existing = registered.get(id);
    if (existing?.status === "retired") continue;
    const role = raw === lead ? "cto" : "builder";

    let current: { cli: AgentCli; mode: AgentMode; roleMd: string; workspacePath: string | null };
    const now = view.team.find((a) => a.id === id);
    if (!existing) {
      const defaults = newAgent(id, name, displayRole, color, role === "cto");
      const roleText = role === "cto" ? "as the CTO (the lead)" : "as a builder";
      steps.push({
        change: { kind: "agent-added" },
        text: `Add an agent ${roleText}, using ${cli === "codex" ? "Codex" : "Claude Code"}${mode === "local" ? ", in Local mode: outside a sandbox, on this machine" : ""}`,
        fromFile: [name],
        apply: (by) => s.addAgent(slug, { id, name, cli, displayRole, color, mode, model }, role, by),
      });
      current = { cli, mode, roleMd: defaults.roleMd, workspacePath: null };
    } else {
      current = { cli: now?.cli ?? "claude", mode: now?.mode ?? "sandbox", roleMd: now?.roleMd ?? "", workspacePath: now?.workspacePath ?? null };
      if (mode !== current.mode) steps.push(agentStep(s, companyId, "mode", current.mode, mode, mode === "local" ? "An agent runs in Local mode: outside a sandbox, on this machine" : "An agent runs in a sandbox", [name]));
      if (cli !== current.cli) steps.push(agentStep(s, companyId, "cli", current.cli, cli, `An agent uses ${cli === "codex" ? "Codex" : "Claude Code"}`, [name]));
      // Cosmetic settings: written (and audited) with the import, not preview lines.
      for (const [field, before, after] of [
        ["displayRole", now?.role ?? "", displayRole],
        ["color", now?.color ?? "", color],
        ["model", now?.model ?? "", model],
      ] as const) {
        if (after !== before) steps.push(agentStep(s, companyId, field, before, after, "", []));
      }
    }
    const roleMd = str(raw.roleMd, 8000);
    if (roleMd && roleMd !== current.roleMd) steps.push(agentStep(s, companyId, "roleMd", current.roleMd, roleMd, "An agent's role text", [name, roleMd]));
    const workspacePath = str(raw.workspacePath, 500).trim() || null;
    if (workspacePath && workspacePath !== current.workspacePath) {
      steps.push(agentStep(s, companyId, "workspacePath", current.workspacePath, workspacePath, "An agent works in a folder of its own choosing", [name, workspacePath]));
    }
    const res = raw.sandbox?.resources as { cpus?: unknown; memoryGb?: unknown } | undefined;
    const resources = {
      cpus: typeof res?.cpus === "number" && res.cpus >= 1 && res.cpus <= 256 ? Math.round(res.cpus) : null,
      memoryGb: typeof res?.memoryGb === "number" && res.memoryGb >= 0.5 && res.memoryGb <= 1024 ? res.memoryGb : null,
    };
    if (resources.cpus !== null || resources.memoryGb !== null) {
      steps.push(agentStep(s, companyId, "resources", { cpus: null, memoryGb: null }, resources, "", []));
    }
    const domain = (v: string) => v.toLowerCase();
    const grants: [PermissionKind, string[]][] = [
      ["network-allow", keep(list(raw.sandbox?.allow), domain, DOMAIN)],
      ["network-deny", keep(list(raw.sandbox?.deny), domain, DOMAIN)],
      ["mcp-server", keep(list(raw.mcp, 40), (v) => v, MCP_NAME)],
      ["skill", list(raw.skills, 60)],
    ];
    for (const [kind, values] of grants) {
      for (const value of values) {
        steps.push({ change: { kind: "grant", permission: kind, value }, text: GRANT_TEXT[kind], fromFile: [name, value], apply: (by) => void s.grant(companyId, kind, value, by) });
      }
    }
  }

  const boards = (Array.isArray(planFile.boards) ? planFile.boards : [])
    .filter((b) => b && typeof b.id === "string" && b.id.trim())
    .map((b, i): Board => ({ id: str(b.id, 20), title: str(b.title, 80) || "Board", status: b.status === "planned" || b.status === "done" ? b.status : "active", order: typeof b.order === "number" ? b.order : i }));
  const boardIds = new Set(boards.map((b) => b.id));
  const tasks = (Array.isArray(planFile.tasks) ? planFile.tasks : [])
    .filter((t) => t && typeof t.id === "string" && boardIds.has(t.boardId))
    .map(
      (t): Task => ({
        id: str(t.id, 40),
        boardId: t.boardId,
        title: str(t.title, 120),
        ownerId: typeof t.ownerId === "string" && PLAIN_ID.test(t.ownerId) ? t.ownerId : null,
        status: (["todo", "in-progress", "in-review", "done", "blocked"] as const).includes(t.status) ? t.status : "todo",
        needs: list(t.needs, 40),
        prNumber: typeof t.prNumber === "number" ? t.prNumber : null,
        description: str(t.description, 8000),
        files: list(t.files, 300),
        doneWhen: str(t.doneWhen, 2000),
        note: typeof t.note === "string" ? str(t.note, 300) : null,
      }),
    );
  return { steps, boards, tasks, skipped, dropped };
}

function agentStep(
  s: Company["settings"],
  companyId: string,
  field: "mode" | "cli" | "roleMd" | "workspacePath" | "displayRole" | "color" | "model" | "resources",
  before: unknown,
  after: unknown,
  text: string,
  fromFile: string[],
): Step {
  return { change: { kind: "agent", field, before, after }, text, fromFile, apply: (by) => s.updateAgent(companyId, { [field]: after }, by) };
}

/** Each board's task titles, for the preview (agent text: an agent may have written them). */
export function boardTitles(plan: ImportPlan): { title: string; tasks: string[] }[] {
  return plan.boards.map((b) => ({ title: b.title, tasks: plan.tasks.filter((t) => t.boardId === b.id).map((t) => t.title) }));
}

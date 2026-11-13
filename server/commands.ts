// Browser commands → server actions. Names match OfficeDataSource methods.
// Each one declares the lowest human role that may run it, when it needs the
// approval PIN (the approve, grant or relax direction, spec §9 item 2) and
// whether a remote session may run it. server/dashboard.ts enforces that.

import { SERVICE_KEYS, type AgentCli, type AgentConfig, type AgentPatch, type ReviewTool, type WelcomeInput, type NewMcpServer, type Board, type NewAgentInput, type ProjectConfig, type RemoveAgentOptions, type SandboxSettings, type SetupCheckId, type WorkflowPatch } from "../src/data/types";
import { LEAD_NAME, OFFICE_NAME_MAX } from "../src/data/names";
import { STACK_CATEGORIES, stackSkills, stackTool, type StackChoice, type StackConfig } from "../src/data/stack";
import { resolveAccess } from "./access";
import { ensureSkillCache } from "./skills";
import { run } from "./lib/exec";
import { agentPalette } from "../src/theme/tokens";
import type { Company } from "./company";
import { companyAgentId } from "./company/agents";
import { relaxes, type AgentField, type Authority, type ConfigChange } from "./company/authority";
import type { AgentSettingsPatch } from "./company/projectSettings";
import type { CommandCtx, CommandSpec } from "./dashboard";
import { applyImport, boardTitles, hasRepoConfig, previewImport, readImport } from "./repoConfigImport";
import { refreshProjectNotes } from "./projectNotesSync";
import { Hub } from "./hub";
import type { Inbox } from "./inbox";
import type { Planner } from "./planner";
import type { Sbx } from "./sbx";
import type { SbxMcp } from "./sbxMcp";
import type { Sessions } from "./sessions";
import { mergeByNotice } from "./githubSync";

/** A stack from the browser, checked against the catalog. Null when nothing is chosen. */
function cleanStack(raw: unknown): StackConfig | null {
  const input = (raw ?? {}) as Partial<StackConfig>;
  const choice = (c: unknown, category: string): StackChoice | null => {
    const v = (c ?? {}) as Partial<StackChoice>;
    const id = str(v.id, 40);
    const known = id === "other" || stackTool(id)?.category === category;
    if (!known) return null;
    const out: StackChoice = { id };
    if (typeof v.where === "string" && v.where.trim()) out.where = str(v.where, 120).trim();
    if (id === "other") {
      if (typeof v.name === "string" && v.name.trim()) out.name = str(v.name, 60).trim();
      if (typeof v.docsUrl === "string" && v.docsUrl.trim()) out.docsUrl = str(v.docsUrl, 300).trim();
    }
    return out;
  };
  const frameworks = (Array.isArray(input.frameworks) ? input.frameworks : []).slice(0, 10).map((f) => choice(f, "framework")).filter((f): f is StackChoice => !!f);
  const tools: StackConfig["tools"] = {};
  for (const c of STACK_CATEGORIES) {
    const picked = choice(input.tools?.[c.id], c.id);
    if (picked) tools[c.id] = picked;
  }
  return frameworks.length || Object.keys(tools).length ? { frameworks, tools } : null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "agent";
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** Whom a store write is done for: the owner with the PIN when dispatch checked it, else the owner's session (M0-D1). */
export const authorityOf = (ctx: CommandCtx): Authority => ({ via: ctx.pin === true ? "pin" : "session", humanId: ctx.actor.id });
/** A PIN rule from the store's own classifier, so the dashboard and the store cannot disagree (SR-D-03). */
const pinIf = (changes: (args: unknown[]) => ConfigChange[]) => (args: unknown[]) => changes(args).some(relaxes);
/** The first argument as an agent id or name, for the audit row. */
const first = (a: unknown[]) => (typeof a[0] === "string" ? a[0] : null);
/** A proxy as host:port only: the user-info part can hold a password (SR-C-17). */
const proxyHost = (u: string) => {
  try {
    return new URL(u).host || "the proxy";
  } catch {
    return "the proxy";
  }
};

export function makeCommands(hub: Hub, sessions: Sessions, planner: Planner, inbox: Inbox, sbx: Sbx, mcp: SbxMcp, company: Company) {
  /**
   * Runs an sbx change and reports it in the activity feed. For a command that
   * takes a secret, a failure is reported without sbx's text, which can repeat
   * the value (SR-C-17).
   */
  const attempt = async (agentId: string | null, what: string, fn: () => Promise<void>, secret = false) => {
    try {
      await fn();
      hub.activity("config", agentId, what);
    } catch (err) {
      const lower = what.charAt(0).toLowerCase() + what.slice(1);
      hub.activity("config", agentId, secret ? `Couldn't ${lower}.` : `Couldn't ${lower}: ${err instanceof Error ? err.message : err}`);
    }
  };
  const team = () => hub.snap.config.team;
  const cid = (id: string) => companyAgentId(hub.slug, id);
  const domains = (list: unknown[]) => [...new Set(list.map((d) => str(d, 200).trim().toLowerCase()).filter(Boolean))];
  /** Grants and revokes that would make an agent's list of one kind equal `want`. */
  const listChanges = (permission: "network-allow" | "network-deny" | "mcp-server" | "skill", have: string[], want: string[]): ConfigChange[] => [
    ...want.filter((v) => !have.includes(v)).map((value): ConfigChange => ({ kind: "grant", permission, value })),
    ...have.filter((v) => !want.includes(v)).map((value): ConfigChange => ({ kind: "revoke", permission, value })),
  ];
  /** An agent patch from the browser, as store settings. */
  const agentPatch = (agent: AgentConfig, raw: unknown): { patch: AgentSettingsPatch; skills: string[] | null } => {
    const p = (raw ?? {}) as AgentPatch;
    const patch: AgentSettingsPatch = {};
    if (typeof p.name === "string" && p.name.trim()) patch.name = str(p.name, 40).trim();
    if (typeof p.role === "string") patch.displayRole = str(p.role, 40);
    if (typeof p.color === "string") patch.color = str(p.color, 20);
    if (typeof p.model === "string") patch.model = str(p.model, 60);
    if (typeof p.roleMd === "string") patch.roleMd = str(p.roleMd, 8000);
    if (p.mode === "sandbox" || p.mode === "local") patch.mode = p.mode;
    if ((p.cli === "claude" || p.cli === "codex") && p.cli !== agent.cli) {
      patch.cli = p.cli;
      // Model names don't carry over between CLIs.
      if (typeof p.model !== "string") patch.model = "";
    }
    if (p.workspacePath !== undefined) patch.workspacePath = p.workspacePath ? str(p.workspacePath, 500).trim() || null : null;
    const skills = Array.isArray(p.skills) ? p.skills.map((x) => str(x, 60)).filter(Boolean) : null;
    return { patch, skills };
  };
  const agentChanges = (id: unknown, raw: unknown): ConfigChange[] => {
    const agent = hub.cfg(str(id, 80));
    if (!agent) return [];
    const { patch, skills } = agentPatch(agent, raw);
    const current: Record<string, unknown> = { name: agent.name, displayRole: agent.role, color: agent.color, model: agent.model, roleMd: agent.roleMd, mode: agent.mode, cli: agent.cli, workspacePath: agent.workspacePath };
    const out: ConfigChange[] = Object.entries(patch)
      .filter(([k, v]) => current[k] !== v)
      .map(([field, after]): ConfigChange => ({ kind: "agent", field: field as AgentField, before: current[field], after }));
    if (skills) out.push(...listChanges("skill", agent.skills, skills));
    return out;
  };
  const sandboxChanges = (id: unknown, raw: unknown): ConfigChange[] => {
    const agent = hub.cfg(str(id, 80));
    if (!agent) return [];
    const p = (raw ?? {}) as Partial<SandboxSettings>;
    return [
      ...(Array.isArray(p.allow) ? listChanges("network-allow", agent.sandbox.allow, domains(p.allow)) : []),
      ...(Array.isArray(p.deny) ? listChanges("network-deny", agent.sandbox.deny, domains(p.deny)) : []),
    ];
  };
  const workflowAfter = (raw: unknown) => {
    const p = (raw ?? {}) as WorkflowPatch;
    const wf = structuredClone(hub.snap.config.workflow);
    Object.assign(wf.review, p.review ?? {});
    if (p.merge?.by === "human" || p.merge?.by === "lead") wf.merge.by = p.merge.by;
    Object.assign(wf.deploy, p.deploy ?? {});
    return wf;
  };
  const projectGithub = (raw: unknown): string | undefined => {
    const p = (raw ?? {}) as Partial<ProjectConfig>;
    return typeof p.repo === "string" && p.repo.trim() ? str(p.repo, 200).trim() : undefined;
  };

  const commands: Record<string, CommandSpec> = {
    sendTerminalInput: { role: "owner", localOnly: true, audit: "collapsed", target: first, run: (_ctx, id, data) => sessions.input(str(id, 80), str(data, 100_000)) },
    openShell: { role: "owner", localOnly: true, target: first, run: (_ctx, id) => sessions.openShell(str(id, 80)) },
    closeShell: { role: "owner", target: first, run: (_ctx, id) => sessions.closeShell(str(id, 80)) },
    openHostShell: { role: "owner", localOnly: true, run: (_ctx, dir, fresh) => sessions.openHostShell(str(dir, 4096), fresh === true) },
    closeHostShell: { role: "owner", run: () => sessions.closeHostShell() },
    forwardPort: { role: "owner", target: first, run: (_ctx, agentId, port) => sbx.forwardPort(str(agentId, 80), num(port)) },
    unforwardPort: { role: "owner", target: first, run: (_ctx, agentId, port) => sbx.unforwardPort(str(agentId, 80), num(port)) },
    resizeTerminal: { role: "owner", localOnly: true, audit: "collapsed", target: first, run: (_ctx, id, cols, rows) => sessions.resize(str(id, 80), num(cols), num(rows)) },
    startAgent: { role: "owner", target: first, run: (_ctx, id) => sessions.start(str(id, 80)) },
    stopAgent: { role: "supervisor", target: first, run: (_ctx, id) => sessions.stop(str(id, 80)) },
    openWorkspace: { role: "owner", localOnly: true, target: first, run: (_ctx, id) => sessions.openWorkspace(str(id, 80)) },
    recreateSandbox: { role: "owner", target: first, run: (_ctx, id) => sessions.recreate(str(id, 80)) },
    recheckSetup: { role: "owner", run: async () => {
      await sessions.recheckSetup();
      await sbx.refresh();
    } },
    runSetupFix: { role: "owner", localOnly: true, target: first, run: (_ctx, id) => sessions.runFix(str(id, 40) as SetupCheckId) },

    // You → agent: same delivery path as the lead's assign_task / send_message.
    assignTask: { role: "owner", target: first, run: (_ctx, taskId, agentId) => planner.assign(str(taskId, 40), str(agentId, 80), "you") },
    sendMessage: { role: "owner", target: first, run: (_ctx, toId, text) => planner.message("you", str(toId, 80), str(text, 2000)) },

    addAgent: { role: "owner", pin: true, run: (ctx, raw) => {
      const input = (raw ?? {}) as Partial<NewAgentInput>;
      const name = str(input.name, 40).trim() || "Agent";
      // Never an id the company store has used: a retired agent's id is not given out again.
      const taken = (id: string) => team().some((a) => a.id === id) || !!company.agents.get(hub.slug, id);
      let id = slug(name);
      for (let i = 2; taken(id); i++) id = `${slug(name)}-${i}`;
      const used = new Set(team().map((a) => a.color));
      const color = agentPalette.find((c) => !used.has(c)) ?? agentPalette[team().length % agentPalette.length];
      const cli: AgentCli = input.cli === "codex" ? "codex" : "claude";
      const ctoId = planner.ctoId();
      // A new agent gets no grants: it never copies the lead's (SR-D-11).
      company.settings.addAgent(
        hub.slug,
        { id, name, cli, displayRole: str(input.role, 40).trim() || "Developer", color, mode: input.mode === "local" ? "local" : "sandbox", model: str(input.model, 60).trim() },
        "builder",
        authorityOf(ctx),
        ctoId ? (company.agents.get(hub.slug, ctoId)?.companyId ?? null) : null,
      );
      hub.configChanged();
      const status = hub.status(id);
      if (status) hub.emit({ type: "agent.updated", agent: structuredClone(status) });
      hub.activity("config", null, `Added ${name} (${hub.cfg(id)?.role ?? "Developer"}). Press Start to launch their session.`);
      if (cli === "codex") void sessions.recheckSetup();
    } },

    updateAgent: { role: "owner", pin: pinIf((a) => agentChanges(a[0], a[1])), target: first, run: (ctx, id, raw) => {
      const agent = hub.cfg(str(id));
      if (!agent) return;
      const before = `${agent.cli}/${agent.mode}`;
      const { patch, skills } = agentPatch(agent, raw);
      const by = authorityOf(ctx);
      company.settings.transaction(() => {
        company.settings.updateAgent(cid(agent.id), patch, by);
        if (skills) company.settings.setGrants(cid(agent.id), "skill", skills, by);
      });
      hub.configChanged();
      const after = hub.cfg(agent.id);
      // Codex agents add their own setup checks.
      if (after && `${after.cli}/${after.mode}` !== before) void sessions.recheckSetup();
    } },

    inspectWorkspace: { role: "owner", target: first, run: async (_ctx, id) => {
      const info = await sessions.inspectWorkspace(str(id, 80));
      if (info) hub.emit({ type: "workspace.info", info });
    } },

    removeAgent: { role: "owner", pin: true, target: first, run: async (ctx, id, opts) => {
      const agent = hub.cfg(str(id));
      if (!agent || agent.id === planner.ctoId()) return;
      const o = (opts ?? {}) as Partial<RemoveAgentOptions>;
      const removed = await sessions.removeResources(agent.id, { deleteSandbox: o.deleteSandbox !== false, deleteFolder: o.deleteFolder === true });
      hub.snap.agents = hub.snap.agents.filter((a) => a.agentId !== agent.id);
      // Retiring revokes the agent's secret, and its id is never given out again.
      const reg = company.agents.get(hub.slug, agent.id);
      if (reg && reg.status !== "retired") company.agents.setStatus(hub.slug, agent.id, "retired", ctx.actor);
      inbox.forget(agent.id);
      mcp.forget(agent.id);
      // Through the planner, so each change is written to the store first.
      for (const t of [...hub.snap.tasks])
        if (t.ownerId === agent.id && t.status !== "done") planner.updateTask(t.id, { ownerId: null, status: t.status === "in-progress" ? "todo" : t.status });
      hub.emit({ type: "agent.removed", agentId: agent.id });
      hub.configChanged();
      const what = removed.length ? ` Deleted: ${removed.join(" and ")}.` : "";
      const kept = removed.includes("folder") ? "" : " Their folder is kept.";
      hub.activity("config", null, `Removed ${agent.name}.${what}${kept}`);
    } },

    updateSandbox: { role: "owner", pin: pinIf((a) => sandboxChanges(a[0], a[1])), target: first, run: (ctx, id, raw) => {
      const agent = hub.cfg(str(id));
      if (!agent) return;
      const p = (raw ?? {}) as Partial<SandboxSettings>;
      const by = authorityOf(ctx);
      const rulesChanged = Array.isArray(p.allow) || Array.isArray(p.deny);
      company.settings.transaction(() => {
        // Each grant and revoke is checked in its own direction (SR-D-03).
        if (Array.isArray(p.allow)) company.settings.setGrants(cid(agent.id), "network-allow", domains(p.allow), by);
        if (Array.isArray(p.deny)) company.settings.setGrants(cid(agent.id), "network-deny", domains(p.deny), by);
        if (p.resources) {
          // Same limits as sbx: ≥1 CPU up to the host; 0.5 GB up to 75% of RAM.
          const m = hub.snap.setup.machine;
          const cpus = p.resources.cpus === null ? null : Math.round(Math.min(m.cpus, Math.max(1, num(p.resources.cpus))));
          const maxMem = Math.max(0.5, Math.floor(m.memoryGb * 0.75 * 2) / 2);
          const memoryGb = p.resources.memoryGb === null ? null : Math.min(maxMem, Math.max(0.5, Math.round(num(p.resources.memoryGb) * 2) / 2));
          company.settings.updateAgent(cid(agent.id), { resources: { cpus, memoryGb } }, by);
        }
      });
      hub.configChanged();
      // Applies now if the sandbox exists; otherwise on its first Start.
      if (rulesChanged) void sbx.syncRules(agent.id);
    } },

    setSecret: { role: "owner", pin: true, secret: true, target: first, run: (ctx, id, service, value) => {
      const agentId = id === null ? null : str(id, 80);
      const svc = str(service, 40);
      if (!(SERVICE_KEYS as readonly string[]).includes(svc) || typeof value !== "string" || !value.trim()) return;
      if (agentId && !hub.cfg(agentId)) return;
      // The store records which key the owner set for which agent, never the value (SR-D-10).
      return attempt(agentId, `Stored the ${svc} key ${agentId ? `for ${hub.name(agentId)}'s sandbox` : "for every sandbox"}`, async () => {
        await sbx.setKey(agentId, svc, value);
        if (agentId) company.settings.grant(cid(agentId), "secret-name", svc, authorityOf(ctx));
      }, true);
    } },
    removeSecret: { role: "owner", target: first, run: (ctx, id, service) => {
      const agentId = id === null ? null : str(id, 80);
      const svc = str(service, 40);
      if (!(SERVICE_KEYS as readonly string[]).includes(svc)) return;
      return attempt(agentId, `Removed the ${svc} key ${agentId ? `from ${hub.name(agentId)}'s sandbox` : "from every sandbox"}`, async () => {
        await sbx.removeKey(agentId, svc);
        if (agentId) company.settings.revoke(cid(agentId), "secret-name", svc, authorityOf(ctx));
      });
    } },
    setProxy: { role: "owner", pin: true, secret: true, run: (_ctx, url) => {
      const u = typeof url === "string" && url.trim() ? str(url, 300).trim() : null;
      if (u && !/^https?:\/\/[^\s]+$/i.test(u)) return hub.activity("config", null, "Proxy must be an http(s):// URL");
      return attempt(null, u ? `Set the sandbox proxy to ${proxyHost(u)}` : "Removed the sandbox proxy", () => sbx.setProxy(u), true);
    } },
    openEnvFile: { role: "owner", localOnly: true, target: first, run: async (_ctx, id) => {
      const agent = hub.cfg(str(id, 80));
      if (!agent) return;
      const file = sbx.ensureEnvFile(agent.id);
      const [cmd, args] = process.platform === "darwin" ? ["open", ["-t", file]] : process.platform === "win32" ? ["notepad", [file]] : ["xdg-open", [file]];
      await run(cmd, args, { timeoutMs: 5000 });
      await sbx.refresh();
    } },
    refreshSbx: { role: "owner", run: () => sbx.refresh() },

    resolveActionItem: { role: "owner", target: first, run: (_ctx, id, decision, note) => {
      const d = decision === "done" || decision === "dismissed" ? decision : null;
      if (d) planner.actions?.resolve(str(id, 40), d, typeof note === "string" ? str(note, 1000) : undefined);
    } },
    refreshMcp: { role: "owner", run: () => mcp.refresh() },
    addMcp: { role: "owner", pin: true, secret: true, run: (_ctx, raw) => {
      const v = (raw ?? {}) as Partial<NewMcpServer>;
      return mcp.add({
        name: str(v.name, 40),
        url: str(v.url, 500) || undefined,
        command: str(v.command, 300) || undefined,
        args: Array.isArray(v.args) ? v.args.slice(0, 20).map((a) => str(a, 200)) : undefined,
        apiKey: str(v.apiKey, 4000) || undefined,
      });
    } },
    // It opens a terminal on the host for sbx's sign-in: never from a remote session (PR #5 carry-forward).
    authMcp: { role: "owner", pin: true, localOnly: true, target: first, run: (_ctx, name) => mcp.authorize(str(name, 40)) },
    removeMcp: { role: "owner", target: first, run: (ctx, name) => mcp.remove(str(name, 40), authorityOf(ctx)) },
    setAgentMcp: { role: "owner", target: first,
      pin: pinIf((a) => {
        const agent = hub.cfg(str(a[0], 80));
        const want = Array.isArray(a[1]) ? a[1].map((n) => str(n, 40).trim().toLowerCase()).filter(Boolean) : [];
        return agent ? listChanges("mcp-server", agent.mcp ?? [], want) : [];
      }),
      run: (ctx, agentId, names) => mcp.setAgent(str(agentId, 80), Array.isArray(names) ? names.slice(0, 50).map((n) => str(n, 40)) : [], authorityOf(ctx)) },
    answerApproval: { role: "owner", pin: pinIf((a) => (a[2] === "allow" ? [{ kind: "grant", permission: "network-allow", value: "*" }] : [])), target: first, run: (ctx, agentId, approvalId, decision) => {
      const d = decision === "allow" || decision === "dismiss" ? decision : null;
      if (d) return sbx.answerApproval(str(agentId, 80), str(approvalId, 120), d, authorityOf(ctx));
    } },

    /** Saves the project's stack (sanitised against the catalog). The agents get it in ROLE.md on their next start. */
    updateStack: { role: "owner", pin: pinIf((a) => [{ kind: "project", field: "stack", before: hub.snap.config.stack ?? null, after: cleanStack(a[0]) }]), run: (ctx, raw) => {
      const stack = cleanStack(raw);
      company.settings.updateProject(hub.slug, { stack }, authorityOf(ctx));
      hub.configChanged();
      if (!stack) return;
      // Fetch the skills now so the next Start doesn't wait for them.
      const specs = stackSkills(stack);
      if (specs.length) void ensureSkillCache(hub.slug, specs).catch((e) => hub.activity("config", null, `Couldn't fetch agent skills: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`));
    } },

    resolveAccess: { role: "owner", pin: pinIf((a) => (a[1] === "agent" || a[1] === "everyone" ? [{ kind: "grant", permission: "network-allow", value: "*" }] : [])), target: first, run: (ctx, id, decision) => {
      const d = decision === "agent" || decision === "everyone" || decision === "deny" ? decision : null;
      if (d) return resolveAccess(hub, sbx, planner, company, str(id, 40), d, authorityOf(ctx));
    } },

    completeWelcome: { role: "owner", pin: true, run: async (ctx, raw) => {
      // The welcome (or an import) happens once: afterwards the settings change in Settings.
      if (!hub.snap.welcome || company.settings.has(hub.slug)) return;
      const input = (raw ?? {}) as Partial<WelcomeInput>;
      const cli = (c: unknown): AgentCli => (c === "codex" ? "codex" : "claude");
      const used = new Set<string>();
      // Ids an earlier team of this project used stay taken (the store keeps them).
      const registered = new Set(company.agents.list(hub.slug).map((a) => a.agentId));
      const make = (name: string, role: string, agentCli: AgentCli, isLead: boolean) => {
        const clean = str(name, 40).trim() || (isLead ? "Lead" : "Agent");
        let id = slug(clean);
        for (let i = 2; used.has(id) || registered.has(id); i++) id = `${slug(clean)}-${i}`;
        used.add(id);
        return { id, name: clean, cli: agentCli, displayRole: isLead ? "Lead" : str(role, 40).trim() || "Developer", color: agentPalette[used.size - 1] ?? agentPalette[0], mode: "sandbox" as const, model: "" };
      };
      const lead = make(input.lead?.name ?? LEAD_NAME, "Lead", cli(input.lead?.cli), true);
      const workers = (Array.isArray(input.workers) ? input.workers : []).slice(0, 11).map((w) => make(w?.name ?? "", w?.role ?? "", cli(w?.cli), false));
      if (!workers.length) return hub.activity("config", null, "Add at least one worker to the team.");
      const workflow = structuredClone(hub.snap.config.workflow);
      const tools: ReviewTool[] = ["coderabbit", "greptile", "copilot", "human", "custom"];
      if (tools.includes(input.reviewTool as ReviewTool)) workflow.review.tool = input.reviewTool as ReviewTool;
      if (typeof input.reviewEnabled === "boolean") workflow.review.enabled = input.reviewEnabled;
      const stack = cleanStack(input.stack);
      const by = authorityOf(ctx);
      const projectName = typeof input.projectName === "string" && input.projectName.trim() ? str(input.projectName, 80).trim() : null;
      // One transaction: the settings, the team (its lead is the CTO) and no grants.
      company.settings.transaction(() => {
        company.settings.create(hub.slug, { github: hub.repo.github ?? null, workflow, ...(stack ? { stack } : {}) }, by);
        if (projectName) company.settings.updateProject(hub.slug, { name: projectName }, by);
        const cto = company.settings.addAgent(hub.slug, lead, "cto", by);
        for (const w of workers) company.settings.addAgent(hub.slug, w, "builder", by, cto.companyId);
      });
      if (stack) {
        const specs = stackSkills(stack);
        if (specs.length) void ensureSkillCache(hub.slug, specs).catch(() => {}); // retried on Start
      }
      hub.snap.welcome = false;
      delete hub.snap.importable;
      delete hub.snap.importPreview;
      hub.configChanged();
      hub.snap.agents = hub.snap.config.team.map((a) => Hub.freshStatus(a.id));
      await sessions.recheckSetup();
      await sbx.refresh();
      hub.emit({ type: "snapshot", snapshot: structuredClone(hub.snap) });
      hub.activity("config", null, `Welcome! Team created: ${hub.snap.config.team.map((a) => a.name).join(", ")}. Press Start team when you're ready.`);
    } },

    /** Approves the CLAUDE.md the owner read, for agents' next start. Refused when the file changed since (D3). */
    approveProjectNotes: { role: "owner", pin: true, run: (ctx, sha) => {
      const state = refreshProjectNotes(hub, company);
      if (!state.pending || state.pending.sha256 !== str(sha, 64)) return hub.activity("config", null, "CLAUDE.md changed after you read it. Read it again before approving.");
      const version = company.notes.approve(hub.slug, state.pending.sha256, state.pending.text, authorityOf(ctx));
      refreshProjectNotes(hub, company);
      hub.activity("config", null, `Approved CLAUDE.md version ${version}. Agents get it at their next start.`);
    } },

    /** Shows the owner what importing .jsmhq/config.json would write. Reads the file; writes nothing (SR-D-02). */
    previewRepoImport: { role: "owner", run: () => {
      if (company.settings.has(hub.slug) || !hasRepoConfig(hub.repo.root)) return hub.activity("config", null, "There is nothing to import: this project's settings are already in HQ.");
      const { sha256, plan } = readImport(hub.repo.root, company, hub.slug);
      hub.snap.importPreview = { sha256, lines: previewImport(plan), boards: boardTitles(plan), tasks: plan.tasks.length };
      hub.emit({ type: "snapshot", snapshot: structuredClone(hub.snap) });
    } },

    /** Imports exactly what the owner previewed: refused when the files changed since (D3). */
    importRepoConfig: { role: "owner", pin: true, run: async (ctx, raw) => {
      const sha = str((raw as { sha256?: unknown } | null)?.sha256, 64);
      const refuse = (reason: string, text: string) => {
        company.audit.append({ actorKind: "human", actorId: ctx.actor.id, action: "settings.refused", target: hub.slug, data: { change: "import", reason, authority: authorityOf(ctx).via } });
        hub.activity("config", null, text);
      };
      if (company.settings.has(hub.slug)) return refuse("imported-already", "This project's settings are already in HQ, so the import can't run again.");
      if (!hasRepoConfig(hub.repo.root)) return refuse("no-file", "There is no .jsmhq/config.json to import.");
      const read = readImport(hub.repo.root, company, hub.slug);
      if (read.sha256 !== sha) return refuse("import-changed", "The repo's config changed after you reviewed it. Review the import again.");
      const by = authorityOf(ctx);
      const counts = company.settings.transaction(() => {
        const c = applyImport(read.plan, company, hub.slug, by);
        company.audit.append({ actorKind: "human", actorId: ctx.actor.id, action: "settings.imported", target: hub.slug, data: { sha256: read.sha256, ...c, authority: by.via } });
        return c;
      });
      hub.snap.welcome = false;
      delete hub.snap.importable;
      delete hub.snap.importPreview;
      hub.configChanged();
      const plan = company.plans.load(hub.slug);
      hub.snap.boards = plan.boards;
      hub.snap.tasks = plan.tasks;
      hub.snap.agents = hub.snap.config.team.map((a) => Hub.freshStatus(a.id));
      if (read.plan.skipped.length) hub.activity("config", null, `${read.plan.skipped.length} agent id(s) in the file were not plain ids (lower-case letters, digits and "-"), so they were not imported.`);
      await sessions.recheckSetup();
      hub.emit({ type: "snapshot", snapshot: structuredClone(hub.snap) });
      hub.activity("config", null, `Imported .jsmhq/config.json: ${counts.agents} agents, ${counts.grants} permissions, ${counts.tasks} tasks. HQ no longer reads that file.`);
    } },

    updateWorkflow: { role: "owner", pin: pinIf((a) => [{ kind: "workflow", before: hub.snap.config.workflow, after: workflowAfter(a[0]) }]), run: (ctx, patch) => {
      const mergeBy = hub.snap.config.workflow.merge.by;
      company.settings.updateWorkflow(hub.slug, workflowAfter(patch), authorityOf(ctx));
      hub.configChanged();
      const wf = hub.snap.config.workflow;
      // The lead was told the old rule; tell it the new one now, so no restart is needed.
      const leadId = planner.ctoId();
      if (leadId && wf.merge.by !== mergeBy) {
        const waiting = hub.snap.pullRequests.filter((pr) => pr.review === "passed" && !pr.merged && !pr.closed).map((pr) => pr.number);
        planner.notify(leadId, mergeByNotice(wf.merge.by, waiting));
      }
    } },

    updateProject: { role: "owner", pin: pinIf((a) => { const g = projectGithub(a[0]); return g === undefined ? [] : [{ kind: "project", field: "github", before: hub.snap.config.project.repo, after: g }]; }), run: (ctx, raw) => {
      const p = (raw ?? {}) as Partial<ProjectConfig>;
      const project = hub.snap.config.project;
      const patch: { name?: string; github?: string; officeName?: string; exportPlan?: boolean } = {};
      if (typeof p.name === "string" && p.name.trim()) patch.name = str(p.name, 80);
      const github = projectGithub(p);
      if (github !== undefined && github !== project.repo) patch.github = github;
      if (typeof p.officeName === "string") patch.officeName = p.officeName.trim().slice(0, OFFICE_NAME_MAX);
      const exportOn = typeof p.exportPlan === "boolean" && p.exportPlan && !project.exportPlan;
      if (typeof p.exportPlan === "boolean") patch.exportPlan = p.exportPlan;
      company.settings.updateProject(hub.slug, patch, authorityOf(ctx));
      hub.configChanged();
      if (exportOn) {
        hub.planChanged();
        hub.activity("config", null, "Plan export on: HQ writes docs/plan.md whenever the plan changes.");
      }
    } },

    createBoard: { role: "owner", run: (_ctx, title) => planner.createBoard(str(title, 80)) },

    updateBoard: { role: "owner", target: first, run: (_ctx, id, patch) => {
      const p = (patch ?? {}) as Partial<Board>;
      const status = p.status === "active" || p.status === "planned" || p.status === "done" ? p.status : undefined;
      planner.updateBoard(str(id, 20), { title: typeof p.title === "string" ? p.title : undefined, status });
    } },
  };

  return commands;
}

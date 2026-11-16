// The office store: the only place that talks to the data source.
// Components and the PixiJS scene read from here.

import { create } from "zustand";
import { createMockSource } from "../data/mock/mockSource";
import type { ConnectionStatus, DataPreset, OfficeDataSource, OfficeEvent, SimSpeed } from "../data/source";
import { chosenSource } from "../data/authState";
import { createWsSource } from "../data/ws/wsSource";
import type { StackConfig } from "../data/stack";
import type { AccessDecision, NewMcpServer, AgentConfig, AgentStatus, OfficeSnapshot, RemoveAgentOptions, SetupCheckId, SkillsPinFlow, SkillsPinPreview, WelcomeInput, WorkspaceInfo } from "../data/types";
import { appendTerminal, clearTerminals } from "./terminal";
import { ui, useUi } from "./ui";

/** The add-project dialog's state. */
export type AddProjectStatus = { state: "idle" | "adding" | "done" } | { state: "failed"; message?: string };

export interface LoggedEvent {
  n: number;
  at: number;
  event: OfficeEvent;
}

interface OfficeState {
  snap: OfficeSnapshot | null;
  epoch: number; // bumps on every full snapshot (e.g. a preset reload)
  events: LoggedEvent[]; // last 20, terminal output excluded
  terminalChunks: number;
  speed: SimSpeed;
  presets: DataPreset[] | null;
  live: boolean; // connected to a real HQ server (vs. the demo mock)
  workspaceInfo: Record<string, WorkspaceInfo>; // answers to inspectWorkspace
  connection: ConnectionStatus;
  source: OfficeDataSource;
  /** The add-project dialog's progress (M0-E): set when sent, settled by HQ's answer. */
  addProject: AddProjectStatus;
  /** Settings → Skills: a commit previewed, then confirmed with the PIN (M0-F). */
  skillsPin: SkillsPinFlow;
  /** A role's refused save, by role id, in HQ's words. Cleared by the next save of that role (M0-F). */
  skillsRoleErrors: Record<string, string>;
}

/**
 * main.tsx decides before this module loads: the real HQ when /auth/state
 * answers, the demo only under `pnpm dev` with no HQ (M0-C; data/authState.ts).
 */
const source: OfficeDataSource = chosenSource() === "hq" ? createWsSource() : createMockSource();

export const useOffice = create<OfficeState>(() => ({
  snap: null,
  epoch: 0,
  events: [],
  terminalChunks: 0,
  speed: 1,
  presets: source.dev?.presets ?? null,
  live: chosenSource() === "hq",
  workspaceInfo: {},
  connection: "connecting",
  addProject: { state: "idle" },
  skillsPin: { state: "idle" },
  skillsRoleErrors: {},
  source,
}));

let eventN = 0;

function upsert<T>(list: T[], item: T, same: (a: T) => boolean): T[] {
  const i = list.findIndex(same);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function reduce(snap: OfficeSnapshot, e: OfficeEvent): OfficeSnapshot {
  switch (e.type) {
    case "snapshot":
      return e.snapshot;
    case "workspace.info":
    case "command.result":
      return snap;
    case "projects.updated":
      return { ...snap, projects: e.projects };
    case "github.guard":
      return { ...snap, githubGuard: e.guard };
    case "skills.guard":
      return { ...snap, skillsGuard: e.guard };
    case "skills.updated":
      return { ...snap, skills: e.skills };
    case "sbx.updated":
      return { ...snap, sbx: e.sbx };
    case "setup.updated":
      return { ...snap, setup: e.setup };
    case "config.updated":
      return { ...snap, config: e.config };
    case "agent.updated":
      return { ...snap, agents: upsert(snap.agents, e.agent, (a) => a.agentId === e.agent.agentId) };
    case "agent.removed":
      return { ...snap, agents: snap.agents.filter((a) => a.agentId !== e.agentId) };
    case "board.updated":
      return { ...snap, boards: upsert(snap.boards, e.board, (b) => b.id === e.board.id) };
    case "task.updated":
      return { ...snap, tasks: upsert(snap.tasks, e.task, (t) => t.id === e.task.id) };
    case "task.removed":
      return { ...snap, tasks: snap.tasks.filter((t) => t.id !== e.taskId) };
    case "pr.updated":
      return { ...snap, pullRequests: upsert(snap.pullRequests, e.pr, (p) => p.number === e.pr.number) };
    case "env.updated":
      return { ...snap, environments: upsert(snap.environments, e.env, (x) => x.name === e.env.name) };
    case "env.removed":
      return { ...snap, environments: snap.environments.filter((x) => x.name !== e.name) };
    case "message":
      return { ...snap, messages: [e.message, ...snap.messages].slice(0, 100) };
    case "activity":
      return { ...snap, activity: [e.event, ...snap.activity].slice(0, 50) };
    case "terminal.output":
      return snap;
    case "action.updated":
      return { ...snap, actionItems: upsert(snap.actionItems ?? [], e.item, (i) => i.id === e.item.id) };
    case "mcp.updated":
      return { ...snap, mcp: e.mcp };
    case "access.updated":
      return { ...snap, accessRequests: upsert(snap.accessRequests ?? [], e.request, (r) => r.id === e.request.id) };
    case "projectNotes.updated":
      return { ...snap, projectNotes: e.projectNotes };
  }
}

function handle(e: OfficeEvent) {
  if (e.type === "terminal.output") {
    appendTerminal(e.agentId, e.data);
    useOffice.setState((s) => ({ terminalChunks: s.terminalChunks + 1 }));
    return;
  }
  if (e.type === "workspace.info") {
    useOffice.setState((s) => ({ workspaceInfo: { ...s.workspaceInfo, [e.info.agentId]: e.info } }));
    return;
  }
  // A refused command that says why (adding a project): shown in the activity feed, in this browser only.
  if (e.type === "command.result" && !e.ok && e.message) {
    const note = { id: `local-${Date.now()}`, at: new Date().toISOString(), type: "config" as const, agentId: null, text: e.message };
    useOffice.setState((s) => (s.snap ? { snap: { ...s.snap, activity: [note, ...s.snap.activity].slice(0, 50) } } : {}));
  }
  if (e.type === "snapshot") clearTerminals();
  useOffice.setState((s) => {
    const base = s.snap ?? (e.type === "snapshot" ? e.snapshot : null);
    if (!base) return {};
    eventN += 1;
    return {
      snap: reduce(base, e),
      epoch: e.type === "snapshot" ? s.epoch + 1 : s.epoch,
      events: [{ n: eventN, at: Date.now(), event: e }, ...s.events].slice(0, 20),
    };
  });
}

/**
 * What a command's answer changes in the store. The add-project dialog and the skills pin flow follow their own
 * commands; a PIN prompt in between (pin-required, pin-wrong, pin-locked) leaves them waiting where they are.
 */
export function settleCommand(cmd: string, e: { ok: boolean; error?: string; message?: string; data?: unknown }, args: unknown[] = []): void {
  const pinPrompt = e.error === "pin-required" || e.error === "pin-wrong" || e.error === "pin-locked";
  if (cmd === "addProject" && useOffice.getState().addProject.state === "adding") {
    if (e.ok) useOffice.setState({ addProject: { state: "done" } });
    else if (e.error !== "pin-required" && e.error !== "pin-wrong") useOffice.setState({ addProject: { state: "failed", message: e.message } });
  } else if (cmd === "previewSkillsPin") {
    const preview = e.ok ? asSkillsPreview(e.data) : null;
    useOffice.setState({ skillsPin: preview ? { state: "ready", preview } : { state: "failed", message: e.message ?? "HQ could not preview that commit." } });
  } else if (cmd === "pinSkills") {
    if (e.ok) useOffice.setState({ skillsPin: { state: "idle" } });
    else if (!pinPrompt) {
      useOffice.setState((s) => (s.skillsPin.state === "ready" ? { skillsPin: { ...s.skillsPin, error: e.message ?? "HQ did not pin it." } } : {}));
    }
  } else if (cmd === "setRoleSkills") {
    const role = typeof args[0] === "string" ? args[0] : null;
    if (!role || pinPrompt) return;
    useOffice.setState((s) => {
      const { [role]: _gone, ...rest } = s.skillsRoleErrors;
      return { skillsRoleErrors: e.ok ? rest : { ...rest, [role]: e.message ?? "HQ did not save that role's skills." } };
    });
  }
}

let disconnect: (() => void) | null = null;

export function connectOffice() {
  if (disconnect) return disconnect;
  source.onCommandResult?.(settleCommand);
  disconnect = source.connect(handle, (connection) => useOffice.setState({ connection }));
  return () => {
    disconnect?.();
    disconnect = null;
  };
}

// ---------------------------------------------------------------- actions

/** The preview HQ sent, or null when it is not shaped like one (the panel then says the preview failed). */
export function asSkillsPreview(data: unknown): SkillsPinPreview | null {
  const d = data as Partial<SkillsPinPreview> | null;
  if (!d || typeof d !== "object") return null;
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const ok =
    typeof d.repo === "string" && typeof d.commit === "string" && typeof d.lockHash === "string" &&
    Array.isArray(d.skills) && d.skills.every((s) => s && typeof s.name === "string" && typeof s.hash === "string" && typeof s.files === "number" && strings(s.scripts)) &&
    Array.isArray(d.refused) && d.refused.every((r) => r && typeof r.skill === "string" && typeof r.reason === "string") &&
    strings(d.added) && strings(d.changed) && strings(d.removed) &&
    Array.isArray(d.rolesLosing) && d.rolesLosing.every((r) => r && typeof r.role === "string" && strings(r.skills)) &&
    Array.isArray(d.findings) && d.findings.every((f) => f && typeof f.name === "string" && typeof f.detail === "string") &&
    !!d.links && typeof d.links.commit === "string";
  return ok ? (d as SkillsPinPreview) : null;
}

export const officeActions = {
  /** Reads a commit of the skills repo and shows what pinning it would change (nothing is changed). */
  previewSkillsPin(repo: string, commit: string) {
    if (!useOffice.getState().live) return void useOffice.setState({ skillsPin: { state: "failed", message: "The demo has no skills repo." } });
    useOffice.setState({ skillsPin: { state: "previewing" } });
    source.previewSkillsPin(repo, commit);
  },
  /** The confirm: it sends back exactly what was previewed. HQ asks for the PIN. */
  pinSkills: (repo: string, commit: string, lockHash: string) => source.pinSkills(repo, commit, lockHash),
  setRoleSkills(role: string, names: string[]) {
    // The earlier refusal is stale the moment the owner tries again.
    useOffice.setState((s) => {
      const { [role]: _gone, ...rest } = s.skillsRoleErrors;
      return { skillsRoleErrors: rest };
    });
    source.setRoleSkills(role, names);
  },
  resetSkillsPin: () => useOffice.setState({ skillsPin: { state: "idle" } }),
  /** Sends a command again with the approval PIN (the PIN dialog). */
  sendWithPin: (cmd: string, args: unknown[], pin: string) => source.sendWithPin?.(cmd, args, pin),
  /** Views another project. What belonged to the last one (drawers, the selected agent, terminal tabs) is closed. */
  selectProject(id: string) {
    if (useOffice.getState().snap?.projectId === id) return;
    ui.closeDrawer();
    ui.closeSettings();
    useUi.setState({ hover: null, planBoardId: null, setupOpen: false });
    useOffice.setState({ workspaceInfo: {} });
    source.selectProject(id);
  },
  addProject(path: string) {
    useOffice.setState({ addProject: { state: "adding" } });
    source.addProject(path);
  },
  resetAddProject: () => useOffice.setState({ addProject: { state: "idle" } }),
  confirmProjectRepo: (id: string) => source.confirmProjectRepo(id),
  createGithubIdentity: (agentId: string) => source.createGithubIdentity(agentId),
  applyRepoGuard: () => source.applyRepoGuard(),
  confirmSpendingLimit: () => source.confirmSpendingLimit(),
  recheckRepoGuard: () => source.recheckRepoGuard(),
  previewRepoImport: () => source.previewRepoImport(),
  importRepoConfig: (sha256: string) => source.importRepoConfig(sha256),
  approveProjectNotes: (sha256: string) => source.approveProjectNotes(sha256),
  sendTerminalInput: (agentId: string, data: string) => source.sendTerminalInput(agentId, data),
  resizeTerminal: (agentId: string, cols: number, rows: number) => source.resizeTerminal(agentId, cols, rows),
  startAgent: (id: string) => source.startAgent(id),
  stopAgent: (id: string) => source.stopAgent(id),
  openWorkspace: (id: string) => source.openWorkspace(id),
  recreateSandbox: (id: string) => source.recreateSandbox(id),
  openShell: (id: string) => source.openShell(id),
  closeShell: (id: string) => source.closeShell(id),
  openHostShell: (dir: string, fresh?: boolean) => source.openHostShell(dir, fresh),
  closeHostShell: () => source.closeHostShell(),
  forwardPort: (agentId: string, port: number) => source.forwardPort(agentId, port),
  unforwardPort: (agentId: string, port: number) => source.unforwardPort(agentId, port),
  recheckSetup: () => source.recheckSetup(),
  runSetupFix: (id: SetupCheckId) => source.runSetupFix(id),
  assignTask: (taskId: string, agentId: string) => source.assignTask(taskId, agentId),
  sendMessage: (toId: string, text: string) => source.sendMessage(toId, text),
  addAgent: source.addAgent.bind(source),
  updateAgent: source.updateAgent.bind(source),
  removeAgent: (id: string, opts?: RemoveAgentOptions) => source.removeAgent(id, opts),
  inspectWorkspace: (id: string) => source.inspectWorkspace(id),
  updateSandbox: source.updateSandbox.bind(source),
  setSecret: (agentId: string | null, service: string, value: string) => source.setSecret(agentId, service, value),
  removeSecret: (agentId: string | null, service: string) => source.removeSecret(agentId, service),
  setProxy: (url: string | null) => source.setProxy(url),
  openEnvFile: (id: string) => source.openEnvFile(id),
  refreshSbx: () => source.refreshSbx(),
  answerApproval: (agentId: string, approvalId: string, decision: "allow" | "dismiss") => source.answerApproval(agentId, approvalId, decision),
  updateWorkflow: source.updateWorkflow.bind(source),
  updateProject: source.updateProject.bind(source),
  createBoard: source.createBoard.bind(source),
  updateBoard: source.updateBoard.bind(source),
  completeWelcome: (input: WelcomeInput) => source.completeWelcome(input),
  updateStack: (stack: StackConfig | null) => source.updateStack(stack),
  resolveActionItem: (id: string, decision: "done" | "dismissed", note?: string) => source.resolveActionItem(id, decision, note),
  refreshMcp: () => source.refreshMcp(),
  addMcp: (input: NewMcpServer) => source.addMcp(input),
  authMcp: (name: string) => source.authMcp(name),
  removeMcp: (name: string) => source.removeMcp(name),
  setAgentMcp: (agentId: string, names: string[]) => source.setAgentMcp(agentId, names),
  resolveAccess: (requestId: string, decision: AccessDecision) => source.resolveAccess(requestId, decision),
  simulateAccessRequest: () => source.dev?.simulateAccessRequest(),
  setSpeed(speed: SimSpeed) {
    source.dev?.setSpeed(speed);
    useOffice.setState({ speed });
  },
  loadPreset(id: string) {
    source.dev?.loadPreset(id);
  },
};

// ---------------------------------------------------------------- selectors

export interface AgentView {
  config: AgentConfig;
  status: AgentStatus;
}

/** Team in config order, joined with live status. */
export function selectTeam(snap: OfficeSnapshot | null): AgentView[] {
  if (!snap) return [];
  return snap.config.team.flatMap((config) => {
    const status = snap.agents.find((a) => a.agentId === config.id);
    return status ? [{ config, status }] : [];
  });
}

export const reviewToolLabel = {
  coderabbit: "CodeRabbit",
  greptile: "Greptile",
  copilot: "Copilot",
  human: "Human review",
  custom: "Custom check",
} as const;

export const deployToolLabel = { instacloud: "InstaCloud", vercel: "Vercel", custom: "Custom deploy" } as const;

export { selectAttention } from "./attention";

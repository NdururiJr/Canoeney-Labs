// Agent sessions: start/stop through the session backend (tmux on macOS and
// Linux), a live terminal view of each for the browser, and the setup
// checklist's "Run in terminal" helper.

import { spawn as spawnPty, type IPty } from "@lydell/node-pty";
import { existsSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { stackSkills } from "../src/data/stack";
import { hasHqSkills, prepareSkills, skillSkippedText } from "./skills";
import { refreshProjectNotes } from "./projectNotesSync";
import { resolve, sep } from "node:path";
import { HOST_TERMINAL, type AgentCli, type AgentConfig, type SetupCheckId, type WorkspaceInfo } from "../src/data/types";
import { adapters, localBinary } from "./adapters";
import type { Company } from "./company";
import { companyAgentId, type Actor } from "./company/agents";
import type { Hub } from "./hub";
import { sessionBackend, type LaunchSpec, type TermHandle } from "./backends";
import { resolveCommand } from "./backends/pty";
import { loadEnvFile } from "./backends/tmux";
import { sandboxList } from "./lib/json";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { projectHome, sessionName } from "./paths";
import { POLICY_NOT_INITIALIZED, policyVerdict, runSetupChecks } from "./setup";
import { ensureWorkspace, workspaceFor, WorkspaceRefusedError } from "./workspace";

const TERM_ENV = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>;
/**
 * Shells you type in (Shell tab, Terminal panel): CLIs print links as real links (OSC 8), so a long
 * URL stays one clickable link instead of being cut across lines. Not for agent sessions: tmux
 * drops OSC 8 links unless the outer terminal declares support, which would hide the URL.
 */
const SHELL_ENV = { ...TERM_ENV, FORCE_HYPERLINK: "1" };
/**
 * sbx's opener inside a sandbox: sends the URL to this machine's browser. npm's `open` package
 * (used by many CLIs) ignores xdg-open on PATH and only uses it when BROWSER says so.
 */
const SANDBOX_BROWSER = "/usr/local/bin/xdg-open";

// What the agents' screens show (Claude Code and Codex).
const BUSY = /esc to interrupt/i; // the footer while a turn runs
// A question or permission prompt (Claude Code's wording; the numbered-option line also covers Codex's).
const DIALOG = /Enter to select|↑\/↓ to navigate|Do you want to (proceed|make this edit|create)|Would you like to|^\s*[❯›]\s*1\.\s/im;
const PROMPT_READY = /⏵⏵|\? for shortcuts|Ask Codex to do anything/; // the input prompt is up
const SCREEN_QUIET_MS = 4000; // only second-guess hooks after this much silence
const STALE_WORKING_MS = 15_000; // "working" with an idle screen this long = a missed Stop

/**
 * The `sbx run` arguments for an agent session. No BROWSER: a company agent does
 * not get the opener that sends URLs to the host browser (SR-C-15). The opener sbx
 * installs can still be run by name inside the sandbox; ADR 0007 records that.
 */
export function sbxRunArgs(o: { name: string; size: string[]; envFile: string | null; sbxAgent: string; dir: string; launchArgs: string[] }): string[] {
  const env = o.envFile ? ["--env-file", o.envFile] : [];
  const args = o.launchArgs.length ? ["--", ...o.launchArgs] : [];
  return ["run", "--name", o.name, ...o.size, ...env, o.sbxAgent, o.dir, ...args];
}

/** Starts bash (else sh) in a sandbox, with links and browser opening set up (see SHELL_ENV, SANDBOX_BROWSER). */
const SANDBOX_SHELL = `export FORCE_HYPERLINK=1; [ -x ${SANDBOX_BROWSER} ] && export BROWSER=${SANDBOX_BROWSER}; command -v bash >/dev/null && exec bash -l || exec sh -l`;

const HQ_ACTOR: Actor = { kind: "hq", id: "hq" };

export class Sessions {
  readonly backend = sessionBackend();
  private terms = new Map<string, TermHandle>();
  private sizes = new Map<string, { cols: number; rows: number }>();
  private fixes = new Map<string, IPty>();
  /** "Shell" tab: a plain shell in the agent's sandbox (or folder), separate from its agent session. */
  private shells = new Map<string, IPty>();
  private closing = new WeakSet<IPty>(); // closed on purpose: no "[shell closed]" line
  private shellGen = new Map<string, number>();
  private policyOk = false;
  /** Called whenever an agent's Claude Code session goes away (stop, restart, crash). */
  onSessionDown: (agentId: string) => void = () => {};
  /** Called once an agent's sandbox exists after Start (to apply its network rules). */
  onSandboxReady: (agentId: string) => void = () => {};
  /** Called when an agent's sandbox is removed or recreated (what was attached to it is gone). */
  onSandboxRemoved: (agentId: string) => void = () => {};
  /** The agent's env file, if it has one (passed with --env-file / sourced). */
  envFileFor: (agentId: string) => string | null = () => null;
  /** Called when HQ reattaches to a session that was already running (e.g. after an HQ restart). */
  onSessionReattached: (agentId: string) => void = () => {};
  /** When the agent's last hook arrived (from the inbox). */
  lastHookAt: (agentId: string) => number = () => 0;
  private polling: NodeJS.Timeout | null = null;
  /** Consecutive polls that saw a "working" agent's screen sitting idle. */
  private idleScreens = new Map<string, number>();

  /** `company`: the registry decides who may start, and issues each session its own secret (M0-B). */
  constructor(private hub: Hub, private company: Company) {}

  private name(agentId: string) {
    return sessionName(this.hub.slug, agentId);
  }

  /** Revokes the agent's live secret: HQ ended its session, so no one should use it any more. */
  private revokeSecret(agentId: string) {
    try {
      this.company.secrets.revoke(companyAgentId(this.hub.slug, agentId), "stopped");
    } catch (err) {
      log.warn(`could not revoke ${agentId}'s secret: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** HQ found a session it did not start. One started before per-agent secrets still holds the old shared key. */
  private noteOldKey(agentId: string) {
    let live = true;
    try {
      live = this.company.secrets.hasLive(companyAgentId(this.hub.slug, agentId));
    } catch {
      /* an id the registry refuses: nothing to say */
    }
    if (live) return;
    const name = this.hub.name(agentId);
    this.hub.activity("session", agentId, `${name} is running with an old HQ key. Restart ${name} once so it gets its own.`);
  }

  // ------------------------------------------------------------ lifecycle

  // Start, stop, recreate and remove run one at a time per agent (a lane), so a
  // stop pressed while the agent is still starting waits and then stops it: the
  // agent ends stopped, with no live secret (M0-B carry-forward).
  /** A refused folder leaves an audit row: who asked, which agent, and why; never the folder's content. */
  private auditRefusal(id: string, err: WorkspaceRefusedError, by: Actor) {
    try {
      this.company.audit.append({ actorKind: by.kind, actorId: by.id, action: "workspace.refused", target: companyAgentId(this.hub.slug, id), data: { reason: err.reason } });
    } catch {
      /* the refusal stands even if it cannot be recorded */
    }
  }

  private lanes = new Map<string, Promise<unknown>>();
  private lane<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.lanes.get(id) ?? Promise.resolve()).then(fn, fn);
    this.lanes.set(id, next.catch(() => {}));
    return next;
  }

  /** `by` is who asked (the owner from the dashboard); a refused folder is audited with it. */
  start(id: string, by: Actor = HQ_ACTOR) {
    return this.lane(id, () => this.startNow(id, by));
  }

  stop(id: string) {
    return this.lane(id, () => this.stopNow(id));
  }

  removeResources(id: string, opts: { deleteSandbox: boolean; deleteFolder: boolean }): Promise<string[]> {
    return this.lane(id, () => this.removeResourcesNow(id, opts));
  }

  recreate(id: string) {
    return this.lane(id, () => this.recreateNow(id));
  }

  private async startNow(id: string, by: Actor = HQ_ACTOR) {
    const hub = this.hub;
    const agent = hub.cfg(id);
    const st = hub.status(id);
    if (!agent || !st || st.session.state === "running" || st.session.state === "starting") return;
    const setup = hub.snap.setup;
    const fail = (detail: string) => {
      hub.setSession(id, { state: "failed", detail });
      hub.setStatus(id, { state: "idle", note: "Could not start" });
      hub.activity("session", id, `${agent.name} could not start: ${detail.split("\n")[0]}`);
    };
    if (!setup.checks.find((c) => c.id === "tmux" && c.status === "ok")) return fail("tmux is not installed. See the setup checklist.");
    if (agent.mode === "sandbox" && !setup.sandboxReady) return fail("Docker Sandboxes isn't ready on this machine. Finish the setup checklist, or switch this agent to Local mode.");
    const check = (cid: string) => setup.checks.find((c) => c.id === cid)?.status;
    if (agent.mode === "local" && agent.cli === "claude" && check("claude") !== "ok") return fail("Claude Code isn't installed. See the setup checklist.");
    if (agent.mode === "local" && agent.cli === "codex" && check("codex") !== "ok") return fail("Codex isn't installed on this machine. See the setup checklist, or run this agent in a sandbox.");
    if (agent.mode === "sandbox" && agent.cli === "codex" && check("openai-secret") !== "ok")
      return fail("Codex needs an OpenAI key in sbx. Run `sbx secret set openai --oauth` (Setup checklist → Run in terminal).");

    // Who may start, and as what, comes from the company store (M0-B).
    const reg = this.company.agents.get(hub.slug, id);
    if (!reg) return fail("This agent is not in the company store. Add it from the dashboard.");
    if (reg.status === "paused") return fail("This agent is paused.");
    if (reg.status === "retired") return fail("This agent was retired.");

    const name = this.name(id);
    this.onSessionDown(id);
    let issued = false;
    try {
      hub.setSession(id, { state: "starting", detail: "Preparing folder…", workspace: workspaceFor(agent, hub.slug) });
      const dir = await ensureWorkspace(agent, hub.slug, hub.repo);
      const adapter = adapters[agent.cli];
      // A session that is still running (tmux outlives HQ) keeps the secret and the
      // files it was started with. HQ keeps only a hash of the secret, so it could
      // not write the same one again (ADR 0005): reattach and write nothing.
      if (await this.backend.exists(name)) this.noteOldKey(id);
      else {
        // App variables reach the agent in sandbox mode and in Local mode with tmux (not Local on Windows).
        const hasEnvFile = !!this.envFileFor(id) && (agent.mode === "sandbox" || this.backend.persistent);
        const secret = this.company.secrets.issue(reg.companyId);
        issued = true;
        const ctoId = this.company.agents.cto(hub.slug, (cid) => !!hub.cfg(cid))?.agentId ?? null;
        // The owner sees a changed CLAUDE.md as pending; the agent gets only the approved copy (SR-D-07).
        refreshProjectNotes(hub, this.company);
        const approved = this.company.notes.current(hub.slug);
        const notes = approved ? { version: approved.version, content: approved.content } : null;
        await adapter.writeFiles(dir, agent, hub.snap.config, secret, { hasEnvFile, role: reg.role, ctoId, notes });
        const specs = stackSkills(hub.snap.config.stack);
        if (specs.length || hasHqSkills(hub.slug, dir)) {
          hub.setSession(id, { detail: "Installing agent skills…" });
          const skills = await prepareSkills(hub.slug, dir, specs);
          if (skills.error) hub.activity("session", id, `${agent.name}: some agent skills didn't install (${skills.error.slice(0, 120)}). Starting anyway.`);
          for (const rel of skills.skipped) hub.activity("session", id, skillSkippedText(agent.name, rel));
        }
        const launch = adapter.launch(agent, dir);
        const envFile = this.envFileFor(id);
        // Local mode: the agent gets the env file's variables (tmux only: there's no shell to load them into otherwise).
        let spec: LaunchSpec = { file: localBinary[agent.cli], args: launch.args, envFile };
        if (agent.mode === "local" && envFile && !this.backend.persistent)
          hub.activity("session", id, `${agent.name}'s env file isn't loaded in Local mode on Windows. Use Sandbox mode for app variables.`);
        if (agent.mode === "sandbox") {
          hub.setSession(id, { detail: "Allowing the sandbox to reach HQ…" });
          await this.ensurePolicy();
          hub.setSession(id, { detail: "Starting sandbox…" });
          // sbx only accepts a size when it creates the sandbox; an existing (stopped) one keeps its size,
          // and passing --cpus/--memory again makes `sbx run` fail. "Recreate sandbox" applies a new size.
          const { cpus, memoryGb } = agent.sandbox.resources;
          const isNew = !(await this.sandboxExists(name));
          const size = !isNew ? [] : [...(cpus ? ["--cpus", String(cpus)] : []), ...(memoryGb ? ["--memory", `${Math.round(memoryGb * 1024)}m`] : [])];
          spec = { file: "sbx", args: sbxRunArgs({ name, size, envFile, sbxAgent: launch.sbxAgent, dir, launchArgs: launch.args }), envFile: null };
        }
        await this.backend.create(name, dir, spec, { cols: 200, rows: 50 });
      }
      this.attach(id);
      hub.setSession(id, { state: "running", detail: null, workspace: dir });
      hub.setStatus(id, { state: "idle", note: agent.mode === "sandbox" ? "Sandbox running" : "Running locally" });
      hub.activity("session", id, `${agent.name} started (${agent.cli === "codex" ? "Codex" : "Claude Code"}, ${agent.mode === "sandbox" ? "Docker Sandbox" : "Local mode"})`);
      if (agent.mode === "sandbox") {
        setTimeout(() => void this.refreshSandboxSizes(), 4000);
        void this.whenSandboxExists(id).then((ok) => ok && this.onSandboxReady(id));
      }
    } catch (err) {
      // A secret this call issued has no session to use it. A reattached
      // session's secret is left alone: that agent is still running.
      if (issued) this.revokeSecret(id);
      if (err instanceof WorkspaceRefusedError) this.auditRefusal(id, err, by);
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  private async stopNow(id: string) {
    const hub = this.hub;
    const agent = hub.cfg(id);
    if (!agent) return;
    const name = this.name(id);
    this.onSessionDown(id);
    this.detach(id);
    this.closeShell(id);
    await this.backend.kill(name);
    this.revokeSecret(id);
    // Stop (not remove) the VM so it can resume later with its state.
    if (agent.mode === "sandbox") void run("sbx", ["stop", name], { timeoutMs: 30_000 });
    hub.setSession(id, { state: "stopped", detail: null });
    hub.setStatus(id, { state: "idle", currentTaskId: null, note: "Stopped" });
    hub.activity("session", id, `${agent.name} stopped`);
  }

  /** What removing this agent would delete: folder state and whether a sandbox exists. */
  async inspectWorkspace(id: string): Promise<WorkspaceInfo | null> {
    const agent = this.hub.cfg(id);
    if (!agent) return null;
    const dir = workspaceFor(agent, this.hub.slug);
    const exists = existsSync(dir);
    let changedFiles = 0;
    let unpushedCommits = 0;
    if (exists) {
      const status = await run("git", ["status", "--porcelain"], { cwd: dir });
      changedFiles = status.stdout.split("\n").filter(Boolean).length;
      // Commits on any local branch that no remote-tracking ref has.
      const log = await run("git", ["log", "--oneline", "--branches", "--not", "--remotes"], { cwd: dir });
      unpushedCommits = log.stdout.split("\n").filter(Boolean).length;
    }
    const name = this.name(id);
    const ls = await run("sbx", ["ls", "--json"], { timeoutMs: 10_000 });
    let sandboxExists = false;
    try {
      sandboxExists = ls.ok && (sandboxList(ls.stdout) ?? []).some((s) => s.name === name);
    } catch {
      /* sbx unavailable */
    }
    return { agentId: id, path: dir, managed: !agent.workspacePath, exists, changedFiles, unpushedCommits, sandboxName: name, sandboxExists };
  }

  /** Stops the agent and deletes what was asked. Only HQ-made folders inside HQ's home can be deleted. */
  private async removeResourcesNow(id: string, opts: { deleteSandbox: boolean; deleteFolder: boolean }): Promise<string[]> {
    const agent = this.hub.cfg(id);
    if (!agent) return [];
    const done: string[] = [];
    const name = this.name(id);
    this.onSessionDown(id);
    this.detach(id);
    this.closeShell(id);
    await this.backend.kill(name);
    if (opts.deleteSandbox) {
      const rm = await run("sbx", ["rm", "-f", name], { timeoutMs: 60_000 });
      if (rm.ok) (done.push("sandbox"), this.onSandboxRemoved(id));
      else if (!/not found|no such/i.test(rm.stderr)) log.warn(`sbx rm ${name}: ${rm.stderr.trim()}`);
    } else if (agent.mode === "sandbox") void run("sbx", ["stop", name], { timeoutMs: 30_000 });
    if (opts.deleteFolder && !agent.workspacePath) {
      const home = resolve(projectHome(this.hub.slug));
      const dir = resolve(workspaceFor(agent, this.hub.slug));
      if (dir.startsWith(home + sep) && dir !== home && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        done.push("folder");
      }
    }
    return done;
  }

  /** True if sbx lists a sandbox with this name (running or stopped). */
  private async sandboxExists(name: string): Promise<boolean> {
    const r = await run("sbx", ["ls", "--json"], { timeoutMs: 10_000 });
    try {
      return (sandboxList(r.stdout) ?? []).some((s) => s.name === name);
    } catch {
      return false;
    }
  }

  /** Waits (up to ~90s) for sbx to list the agent's sandbox — creation can take a while the first time. */
  private async whenSandboxExists(id: string): Promise<boolean> {
    for (let i = 0; i < 45; i++) {
      const r = await run("sbx", ["ls", "--json"], { timeoutMs: 10_000 });
      try {
        if ((sandboxList(r.stdout) ?? []).some((s) => s.name === this.name(id))) return true;
      } catch {
        /* keep waiting */
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    return false;
  }

  /** Removes the agent's sandbox and starts a fresh one (applies new CPU/memory). The folder is kept. */
  private async recreateNow(id: string) {
    const agent = this.hub.cfg(id);
    if (!agent || agent.mode !== "sandbox") return;
    const name = this.name(id);
    if (this.hub.status(id)?.session.state === "running") await this.stopNow(id);
    this.hub.setSession(id, { state: "starting", detail: "Removing the old sandbox…", sandbox: null });
    const rm = await run("sbx", ["rm", "-f", name], { timeoutMs: 60_000 });
    if (!rm.ok && !/not found|no such/i.test(rm.stderr)) {
      this.hub.setSession(id, { state: "failed", detail: `sbx rm failed: ${rm.stderr.trim()}` });
      return;
    }
    this.onSandboxRemoved(id);
    this.hub.setSession(id, { state: "stopped", detail: null });
    this.hub.activity("session", id, `Recreating ${agent.name}'s sandbox with new resources`);
    await this.startNow(id);
  }

  /** Reads each HQ sandbox's real CPU/memory from `sbx ls --json`. */
  async refreshSandboxSizes() {
    const r = await run("sbx", ["ls", "--json"], { timeoutMs: 10_000 });
    if (!r.ok) return;
    let list: { name: string; cpus?: number; memory_mib?: number }[] = [];
    try {
      list = sandboxList<(typeof list)[number]>(r.stdout) ?? [];
    } catch {
      return;
    }
    for (const agent of this.hub.snap.config.team) {
      const found = list.find((s) => s.name === this.name(agent.id));
      // sbx leaves cpus/memory out for sandboxes created with its defaults:
      // all host CPUs and half the memory (0.5–32 GB).
      const m = this.hub.snap.setup.machine;
      const size = !found
        ? null
        : found.cpus && found.memory_mib
          ? { cpus: found.cpus, memoryGb: Math.round((found.memory_mib / 1024) * 10) / 10 }
          : { cpus: m.cpus, memoryGb: Math.min(32, Math.max(0.5, m.memoryGb / 2)) };
      const cur = this.hub.status(agent.id)?.session.sandbox;
      if (JSON.stringify(cur ?? null) !== JSON.stringify(size)) this.hub.setSession(agent.id, { sandbox: size });
    }
  }

  /**
   * Lets sandboxes reach HQ's port (checked once per run, added only if missing).
   * The sandbox proxy evaluates host.docker.internal as localhost, so both are allowed.
   */
  private async ensurePolicy() {
    if (this.policyOk) return;
    const port = this.hub.snap.config.project.hqPort;
    for (const target of [`localhost:${port}`, `host.docker.internal:${port}`]) {
      if ((await policyVerdict(target)).verdict === "allowed") continue;
      const add = await run("sbx", ["policy", "allow", "network", target], { timeoutMs: 10_000 });
      if (!add.ok && POLICY_NOT_INITIALIZED.test(add.stderr + add.stdout)) {
        void this.recheckSetup();
        throw new Error("Docker Sandboxes needs a base network policy first. Open the setup checklist → “Sandbox network policy”, or run: sbx policy init balanced");
      }
      if (!add.ok) throw new Error(`Could not allow ${target}: ${add.stderr.trim()}`);
      log.info(`added sandbox network rule: allow ${target}`);
    }
    this.policyOk = true;
  }

  // ------------------------------------------------------------ terminals

  /** One terminal view per agent; output goes to every browser. */
  private attach(id: string) {
    if (this.terms.has(id)) return;
    const size = this.sizes.get(id) ?? { cols: 120, rows: 36 };
    const term: TermHandle = this.backend.attach(
      this.name(id),
      size,
      (d) => this.hub.terminal(id, d),
      () => {
        if (this.terms.get(id) === term) this.terms.delete(id);
      },
    );
    this.terms.set(id, term);
  }

  private detach(id: string) {
    this.terms.get(id)?.close();
    this.terms.delete(id);
  }

  /** Types a line into an agent's prompt and submits it. */
  async typeInto(agentId: string, text: string): Promise<boolean> {
    if (!(await this.backend.type(this.name(agentId), text))) return false;
    await new Promise((r) => setTimeout(r, 200));
    return this.backend.enter(this.name(agentId));
  }

  async pressEnter(agentId: string): Promise<boolean> {
    return this.backend.enter(this.name(agentId));
  }

  input(id: string, data: string) {
    if (id.startsWith("setup:")) return this.fixes.get(id)?.write(data);
    if (id.startsWith("shell:")) return this.shells.get(id)?.write(data);
    this.terms.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const c = Math.max(20, Math.min(400, Math.floor(cols)));
    const r = Math.max(5, Math.min(200, Math.floor(rows)));
    const same = this.sizes.get(id)?.cols === c && this.sizes.get(id)?.rows === r;
    this.sizes.set(id, { cols: c, rows: r });
    const current = () => (id.startsWith("setup:") ? this.fixes.get(id) : id.startsWith("shell:") ? this.shells.get(id) : this.terms.get(id));
    const pty = current();
    if (!pty) return;
    // Resizing a terminal that just exited throws on Windows; a throw in a timer would stop HQ.
    const safeResize = (cs: number, rs: number) => {
      if (current() !== pty) return;
      try {
        pty.resize(cs, rs);
      } catch {
        /* it closed in between */
      }
    };
    // A same-size resize doesn't redraw; nudge it so a newly opened terminal gets a full screen.
    if (same) {
      safeResize(c, Math.max(5, r - 1));
      setTimeout(() => safeResize(c, r), 60);
    } else safeResize(c, r);
  }

  async openWorkspace(id: string) {
    const st = this.hub.status(id);
    const agent = this.hub.cfg(id);
    const dir = st?.session.workspace ?? (agent ? workspaceFor(agent, this.hub.slug) : null);
    if (!dir) return;
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    await run(opener, [dir], { timeoutMs: 5000 });
  }

  // ------------------------------------------------------------ health

  /** Keeps session state honest: picks up sessions from before a restart, notices crashes. */
  startPolling() {
    void this.pollOnce().catch((e) => log.warn("poll:", e));
    let n = 0;
    this.polling = setInterval(() => {
      void this.pollOnce().catch((e) => log.warn("poll:", e));
      // Sandbox sizes change rarely; check every ~30s (and right after a start).
      if (n++ % 10 === 0 && this.hub.snap.setup.sandboxReady) void this.refreshSandboxSizes();
    }, 3000);
  }

  /**
   * One pass over the team. A failure for one agent (a refused workspace, a
   * tmux error) marks that agent failed and the pass goes on (SR-B-22).
   */
  async pollOnce() {
    if (this.hub.snap.setup.checks.find((c) => c.id === "tmux")?.status !== "ok") return;
    for (const agent of [...this.hub.snap.config.team]) {
      try {
        await this.pollAgent(agent);
      } catch (err) {
        if (this.hub.status(agent.id)) this.hub.setSession(agent.id, { state: "failed", detail: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async pollAgent(agent: AgentConfig) {
    const st = this.hub.status(agent.id);
    if (!st || st.session.state === "starting") return;
    const name = this.name(agent.id);
    const alive = await this.backend.exists(name);
    if (alive) {
      const pane = await this.backend.exitInfo(name);
      if (pane?.dead) {
        const detail = (await this.backend.screenText(name, 6)) || `Exited with code ${pane.exitStatus}`;
        // HQ ends this session itself, so its secret goes with it. (A session
        // that merely looks gone keeps its secret: an exists() check can
        // fail on a timeout, and revoking would lock out a running agent.)
        await this.backend.kill(name);
        this.revokeSecret(agent.id);
        this.detach(agent.id);
        this.closeShell(agent.id);
        this.onSessionDown(agent.id);
        this.hub.setSession(agent.id, { state: "failed", detail });
        this.hub.setStatus(agent.id, { state: "idle", note: "Session ended" });
        this.hub.activity("session", agent.id, `${agent.name}'s session ended`);
        return;
      }
      // The folder is checked before anything attaches. A refused one is marked failed
      // once, and stays so until the agent's settings change (SR-D-04).
      let workspace: string;
      try {
        workspace = workspaceFor(agent, this.hub.slug);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (st.session.state !== "failed" || st.session.detail !== detail) {
          this.hub.setSession(agent.id, { state: "failed", detail });
          if (err instanceof WorkspaceRefusedError) this.auditRefusal(agent.id, err, HQ_ACTOR);
        }
        return;
      }
      this.attach(agent.id);
      if (st.session.state !== "running") {
        this.hub.setSession(agent.id, { state: "running", detail: null, workspace });
        this.hub.setStatus(agent.id, { note: "Reattached" });
        this.onSessionReattached(agent.id);
        this.noteOldKey(agent.id);
      }
      if (agent.cli === "codex") await this.watchCodexScreen(agent.id, name);
      await this.reconcileFromScreen(agent.id, agent.cli, name);
    } else if (st.session.state === "running") {
      this.detach(agent.id);
      this.closeShell(agent.id);
      this.onSessionDown(agent.id);
      this.hub.setSession(agent.id, { state: "stopped", detail: null });
      this.hub.setStatus(agent.id, { state: "idle", note: "Stopped" });
    }
  }

  /**
   * Codex fires SessionStart only on the first prompt, so HQ reads its screen:
   * the trust prompts mean "needs you"; the empty prompt means HQ can type.
   */
  private async watchCodexScreen(agentId: string, name: string) {
    const st = this.hub.status(agentId);
    if (!st) return;
    const screen = await this.backend.screenText(name, 14);
    const TRUST_NOTE = "Asking: approve Codex's folder and hook prompts in the terminal (choose Yes, then Trust all)";
    if (/Do you trust the contents of this directory|Hooks need review/i.test(screen)) {
      if (st.note !== TRUST_NOTE) {
        this.hub.setStatus(agentId, { state: "needs-input", note: TRUST_NOTE });
        this.hub.activity("agent.needs-input", agentId, `${this.hub.name(agentId)} needs you: approve Codex's trust prompts`);
      }
      return;
    }
    if (/Ask Codex to do anything/i.test(screen)) {
      this.onSessionReattached(agentId); // its prompt is ready for typed messages
      if (st.note === TRUST_NOTE || st.note === "Sandbox running" || st.note === "Running locally" || st.note === "Reattached")
        this.hub.setStatus(agentId, { state: "idle", note: "Ready" });
    }
  }

  /**
   * Hooks are the main signal, but one can be missed or arrive late (a hook
   * that timed out, an answer with no tool call after it). When hooks have been
   * quiet for a while, the screen says what the agent is really doing, and a
   * wrong state would otherwise hold back queued messages.
   */
  private async reconcileFromScreen(agentId: string, cli: AgentCli, name: string) {
    const st = this.hub.status(agentId);
    if (!st || st.session.state !== "running") return;
    const quietMs = Date.now() - this.lastHookAt(agentId);
    if (quietMs < SCREEN_QUIET_MS) return;
    const screen = await this.backend.screenText(name, 10);
    if (!screen) return;
    const busy = BUSY.test(screen);
    const dialog = DIALOG.test(screen);
    const set = (state: "idle" | "working" | "needs-input", note: string) => {
      if (process.env.HQ_DEBUG) log.info(`screen ${agentId}: ${st.state} → ${state} (${note})`);
      this.hub.setStatus(agentId, { state, note });
    };

    if (st.state === "needs-input") {
      if (dialog || st.note?.includes("Codex's folder")) return; // still waiting (Codex trust is watched separately)
      this.idleScreens.delete(agentId);
      if (busy) return set("working", "Continuing after your answer");
      // Idle only on a positive sign: Claude Code's normal input footer is back. An unfamiliar
      // prompt keeps "needs you", so queued messages aren't typed into it. Codex: wait for "busy".
      if (cli === "claude" && PROMPT_READY.test(screen)) set("idle", "Waiting for you");
      return;
    }
    if (dialog) return set("needs-input", "Asking: answer the question in the terminal");
    // A missed UserPromptSubmit: the agent is busy, so don't type into it.
    if (st.state === "idle" && busy) return set("working", "Working");
    if (st.state === "working" && !busy && cli === "claude") {
      // Twice in a row, so a gap between two steps isn't mistaken for the end of the turn.
      const n = (this.idleScreens.get(agentId) ?? 0) + 1;
      this.idleScreens.set(agentId, n);
      if (n >= 2 && quietMs >= STALE_WORKING_MS) {
        this.idleScreens.delete(agentId);
        set("idle", "Finished — ready for the next instruction");
      }
      return;
    }
    this.idleScreens.delete(agentId);
    // An idle agent's prompt is on screen, so typed messages will land (e.g. HQ missed SessionStart).
    if (st.state === "idle" && !busy && PROMPT_READY.test(screen)) this.onSessionReattached(agentId);
  }

  // ------------------------------------------------------------ setup helper

  async recheckSetup() {
    this.hub.setSetup(await runSetupChecks(this.hub.repo, this.hub.snap.config.team));
  }

  /** Runs a program in a terminal the browser can watch and type into (id must start with "setup:"). */
  runTerminal(id: string, file: string, args: string[], onExit: (code: number) => void = () => {}) {
    if (!id.startsWith("setup:") || this.fixes.has(id)) return;
    const size = this.sizes.get(id) ?? { cols: 100, rows: 16 };
    const pty = spawnPty(file, args, { name: "xterm-256color", cols: size.cols, rows: size.rows, cwd: this.hub.repo.root, env: TERM_ENV });
    this.fixes.set(id, pty);
    this.hub.terminal(id, `\x1b[2m$ ${[file, ...args].join(" ")}\x1b[0m\r\n`);
    pty.onData((d) => this.hub.terminal(id, d));
    pty.onExit(({ exitCode }) => {
      this.fixes.delete(id);
      this.hub.terminal(id, `\r\n\x1b[${exitCode === 0 ? "32m✓ Done" : `31m✗ Exited with code ${exitCode}`}\x1b[0m\r\n`);
      onExit(exitCode);
    });
  }

  /** Runs a check's fix command in a visible terminal. Only commands HQ itself suggested. */
  runFix(checkId: SetupCheckId) {
    const check = this.hub.snap.setup.checks.find((c) => c.id === checkId);
    if (!check?.fix?.runnable || !check.fix.command) return;
    const id = `setup:${checkId}`;
    if (this.fixes.has(id)) return;
    const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh";
    const args = process.platform === "win32" ? ["-NoProfile", "-Command", check.fix.command] : ["-lc", check.fix.command];
    const size = this.sizes.get(id) ?? { cols: 100, rows: 16 };
    const pty = spawnPty(shell, args, { name: "xterm-256color", cols: size.cols, rows: size.rows, cwd: this.hub.repo.root, env: TERM_ENV });
    this.fixes.set(id, pty);
    this.hub.terminal(id, `\x1b[2m$ ${check.fix.command}\x1b[0m\r\n`);
    pty.onData((d) => this.hub.terminal(id, d));
    pty.onExit(({ exitCode }) => {
      this.fixes.delete(id);
      this.hub.terminal(id, `\r\n\x1b[${exitCode === 0 ? "32m✓ Done" : `31m✗ Exited with code ${exitCode}`}\x1b[0m\r\n`);
      void this.recheckSetup();
    });
  }

  // ------------------------------------------------------------ shell tab

  /**
   * Opens a shell for the "Shell" tab (terminal id `shell:<agentId>`): `sbx exec -it <sandbox> bash`
   * for a sandboxed agent, your own shell in its folder for Local mode. It runs beside the agent's
   * session, so the agent keeps working; it closes when you close it or HQ stops.
   */
  async openShell(agentId: string) {
    const id = `shell:${agentId}`;
    const agent = this.hub.cfg(agentId);
    const st = this.hub.status(agentId);
    if (!agent || this.shells.has(id)) return;
    if (st?.session.state !== "running") return this.hub.terminal(id, "\x1b[2mStart the agent first; the shell opens inside its sandbox.\x1b[0m\r\n");
    // Bumped by closeShell, so an open still starting when you press "New shell" is dropped.
    const gen = (this.shellGen.get(id) ?? 0) + 1;
    this.shellGen.set(id, gen);
    const dir = st.session.workspace ?? workspaceFor(agent, this.hub.slug);
    const win = process.platform === "win32";
    let pty: IPty;
    let banner: string;
    try {
      let file: string;
      let args: string[];
      if (agent.mode === "sandbox") {
        const name = this.name(agentId);
        // bash when the image has it, else sh; start in the agent's folder (same path inside the sandbox).
        // The agent's app variables too, so what you check here matches what the agent sees.
        const env = this.envFileFor(agentId);
        ({ file, args } = await resolveCommand("sbx", ["exec", "-it", ...(env ? ["--env-file", env] : []), ...(win ? [] : ["-w", dir]), name, "sh", "-c", SANDBOX_SHELL]));
        banner = `sbx exec -it ${name} bash`;
      } else {
        const sh = process.env.SHELL || "/bin/sh";
        const env = win ? null : this.envFileFor(agentId);
        file = win ? "powershell.exe" : env ? "/bin/sh" : sh;
        // Load the env file into the shell (HQ itself never reads it), then hand over to your shell.
        args = win ? ["-NoLogo"] : env ? ["-c", `${loadEnvFile('"$1"')}; exec "$2" -l`, "sh", env, sh] : ["-l"];
        banner = `${sh} in ${dir}`;
      }
      if (this.shellGen.get(id) !== gen || this.shells.has(id) || this.hub.status(agentId)?.session.state !== "running") return;
      const size = this.sizes.get(id) ?? { cols: 100, rows: 30 };
      pty = spawnPty(file, args, { name: "xterm-256color", cols: size.cols, rows: size.rows, cwd: dir, env: SHELL_ENV });
    } catch (err) {
      // e.g. sbx not on PATH: show it in the Shell tab instead of failing silently.
      return this.hub.terminal(id, `\x1b[31mCouldn't open a shell: ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`);
    }
    this.shells.set(id, pty);
    this.hub.terminal(id, `\x1b[2m$ ${banner}\x1b[0m\r\n`);
    const startedAt = Date.now();
    pty.onData((d) => this.hub.terminal(id, d));
    pty.onExit(({ exitCode }) => {
      if (this.shells.get(id) === pty) this.shells.delete(id);
      if (this.closing.has(pty)) return;
      // Failing right away usually means the command itself couldn't run (e.g. sbx not installed or on PATH).
      if (exitCode && Date.now() - startedAt < 2500)
        return this.hub.terminal(id, `\r\n\x1b[31m[couldn't start the shell (exit ${exitCode}). ${agent.mode === "sandbox" ? "Check that sbx is installed and you're signed in (sbx login)." : "Check your shell."}]\x1b[0m\r\n`);
      this.hub.terminal(id, `\r\n\x1b[2m[shell closed${exitCode ? ` (exit ${exitCode})` : ""}. Press "New shell" to open another.]\x1b[0m\r\n`);
    });
  }

  closeShell(agentId: string) {
    const id = `shell:${agentId}`;
    this.shellGen.set(id, (this.shellGen.get(id) ?? 0) + 1);
    const pty = this.shells.get(id);
    if (!pty) return;
    this.closing.add(pty);
    pty.kill();
    this.shells.delete(id);
  }

  /**
   * The Terminal panel: your own shell on this machine (not in a sandbox), in the folder you pick.
   * Reopening with the same folder keeps the running shell; `fresh` or a new folder starts a new one.
   */
  openHostShell(dir: string, fresh: boolean) {
    const id = HOST_TERMINAL;
    const want = this.hostDir(dir);
    if (!want) return this.hub.terminal(id, `\x1b[31mNo such folder: ${dir}\x1b[0m\r\n`);
    if (this.shells.has(id) && !fresh && want === this.hostShellDir) return;
    // A new shell starts on a clean screen.
    if (this.shells.has(id)) this.hub.terminal(id, "\x1bc");
    this.closeHostShell();
    const win = process.platform === "win32";
    const sh = win ? "powershell.exe" : process.env.SHELL || "/bin/sh";
    const size = this.sizes.get(id) ?? { cols: 100, rows: 30 };
    let pty: IPty;
    try {
      pty = spawnPty(sh, win ? ["-NoLogo"] : ["-l"], { name: "xterm-256color", cols: size.cols, rows: size.rows, cwd: want, env: SHELL_ENV });
    } catch (err) {
      return this.hub.terminal(id, `\x1b[31mCouldn't open a shell: ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`);
    }
    this.shells.set(id, pty);
    this.hostShellDir = want;
    this.hub.terminal(id, `\x1b[2m$ ${sh} in ${want}\x1b[0m\r\n`);
    pty.onData((d) => this.hub.terminal(id, d));
    pty.onExit(({ exitCode }) => {
      if (this.shells.get(id) === pty) this.shells.delete(id);
      if (this.closing.has(pty)) return;
      this.hub.terminal(id, `\r\n\x1b[2m[shell closed${exitCode ? ` (exit ${exitCode})` : ""}. Press "New shell" to open another.]\x1b[0m\r\n`);
    });
  }

  closeHostShell() {
    const pty = this.shells.get(HOST_TERMINAL);
    this.hostShellDir = null;
    if (!pty) return;
    this.closing.add(pty);
    pty.kill();
    this.shells.delete(HOST_TERMINAL);
  }

  private hostShellDir: string | null = null;

  /** An existing folder from what you typed ("~" works); the repo when empty. */
  private hostDir(dir: string): string | null {
    const raw = dir.trim();
    if (!raw) return this.hub.repo.root;
    const full = resolve(this.hub.repo.root, raw === "~" || raw.startsWith("~/") ? homedir() + raw.slice(1) : raw);
    try {
      return statSync(full).isDirectory() ? full : null;
    } catch {
      return null;
    }
  }

  shutdown() {
    for (const p of this.shells.values()) p.kill();
    if (this.polling) clearInterval(this.polling);
    // tmux keeps the agents running; the pty backend stops them.
    for (const t of this.terms.values()) t.close();
    this.backend.shutdown();
    for (const p of this.fixes.values()) p.kill();
  }
}

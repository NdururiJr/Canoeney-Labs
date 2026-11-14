// One project's runtime inside one HQ (M0-D2, docs/adr/0009-one-hq-many-projects.md).
// Everything HQ builds per project lives here: its hub, sessions, inbox,
// planner, sandbox and MCP managers, GitHub sync and dashboard commands. Each
// of those keys its state by the project slug, and the store keys every
// project table by project id, so two runtimes share nothing but the store.
import { existsSync, rmSync } from "node:fs";
import { ActionItems } from "./actionItems";
import { makeCommands } from "./commands";
import type { Company } from "./company";
import type { CommandSpec } from "./dashboard";
import { GitHubSync } from "./githubSync";
import { Hub } from "./hub";
import { Inbox } from "./inbox";
import { log } from "./lib/log";
import { legacyAgentTokenFile, legacyDevTokenFile } from "./paths";
import { Planner } from "./planner";
import { refreshProjectNotes } from "./projectNotesSync";
import type { RepoInfo } from "./repo";
import { offerImport } from "./repoConfigImport";
import { Sbx } from "./sbx";
import { SbxMcp } from "./sbxMcp";
import { Sessions } from "./sessions";
import { runSetupChecks } from "./setup";

export interface RuntimeParts {
  slug: string;
  repo: RepoInfo;
  hub: Hub;
  inbox: Inbox;
  planner: Planner;
  sessions: Sessions;
  sbx: Sbx;
  mcp: SbxMcp;
  commands: Record<string, CommandSpec>;
  /** Starts polling and syncing; `stop` undoes it. */
  start?: () => void;
  stop?: () => void;
}

export class ProjectRuntime {
  readonly slug: string;
  readonly repo: RepoInfo;
  readonly hub: Hub;
  readonly inbox: Inbox;
  readonly planner: Planner;
  readonly sessions: Sessions;
  readonly sbx: Sbx;
  readonly mcp: SbxMcp;
  readonly commands: Record<string, CommandSpec>;
  private readonly onStart: () => void;
  private readonly onStop: () => void;
  private started = false;

  constructor(p: RuntimeParts) {
    this.slug = p.slug;
    this.repo = p.repo;
    this.hub = p.hub;
    this.inbox = p.inbox;
    this.planner = p.planner;
    this.sessions = p.sessions;
    this.sbx = p.sbx;
    this.mcp = p.mcp;
    this.commands = p.commands;
    this.onStart = p.start ?? (() => {});
    this.onStop = p.stop ?? (() => {});
  }

  /** Builds the project's runtime, in the order HQ always has: the import offer and the notes before the sessions. */
  static async open(company: Company, repo: RepoInfo, slug: string, o: { port: number }): Promise<ProjectRuntime> {
    // The configuration is a view of the store; the repo's .jsmhq/ files have no effect (SR-D-01).
    const configSource = () => company.settings.view(slug, { path: repo.root, hqPort: o.port });
    // The shared agent token from before M0-B, and the dev token from before M0-C, are not used any more.
    rmSync(legacyAgentTokenFile(slug), { force: true });
    rmSync(legacyDevTokenFile(slug), { force: true });

    log.info(`project ${slug}: ${repo.root}${repo.github ? `  (github.com/${repo.github})` : ""}`);
    const setup = await runSetupChecks(repo, configSource().team);
    for (const c of setup.checks) log.info(`  ${c.status === "ok" ? "✓" : c.status === "warning" ? "!" : "✗"} ${c.label}: ${c.detail}`);

    const hub = new Hub(repo, slug, configSource, company.plans.load(slug), setup);
    // Until the owner completes the welcome or confirms an import, nothing is read from the repo.
    offerImport(hub, company);
    refreshProjectNotes(hub, company);
    const sessions = new Sessions(hub, company);
    const inbox = new Inbox(hub, { type: (id, text) => sessions.typeInto(id, text), enter: (id) => sessions.pressEnter(id) });
    sessions.onSessionDown = (id) => inbox.sessionDown(id);
    sessions.onSessionReattached = (id) => inbox.sessionReattached(id);
    sessions.lastHookAt = (id) => inbox.lastHookAt(id);
    const sbx = new Sbx(hub, company);
    sessions.envFileFor = (id) => (existsSync(sbx.envFile(id)) ? sbx.envFile(id) : null);
    // Read fresh before a company-level agent starts: a key set a moment ago must count (SR-D-06).
    sessions.githubKeyFor = async (id) => {
      await sbx.refresh();
      return sbx.githubKeyFor(id);
    };
    const mcp = new SbxMcp(hub, (id, file, args, onExit) => sessions.runTerminal(id, file, args, onExit), undefined, company);
    sessions.onSandboxReady = (id) => {
      void sbx.syncRules(id);
      void mcp.attachAll(id);
      void sbx.refreshPorts(id);
    };
    sessions.onSessionDown = ((down) => (id: string) => {
      down(id);
      void sbx.refreshPorts(id);
    })(sessions.onSessionDown);
    sessions.onSandboxRemoved = (id) => {
      mcp.forget(id);
      void sbx.refreshPorts(id);
    };
    void sbx.refresh();
    void mcp.refresh();
    const planner = new Planner(hub, inbox, () => company.agents.cto(slug, (id) => !!hub.cfg(id))?.agentId ?? null, {
      plans: company.plans,
      projectId: slug,
      roleOf: (id) => company.agents.get(slug, id)?.role ?? null,
    });
    planner.actions = new ActionItems(hub, planner);
    let github: GitHubSync | null = null;
    return new ProjectRuntime({
      slug,
      repo,
      hub,
      inbox,
      planner,
      sessions,
      sbx,
      mcp,
      commands: makeCommands(hub, sessions, planner, inbox, sbx, mcp, company),
      start: () => {
        sessions.startPolling();
        sbx.startApprovalPolling();
        github = new GitHubSync(hub, planner, repo.github);
        github.start();
      },
      stop: () => {
        sessions.shutdown();
        sbx.stopApprovalPolling();
        github?.stop();
        inbox.stop();
      },
    });
  }

  /** Starts session polling, sbx approval polling and GitHub sync. Once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.onStart();
  }

  /** What stopping HQ does for this project: sessions shut down (tmux ones keep running), polling stops. */
  stop(): void {
    this.onStop();
  }
}

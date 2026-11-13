// jsm-hq — start HQ for the git repo you're in.
//
//   jsm-hq [--repo <path>] [--port 7420] [--dev] [--no-open]
//   jsm-hq reset-owner        on the host: forget the owner's credentials and write a new setup code
//
// --dev: the UI is served by Vite (pnpm dev:hq); HQ prints/opens the Vite URL.

import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCommands } from "./commands";
import { offerImport } from "./repoConfigImport";
import { refreshProjectNotes } from "./projectNotesSync";
import { Dashboard } from "./dashboard";
import { companyHome, openCompany } from "./company";
import { AgentAuth } from "./agentAuth";
import { startHttp } from "./http";
import { Hub } from "./hub";
import { GitHubSync } from "./githubSync";
import { Inbox } from "./inbox";
import { Planner } from "./planner";
import { ActionItems } from "./actionItems";
import { Sbx } from "./sbx";
import { SbxMcp } from "./sbxMcp";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { ensurePtyHelperExecutable } from "./lib/ptyFix";
import { OwnerAuth } from "./ownerAuth";
import { legacyAgentTokenFile, legacyDevTokenFile } from "./paths";
import { detectRepo } from "./repo";
import { Sessions } from "./sessions";
import { runSetupChecks } from "./setup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/** Recovery that needs the host (SR-C-18): the owner enrolls again with a new setup code. Run it with HQ stopped. */
function resetOwner() {
  const home = companyHome();
  const company = openCompany({ home, repoRoot: null });
  try {
    company.humans.reset("owner");
    const auth = new OwnerAuth({ accounts: company.humans, clock: company.clock, audit: company.audit, allowedOrigins: [], setupFile: join(home, "owner-setup.txt") });
    const file = auth.prepareSetup();
    log.info(`The owner's password, PIN and authenticator were forgotten. Start HQ and enroll again with the setup code in ${file}.`);
  } finally {
    company.close();
  }
}

async function main() {
  if (process.argv.includes("reset-owner")) return resetOwner();
  ensurePtyHelperExecutable();
  const dev = flag("dev");
  const port = Number(arg("port") ?? process.env.HQ_PORT ?? 7420);
  const repo = await detectRepo(resolve(arg("repo") ?? process.env.HQ_REPO ?? process.cwd()));
  // A store written by a newer HQ stops startup here, with its own message.
  const company = openCompany({ home: companyHome(), repoRoot: repo.root });
  // The project id comes from the store, never from a file in the repo (M0-D1).
  const slug = company.agents.ensureProject({ name: repo.name, root: repo.root });
  // The configuration is a view of the store; the repo's .jsmhq/ files have no effect (SR-D-01).
  const configSource = () => company.settings.view(slug, { path: repo.root, hqPort: port });
  // The shared agent token from before M0-B is not used any more.
  rmSync(legacyAgentTokenFile(slug), { force: true });
  // The dashboard has owner login now (M0-C): no token in a URL.
  rmSync(legacyDevTokenFile(slug), { force: true });

  log.info(`repo   ${repo.root}${repo.github ? `  (github.com/${repo.github})` : ""}`);
  log.info(`company ${company.db.file}`);
  log.info("checking setup…");
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

  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const distDir = join(root, "dist");
  const uiPort = Number(process.env.HQ_UI_PORT ?? 5173);
  const uiOrigin = dev ? `http://localhost:${uiPort}` : `http://127.0.0.1:${port}`;
  if (!dev && !existsSync(join(distDir, "index.html"))) log.warn("No built UI found. Run `pnpm build` first, or use `pnpm dev:hq`.");

  // Extra dashboard origins, such as the Tailscale name the phone uses (M0-G sets it).
  const extraOrigins = (process.env.HQ_DASHBOARD_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowedOrigins = [uiOrigin, `http://127.0.0.1:${uiPort}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`, ...extraOrigins];
  const ownerAuth = new OwnerAuth({ accounts: company.humans, clock: company.clock, audit: company.audit, allowedOrigins, setupFile: join(company.home, "owner-setup.txt") });
  const setupFile = ownerAuth.prepareSetup();

  const dashboard = new Dashboard(makeCommands(hub, sessions, planner, inbox, sbx, mcp, company), { ownerAuth, audit: company.audit, clock: company.clock });
  await startHttp({
    hub,
    inbox,
    planner,
    port,
    ownerAuth,
    agentAuth: new AgentAuth({ projectSlug: slug, company, hub }),
    company,
    distDir: dev ? null : distDir,
    allowedOrigins,
    dashboard,
  });
  // Only once HQ is serving: a port already in use must not record a start.
  company.audit.append({ actorKind: "hq", actorId: "hq", action: "hq.started", data: { project: slug } });
  sessions.startPolling();
  sbx.startApprovalPolling();
  const github = new GitHubSync(hub, planner, repo.github);
  github.start();

  const url = `${uiOrigin}/`;
  log.info(`\n\n  JSM HQ is running → ${url}\n`);
  // The setup code itself is never printed: whoever enrolls must be able to read the file on this machine.
  if (setupFile) log.info(`  No owner yet. Open ${url} and enter the setup code from ${setupFile}\n`);
  if (!flag("no-open")) {
    // Windows: rundll32 hands the URL to the default browser without a shell.
    const [opener, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
    // Give Vite a moment in dev.
    setTimeout(() => void run(opener, args), dev ? 1500 : 0);
  }

  const quit = () => {
    log.info(sessions.backend.persistent ? "stopping HQ — agent sessions keep running in tmux" : "stopping HQ and its agents — sandboxes and folders are kept");
    sessions.shutdown();
    sbx.stopApprovalPolling();
    github.stop();
    try {
      // The collapsed terminal rows still counting go in before HQ stops (M0-C final review).
      dashboard.flush(true);
      company.audit.append({ actorKind: "hq", actorId: "hq", action: "hq.stopped", data: { project: slug } });
      company.close();
    } catch (err) {
      log.warn(`company store did not close cleanly: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

main().catch((err) => {
  if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    log.error(`Port ${arg("port") ?? 7420} is in use — another HQ may be running. Stop it, or pick another port: npx @therealjsmastery/jsm-hq --port 7421`);
    process.exit(1);
  }
  if ((err as NodeJS.ErrnoException)?.code === "EACCES") {
    const port = arg("port") ?? 7420;
    log.error(
      process.platform === "win32"
        ? `Windows reserved port ${port} (Hyper-V, WSL and Docker reserve port ranges). Pick another: npx @therealjsmastery/jsm-hq --port 8420\n  See the reserved ranges with: netsh interface ipv4 show excludedportrange protocol=tcp`
        : `Not allowed to use port ${port}. Pick another: npx @therealjsmastery/jsm-hq --port 8420`,
    );
    process.exit(1);
  }
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

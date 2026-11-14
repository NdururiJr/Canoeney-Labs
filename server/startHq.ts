// Starts one HQ for every project it manages (M0-D2): the company store, the
// projects (the repo HQ was started in, plus every stored one), the dashboard
// and the HTTP server. main.ts parses the command line and calls this.
import type { Server } from "node:http";
import { join } from "node:path";
import { AgentAuth } from "./agentAuth";
import { makeCompanyCommands } from "./commands";
import { companyHome, openCompany, type Company } from "./company";
import { Dashboard } from "./dashboard";
import { startHttp } from "./http";
import { log } from "./lib/log";
import { OwnerAuth } from "./ownerAuth";
import { ProjectRuntime } from "./projectRuntime";
import { Projects } from "./projects";
import type { RepoInfo } from "./repo";

export const NO_PROJECT = "No project to open. Run HQ in your project's repo, or pass --repo <path>.";

export interface StartOptions {
  /** The folder HQ was started in (or --repo). */
  start: string;
  port: number;
  dev: boolean;
  /** The built UI to serve, or null (dev: Vite serves it). */
  distDir: string | null;
  /** Where the dashboard is opened. */
  uiOrigin: string;
  /** More dashboard origins, such as the Vite or Tailscale ones. */
  extraOrigins: string[];
  /** Builds a project's runtime. Tests pass a light one; HQ uses ProjectRuntime.open. */
  openRuntime?: (company: Company, repo: RepoInfo, slug: string) => Promise<ProjectRuntime>;
}

export interface RunningHq {
  projects: Projects;
  /** The dashboard URL. */
  url: string;
  /** Where the owner's setup code is, while no owner is enrolled. */
  setupFile: string | null;
  server: Server;
  close(): void;
}

export async function startHq(o: StartOptions): Promise<RunningHq> {
  // A store written by a newer HQ stops startup here, with its own message.
  const company = openCompany({ home: companyHome(), repoRoot: null });
  try {
    log.info(`company ${company.db.file}`);
    const open = o.openRuntime ?? ((c, repo, slug) => ProjectRuntime.open(c, repo, slug, { port: o.port }));
    const projects = new Projects(company, (repo, slug) => open(company, repo, slug));
    await projects.registerStart(o.start);
    if (projects.list().length === 0) throw new Error(NO_PROJECT);
    log.info("opening projects…");
    await projects.openAll();

    const allowedOrigins = [...new Set([o.uiOrigin, `http://localhost:${o.port}`, `http://127.0.0.1:${o.port}`, ...o.extraOrigins])];
    const ownerAuth = new OwnerAuth({ accounts: company.humans, clock: company.clock, audit: company.audit, allowedOrigins, setupFile: join(company.home, "owner-setup.txt") });
    const setupFile = ownerAuth.prepareSetup();
    const dashboard = new Dashboard(makeCompanyCommands(projects), {
      ownerAuth,
      audit: company.audit,
      clock: company.clock,
      projectCommands: (id) => projects.get(id)?.commands ?? null,
    });
    const server = await startHttp({
      projects,
      port: o.port,
      ownerAuth,
      agentAuth: new AgentAuth({ company, projects }),
      company,
      distDir: o.distDir,
      allowedOrigins,
      dashboard,
    });
    // Only once HQ is serving: a port already in use must not record a start.
    company.audit.append({ actorKind: "hq", actorId: "hq", action: "hq.started", data: { projects: projects.openIds() } });

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      projects.stopAll();
      try {
        // The collapsed terminal rows still counting go in before HQ stops (M0-C final review).
        dashboard.flush(true);
        company.audit.append({ actorKind: "hq", actorId: "hq", action: "hq.stopped", data: { projects: projects.openIds() } });
      } catch (err) {
        log.warn(`the audit trail did not record the stop: ${err instanceof Error ? err.message : err}`);
      }
      server.closeAllConnections();
      server.close();
      try {
        company.close();
      } catch (err) {
        log.warn(`company store did not close cleanly: ${err instanceof Error ? err.message : err}`);
      }
    };
    return { projects, url: `${o.uiOrigin}/`, setupFile, server, close };
  } catch (err) {
    company.close();
    throw err;
  }
}

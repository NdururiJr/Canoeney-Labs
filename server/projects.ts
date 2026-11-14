// The projects one HQ runs (spec M0.12, M0-D2). Each registered project whose
// folder is a git repo, and is not HQ's own source, gets its own runtime.
// Projects come in two ways: the repo HQ is started in, and the owner adding
// one from the dashboard with the PIN (SR-D-03). Both refuse HQ's own source
// (SR-D-05) and a folder inside HQ's home, where agents' clones live.
import type { ProjectSummary } from "../src/data/types";
import type { Company } from "./company";
import type { Actor } from "./company/agents";
import type { Authority } from "./company/authority";
import { companyHome, hqHome, isInside } from "./company/home";
import { hqSourceReason, ProjectRefusedError, refuseHqSource } from "./hqSource";
import { log } from "./lib/log";
import type { ProjectRuntime } from "./projectRuntime";
import { detectRepo, type RepoInfo } from "./repo";

export type OpenRuntime = (repo: RepoInfo, slug: string) => Promise<ProjectRuntime>;

const actorOf = (by: Authority): Actor => (by.via === "pin" || by.via === "session" ? { kind: "human", id: by.humanId } : { kind: "hq", id: "hq" });

/** True when `root` is, holds or sits inside HQ's home or the company store. */
function inHqHome(root: string): boolean {
  return [hqHome(), companyHome()].some((home) => isInside(root, home) || isInside(home, root));
}

export class Projects {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  /** Registered projects found to be HQ's own source: never opened. */
  private readonly hqSource = new Set<string>();
  private readonly listeners = new Set<(list: ProjectSummary[]) => void>();
  /** The project HQ was started in, if any: dashboards start on it. */
  private startId: string | null = null;

  private readonly detect: (root: string) => Promise<RepoInfo>;

  constructor(
    readonly company: Company,
    private readonly open: OpenRuntime,
    /** `detect` finds the repo at a folder (default: git). The test fixture's repo folders are plain folders. */
    o: { detect?: (root: string) => Promise<RepoInfo> } = {},
  ) {
    this.detect = o.detect ?? detectRepo;
  }

  get(slug: string): ProjectRuntime | null {
    return this.runtimes.get(slug) ?? null;
  }

  /** Every registered project, in registration order. */
  list(): ProjectSummary[] {
    return this.company.db
      .prepare("SELECT id, name FROM projects ORDER BY created_at, rowid")
      .all<{ id: string; name: string }>()
      .map((p) => ({ id: p.id, name: p.name, state: this.runtimes.has(p.id) ? "open" : this.hqSource.has(p.id) ? "hq-source" : "missing" }));
  }

  /** The project a new dashboard connection views: the one HQ was started in, or else the first open one. */
  defaultId(): string | null {
    if (this.startId && this.runtimes.has(this.startId)) return this.startId;
    return this.list().find((p) => p.state === "open")?.id ?? null;
  }

  /** Opens every registered project whose folder is a git repo and is not HQ's source; the others are listed as missing. */
  async openAll(): Promise<void> {
    const rows = this.company.db.prepare("SELECT id, repo FROM projects ORDER BY created_at, rowid").all<{ id: string; repo: string }>();
    for (const row of rows) {
      if (this.runtimes.has(row.id)) continue;
      try {
        if (await hqSourceReason(row.repo)) {
          // Registered by an older HQ started in its own source. Its agents' clones stay on disk, untouched.
          this.hqSource.add(row.id);
          log.warn(`project ${row.id} is HQ's own source (${row.repo}); it is not opened.`);
          continue;
        }
        if (inHqHome(row.repo)) {
          log.warn(`project ${row.id} is inside HQ's home (${row.repo}); it is not opened.`);
          continue;
        }
        const repo = await this.detect(row.repo);
        await this.openRuntime(repo, row.id);
      } catch (err) {
        log.warn(`project ${row.id} is missing: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.changed();
  }

  /**
   * Registers the repo HQ was started in and returns its id; null when `start`
   * is not in a repo, or is HQ's own source or inside HQ's home (HQ says why).
   * Starting HQ on the host is the owner's act, so no PIN (as before M0-D2).
   */
  async registerStart(start: string): Promise<string | null> {
    let repo: RepoInfo;
    try {
      repo = await detectRepo(start);
    } catch {
      log.info(`${start} is not a git repository; opening the projects HQ already knows.`);
      return null;
    }
    const why = await hqSourceReason(repo.root);
    if (why) {
      log.warn(`${repo.root} is HQ's own source; HQ never manages it as a project. Pass --repo <your project folder>.`);
      return null;
    }
    if (inHqHome(repo.root)) {
      log.warn(`${repo.root} is inside HQ's home; HQ never manages it as a project.`);
      return null;
    }
    this.startId = this.company.agents.ensureProject({ name: repo.name, root: repo.root, github: repo.github });
    return this.startId;
  }

  /** The owner adds a project from the dashboard (PIN checked by ProjectSettings). Opens and starts it. */
  async add(path: string, by: Authority): Promise<string> {
    const actor = actorOf(by);
    const refuse = (reason: "not-a-repo" | "hq-home", target: string): never => {
      this.company.audit.append({ actorKind: actor.kind, actorId: actor.id, action: "project.refused", target, data: { reason } });
      throw new ProjectRefusedError(reason);
    };
    let repo: RepoInfo;
    try {
      repo = await detectRepo(path);
    } catch {
      return refuse("not-a-repo", path);
    }
    await refuseHqSource(this.company, repo.root, actor);
    if (inHqHome(repo.root)) refuse("hq-home", repo.root);
    const id = this.company.settings.addProject(repo, by);
    if (!this.runtimes.has(id)) await this.openRuntime(repo, id);
    this.changed();
    return id;
  }

  subscribe(fn: (list: ProjectSummary[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The ids of the open projects. */
  openIds(): string[] {
    return [...this.runtimes.keys()];
  }

  stopAll(): void {
    for (const rt of this.runtimes.values()) {
      try {
        rt.stop();
      } catch (err) {
        log.warn(`project ${rt.slug} did not stop cleanly: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private async openRuntime(repo: RepoInfo, id: string): Promise<void> {
    const rt = await this.open(repo, id);
    this.runtimes.set(id, rt);
    rt.start();
  }

  private changed(): void {
    const list = this.list();
    for (const fn of this.listeners) {
      try {
        fn(list);
      } catch {
        /* one listener's failure does not stop the others */
      }
    }
  }
}

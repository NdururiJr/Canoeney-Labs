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
  /** Why each registered project that is not open was not opened. */
  private readonly notOpened = new Map<string, string>();
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

  /**
   * Opens every registered project whose folder is a git repo, is not HQ's
   * source, and still holds the project's GitHub repo; the others are listed as
   * missing. Nothing starts here: startAll() does, once HQ is serving (a second
   * HQ that cannot get the port must not reattach to or stop anything).
   */
  async openAll(): Promise<void> {
    const rows = this.company.db.prepare("SELECT id, repo FROM projects ORDER BY created_at, rowid").all<{ id: string; repo: string }>();
    for (const row of rows) {
      if (this.runtimes.has(row.id)) continue;
      const skip = (why: string) => {
        this.notOpened.set(row.id, why);
        log.warn(`project ${row.id} (${row.repo}) is not opened: ${why}.`);
      };
      try {
        if (await hqSourceReason(row.repo)) {
          // Registered by an older HQ started in its own source. Its agents' clones stay on disk, untouched.
          this.hqSource.add(row.id);
          skip("HQ's own source");
          continue;
        }
        if (inHqHome(row.repo)) {
          skip("inside HQ's home");
          continue;
        }
        const repo = await this.detect(row.repo);
        await this.openRuntime(repo, row.id);
        this.notOpened.delete(row.id);
      } catch (err) {
        skip(err instanceof ProjectRefusedError && err.reason === "other-repo" ? "the folder holds a different GitHub repo" : "folder missing");
      }
    }
    this.changed();
  }

  /** Starts every open project's polling and syncing. Called once HQ serves. */
  startAll(): void {
    for (const rt of this.runtimes.values()) rt.start();
  }

  /** "<id>: <why>" for each registered project that is not open. */
  notOpenedList(): string[] {
    return this.list()
      .filter((p) => p.state !== "open")
      .map((p) => `${p.id}: ${this.notOpened.get(p.id) ?? (p.state === "hq-source" ? "HQ's own source" : "folder missing")}`);
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
    const refuse = (reason: "not-a-repo" | "hq-home" | "other-repo", target: string): never => {
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
    const known = this.company.agents.projectForRoot(repo.root);
    if (known && !this.sameRepo(known, repo)) refuse("other-repo", repo.root);
    const id = this.company.settings.addProject(repo, by);
    if (!this.runtimes.has(id)) {
      await this.openRuntime(repo, id);
      // HQ is already serving: the new project starts right away.
      this.runtimes.get(id)?.start();
    }
    this.notOpened.delete(id);
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

  /**
   * True unless the project has a stored GitHub repo and the folder now holds
   * another one (or none): a re-cloned folder must not inherit the old
   * project's grants and notes (owner decision 2026-11-14).
   */
  private sameRepo(id: string, repo: RepoInfo): boolean {
    const stored = this.company.db.prepare("SELECT github FROM project_settings WHERE project_id = ?").get<{ github: string | null }>(id)?.github;
    return !stored || (repo.github ?? "").toLowerCase() === stored.toLowerCase();
  }

  private async openRuntime(repo: RepoInfo, id: string): Promise<void> {
    if (!this.sameRepo(id, repo)) throw new ProjectRefusedError("other-repo");
    const rt = await this.open(repo, id);
    this.runtimes.set(id, rt);
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

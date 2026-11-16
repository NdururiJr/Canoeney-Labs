// The skill lock and each role's skill set (M0-F; threat model SR-F-03,
// docs/adr/0011). Both live in the company store only. A role's set changes
// through ProjectSettings.authorized(): the owner's PIN or an approved decision,
// and the audit row is written in the same transaction as the change.
import { join } from "node:path";
import type { Finding } from "../github/repoGuard";
import { log } from "../lib/log";
import { fetchCommit, lockHash as computeLockHash, readCommit, writeStore, type SkillRefusal } from "../skillVendor";
import type { Authority } from "./authority";
import type { Clock } from "./clock";
import type { CompanyDb } from "./db";
import type { ProjectSettings } from "./projectSettings";
import { ROLE_IDS, type RoleId } from "./types";

export interface LockedSkill {
  name: string;
  /** sha256 over the skill's files (the plan's "Skill hash" rule). */
  hash: string;
  files: { path: string; mode: string; sha256: string }[];
  /** Paths of bundled scripts, so a review sees them. */
  scripts: string[];
}

/** The plan's skill folder name rule. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The skills repo's name as GitHub spells it: `owner/name`. Checked before any git call. */
export const SKILLS_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export type PinRefusal = "bad-sha" | "fetch-failed" | "not-on-default-branch" | "lock-changed" | "repo-check" | "refused-skill";

/** A pin or preview HQ refused. The text is safe to show the owner; the audit row `skills.pin-refused` is already written. */
export class SkillPinRefused extends Error {
  constructor(
    readonly reason: PinRefusal,
    message: string,
  ) {
    super(message);
    this.name = "SkillPinRefused";
  }
}

/** What the owner reads before confirming a pin. The confirm sends `lockHash` back. */
export interface PinPreview {
  repo: string;
  commit: string;
  lockHash: string;
  skills: { name: string; hash: string; files: number; scripts: string[] }[];
  /** Skills in the commit that HQ would refuse; a pin with any of them is refused. */
  refused: { skill: string; reason: SkillRefusal }[];
  added: string[];
  changed: string[];
  removed: string[];
  /** Roles whose set names a skill the current lock holds and this commit lacks. */
  rolesLosing: { role: RoleId; skills: string[] }[];
  findings: Finding[];
  links: { commit: string; compare: string | null };
}

export interface CompanySkillsOptions {
  /** The company home: the bare repo is `<home>/skills/repo.git`, the store `<home>/skills/store`. */
  home?: string;
  /** The SR-F-08 check of the skills repo's own settings (`openCompany` wires `checkSkillsRepo`). */
  check?: (repo: string) => Promise<Finding[]>;
  /** Where `owner/name` is fetched from. */
  urlFor?: (repo: string) => string;
  /** Tests only: allow a local file path as the skills repo's URL. */
  allowFile?: boolean;
}

interface SourceRow {
  repo: string;
  commit_sha: string;
  lock_hash: string;
}

interface LockRow {
  name: string;
  hash: string;
  files_json: string;
  scripts_json: string;
}

export class CompanySkills {
  private readonly check: (repo: string) => Promise<Finding[]>;
  private readonly urlFor: (repo: string) => string;
  private readonly allowFile: boolean;
  /** One preview or pin at a time: they share one bare repo and one default-branch ref. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: CompanyDb,
    private readonly clock: Clock,
    private readonly settings: ProjectSettings,
    private readonly opts: CompanySkillsOptions = {},
  ) {
    this.check = opts.check ?? (async () => []);
    this.urlFor = opts.urlFor ?? ((repo) => `https://github.com/${repo}.git`);
    this.allowFile = opts.allowFile ?? false;
  }

  /** The pinned skills repo, or null before the first pin. */
  source(): { repo: string; commit: string; lockHash: string } | null {
    const r = this.db.prepare("SELECT repo, commit_sha, lock_hash FROM skill_source WHERE id = 1").get<SourceRow>();
    return r ? { repo: r.repo, commit: r.commit_sha, lockHash: r.lock_hash } : null;
  }

  /** Every pinned skill, by name. */
  lock(): LockedSkill[] {
    return this.db
      .prepare("SELECT name, hash, files_json, scripts_json FROM skill_lock ORDER BY name")
      .all<LockRow>()
      .map((r) => ({ name: r.name, hash: r.hash, files: JSON.parse(r.files_json), scripts: JSON.parse(r.scripts_json) }));
  }

  /** The skills a role's agents get, by name. */
  roleSet(role: RoleId): string[] {
    return this.db
      .prepare("SELECT skill FROM role_skills WHERE role = ? ORDER BY skill")
      .all<{ skill: string }>(role)
      .map((r) => r.skill);
  }

  /**
   * Makes the role's set equal `names`. Any change needs the owner's PIN or an
   * approved decision; HQ and a bare session are refused (SR-F-03). The set and
   * its `skills.role-set` row are written together: if the row cannot be
   * written the set is not changed.
   */
  setRoleSkills(role: RoleId, names: string[], by: Authority): { added: string[]; removed: string[] } {
    for (const n of names) {
      if (!SKILL_NAME.test(n)) throw new Error(`"${n}" is not a skill name (lower-case letters, digits and -, up to 63 characters).`);
    }
    const before = this.roleSet(role);
    const want = [...new Set(names)].sort();
    const added = want.filter((n) => !before.includes(n));
    const removed = before.filter((n) => !want.includes(n));
    if (added.length === 0 && removed.length === 0) return { added, removed };
    this.settings.authorized([{ kind: "role-skills", role, before, after: want }], by, "company", () => {
      for (const n of removed) this.db.prepare("DELETE FROM role_skills WHERE role = ? AND skill = ?").run(role, n);
      for (const n of added) this.db.prepare("INSERT INTO role_skills(role, skill) VALUES (?, ?)").run(role, n);
      this.settings.record(by, "skills.role-set", "company", { role, added, removed });
    });
    return { added, removed };
  }

  /**
   * Fetches `commit` of `repo` (its default branch only) and reads it, so the
   * owner can see what a pin would install. Changes nothing. A refusal is
   * audited with `by` as the actor and thrown as SkillPinRefused.
   */
  async preview(repo: string, commit: string, by: Authority): Promise<PinPreview> {
    this.assertRepo(repo);
    return this.serial(async () => {
      const read = await this.read(repo, commit, by);
      return { ...read.preview, findings: await this.runCheck(repo, by) };
    });
  }

  /**
   * Pins `commit` of `repo`: the owner's confirm of a preview. It fetches and
   * reads again and refuses unless the commit is on the default branch, reads to
   * the `lockHash` the owner saw, the skills repo check is clean and no skill is
   * refused. The content store is written first (content-addressed, so a folder
   * a failed pin leaves is unused). Then the pin and its `skills.pinned` row go
   * in one transaction: if the row cannot be written the old pin stays.
   */
  async pin(repo: string, commit: string, lockHash: string, by: Authority): Promise<void> {
    this.assertRepo(repo);
    // Authority first, so a refused caller makes HQ fetch nothing. The write below checks again.
    this.settings.authorized([this.pinChange(commit, lockHash)], by, "company", () => undefined);
    return this.serial(async () => {
      const read = await this.read(repo, commit, by);
      if (read.preview.lockHash !== lockHash) {
        this.refuse(by, "lock-changed", "This commit no longer reads the way it did when you previewed it. Preview it again before pinning.");
      }
      const findings = await this.runCheck(repo, by);
      if (findings.length > 0) {
        this.refuse(by, "repo-check", `The skills repo's own settings are not safe yet: ${findings.map((f) => f.name).join(", ")}. Fix them on GitHub, then pin again.`);
      }
      if (read.preview.refused.length > 0) {
        this.refuse(by, "refused-skill", `HQ will not pin this commit because it refuses: ${read.preview.refused.map((r) => `${r.skill} (${r.reason})`).join(", ")}.`);
      }

      for (const skill of read.skills) writeStore(this.bare(), commit, skill, this.storeDir());

      // The diff is read where it is written, against the lock that is really there.
      this.settings.authorized([this.pinChange(commit, lockHash)], by, "company", () => {
        const { added, changed, removed } = this.diff(read.skills);
        this.writePin({ repo, commit, lockHash, skills: read.skills }, by);
        this.settings.record(by, "skills.pinned", "company", { repo, commit, lockHash, added, changed, removed });
      });
    });
  }

  /**
   * The skills repo check. A check that throws is a refusal, audited with the
   * caller as the actor, never an error that escapes unaudited (SR-F-08).
   */
  private async runCheck(repo: string, by: Authority): Promise<Finding[]> {
    try {
      return await this.check(repo);
    } catch (err) {
      log.warn(`The skills repo check for ${repo} failed: ${err instanceof Error ? err.message : err}`);
      return this.refuse(by, "repo-check", "HQ could not check the skills repo's own settings, so it will not pin. Check that gh is signed in, then try again.");
    }
  }

  private pinChange(commit: string, lockHash: string) {
    return { kind: "skills-pin" as const, before: this.source()?.commit ?? null, after: commit, lockHash };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private assertRepo(repo: string): void {
    if (!SKILLS_REPO.test(repo)) throw new Error(`"${repo}" is not a GitHub repo name. Write it as owner/name.`);
  }

  private home(): string {
    if (!this.opts.home) throw new Error("The skills store has no company home to work in.");
    return this.opts.home;
  }

  private bare(): string {
    return join(this.home(), "skills", "repo.git");
  }

  /** The content store: `<home>/skills/store/<skill hash>/`, written at pin, read at every agent start. */
  storeDir(): string {
    return join(this.home(), "skills", "store");
  }

  /** Audits a refusal with the caller as the actor, then throws it. */
  private refuse(by: Authority, reason: PinRefusal, text: string): never {
    this.settings.record(by, "skills.pin-refused", "company", { reason });
    throw new SkillPinRefused(reason, text);
  }

  /** What `skills` would add, change and remove against the lock now. */
  private diff(skills: { name: string; hash: string }[]): { added: string[]; changed: string[]; removed: string[] } {
    const now = new Map(this.lock().map((s) => [s.name, s.hash]));
    const next = new Map(skills.map((s) => [s.name, s.hash]));
    return {
      added: [...next.keys()].filter((n) => !now.has(n)).sort(),
      changed: [...next.keys()].filter((n) => now.has(n) && now.get(n) !== next.get(n)).sort(),
      removed: [...now.keys()].filter((n) => !next.has(n)).sort(),
    };
  }

  /** Fetches the repo's default branch, accepts `commit` only if it is on it, reads it, and builds the preview (without the repo check). */
  private async read(repo: string, commit: string, by: Authority) {
    const got = await fetchCommit({ url: this.urlFor(repo), sha: commit, bare: this.bare(), allowFile: this.allowFile });
    if (!got.ok) {
      const text: Record<typeof got.reason, string> = {
        "bad-sha": "A commit is 40 hexadecimal characters, in lower case.",
        "fetch-failed": "HQ could not fetch the skills repo. Check the repo name and that it is reachable, then try again.",
        "not-on-default-branch": "That commit is not on the skills repo's default branch, so HQ will not pin it. Pick a commit that has been merged.",
      };
      this.refuse(by, got.reason, text[got.reason]);
    }
    const { skills, refused } = await readCommit(this.bare(), commit);
    const hash = computeLockHash(repo, commit, skills);
    const { added, changed, removed } = this.diff(skills);
    const gone = new Set(removed);
    const rolesLosing = ROLE_IDS.map((role) => ({ role, skills: this.roleSet(role).filter((n) => gone.has(n)) })).filter((r) => r.skills.length > 0);
    const old = this.source();
    const preview: PinPreview = {
      repo,
      commit,
      lockHash: hash,
      skills: skills.map((s) => ({ name: s.name, hash: s.hash, files: s.files.length, scripts: s.scripts })),
      refused,
      added,
      changed,
      removed,
      rolesLosing,
      findings: [],
      links: {
        commit: `https://github.com/${repo}/commit/${commit}`,
        compare: old && old.repo === repo ? `https://github.com/${repo}/compare/${old.commit}...${commit}` : null,
      },
    };
    return { skills, preview };
  }

  /**
   * Replaces the pinned source and lock in one transaction, joining the caller's
   * when one is open. For the pin path (M0-F Task 3), which has already passed
   * ProjectSettings.authorized() and writes the `skills.pinned` row in the same
   * transaction. It refuses a session or HQ as a second check.
   */
  writePin(p: { repo: string; commit: string; lockHash: string; skills: LockedSkill[] }, by: Authority): void {
    if (by.via !== "pin" && by.via !== "decision") throw new Error("Pinning skills needs the owner's PIN or an approved decision.");
    const write = () => {
      this.db.prepare("DELETE FROM skill_lock").run();
      this.db.prepare("DELETE FROM skill_source").run();
      this.db
        .prepare("INSERT INTO skill_source(id, repo, commit_sha, lock_hash, pinned_at) VALUES (1, ?, ?, ?, ?)")
        .run(p.repo, p.commit, p.lockHash, this.clock.now().toISOString());
      const ins = this.db.prepare("INSERT INTO skill_lock(name, hash, files_json, scripts_json) VALUES (?, ?, ?, ?)");
      for (const s of p.skills) ins.run(s.name, s.hash, JSON.stringify(s.files), JSON.stringify(s.scripts));
    };
    if (this.db.inTransaction) write();
    else this.db.transaction(write, "immediate");
  }
}

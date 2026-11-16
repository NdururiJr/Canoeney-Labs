// The skill lock and each role's skill set (M0-F; threat model SR-F-03,
// docs/adr/0011). Both live in the company store only. A role's set changes
// through ProjectSettings.authorized(): the owner's PIN or an approved decision,
// and the audit row is written in the same transaction as the change.
import type { Authority } from "./authority";
import type { Clock } from "./clock";
import type { CompanyDb } from "./db";
import type { ProjectSettings } from "./projectSettings";
import type { RoleId } from "./types";

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
  constructor(
    private readonly db: CompanyDb,
    private readonly clock: Clock,
    private readonly settings: ProjectSettings,
  ) {}

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

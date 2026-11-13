// The project notes agents read: the project's CLAUDE.md, as the copy the owner
// last approved (owner decision D1, threat model SR-D-07). Agents never load the
// repo's file itself (sparse checkout keeps it out of their folders); HQ puts the
// approved copy into the role it generates. Approved copies are append-only.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Authority } from "./authority";
import type { Clock } from "./clock";
import type { CompanyDb } from "./db";
import type { ProjectSettings } from "./projectSettings";

export const NOTES_FILE = "CLAUDE.md";
export const NOTES_MAX_CHARS = 20_000;

export interface ApprovedNotes {
  version: number;
  sha256: string;
  content: string;
  approvedAt: string;
}

export type NotesRead = { sha256: string; content: string } | { error: "missing" | "link" | "too-long" };

interface Row {
  version: number;
  sha256: string;
  content: string;
  approved_at: string;
}

export class ProjectNotes {
  constructor(
    private readonly db: CompanyDb,
    private readonly clock: Clock,
    private readonly settings: ProjectSettings,
  ) {}

  current(projectId: string): ApprovedNotes | null {
    const r = this.db
      .prepare("SELECT version, sha256, content, approved_at FROM project_notes WHERE project_id = ? ORDER BY version DESC LIMIT 1")
      .get<Row>(projectId);
    return r ? { version: r.version, sha256: r.sha256, content: r.content, approvedAt: r.approved_at } : null;
  }

  /** The repo's CLAUDE.md at `root`: only a regular file (a link is not offered), at most NOTES_MAX_CHARS characters. */
  readFrom(root: string): NotesRead {
    const file = join(root, NOTES_FILE);
    let st;
    try {
      st = lstatSync(file);
    } catch {
      return { error: "missing" };
    }
    if (st.isSymbolicLink() || !st.isFile()) return { error: "link" };
    const bytes = readFileSync(file);
    const content = bytes.toString("utf8");
    if (content.length > NOTES_MAX_CHARS) return { error: "too-long" };
    return { sha256: createHash("sha256").update(bytes).digest("hex"), content };
  }

  /**
   * Stores a new approved version. Approving relaxes a control (`notes-approved`),
   * so it needs the PIN or an approved decision. The audit row carries the
   * version and hash, never the content.
   */
  approve(projectId: string, sha256: string, content: string, by: Authority): number {
    return this.settings.authorized([{ kind: "notes-approved" }], by, projectId, () => {
      const version = (this.current(projectId)?.version ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO project_notes(project_id, version, sha256, content, approved_by_human_id, approved_by_decision_id, approved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          version,
          sha256,
          content,
          by.via === "pin" || by.via === "session" ? by.humanId : null,
          by.via === "decision" ? by.decisionId : null,
          this.clock.now().toISOString(),
        );
      this.settings.record(by, "project-notes.approved", projectId, { version, sha256 });
      return version;
    });
  }
}

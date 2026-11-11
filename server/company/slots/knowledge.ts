import type { Clock } from "../clock";
import type { CompanyDb } from "../db";
import type { AuditSink, Knowledge, KnowledgeDoc } from "./types";

type DocRow = { id: string; title: string; body: string; version: number; updatedAt: string };

const DOC_COLUMNS = "id, title, body, version, updated_at AS updatedAt";

// Owner-side store for company knowledge. Agents only ever receive reader(),
// which has no write method.
export class SqliteKnowledgeStore {
  constructor(
    private readonly db: CompanyDb,
    private readonly clock: Clock,
    private readonly audit: AuditSink,
  ) {}

  /** Owner path: create the document at version 1 or bump its version. */
  put(doc: { id: string; title: string; body: string }, byHumanId: string): KnowledgeDoc {
    // The upsert and its audit event commit together; append joins this transaction.
    return this.db.transaction(() => {
      const at = this.clock.now().toISOString();
      const row = this.db
        .prepare(
          `INSERT INTO knowledge_docs(id, title, body, version, updated_at, updated_by_human_id) VALUES (?, ?, ?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, version = version + 1,
             updated_at = excluded.updated_at, updated_by_human_id = excluded.updated_by_human_id
           RETURNING ${DOC_COLUMNS}`,
        )
        .get<DocRow>(doc.id, doc.title, doc.body, at, byHumanId);
      if (!row) throw new Error("knowledge put returned no row");
      this.audit.append({
        actorKind: "human",
        actorId: byHumanId,
        action: "knowledge.put",
        target: doc.id,
        data: { version: row.version },
      });
      return { ...row };
    }, "immediate");
  }

  /** Read-only view for agents. */
  reader(): Knowledge {
    const db = this.db;
    return Object.freeze({
      get(id: string): KnowledgeDoc | null {
        const row = db.prepare(`SELECT ${DOC_COLUMNS} FROM knowledge_docs WHERE id = ?`).get<DocRow>(id);
        return row ? { ...row } : null;
      },
      list(): Omit<KnowledgeDoc, "body">[] {
        return db
          .prepare("SELECT id, title, version, updated_at AS updatedAt FROM knowledge_docs ORDER BY id")
          .all<Omit<KnowledgeDoc, "body">>()
          .map((r) => ({ id: r.id, title: r.title, version: r.version, updatedAt: r.updatedAt }));
      },
    });
  }
}

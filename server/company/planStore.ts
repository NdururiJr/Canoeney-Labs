// A project's boards and tasks in the company store (spec M0.11; threat model
// SR-B-12, SR-D-08). The Planner writes a row before it changes its memory, so
// a write that fails changes nothing. Inside an MCP tool call the write joins
// the call's transaction, with its audit row.
import type { Board, Task } from "../../src/data/types";
import type { CompanyDb } from "./db";

interface BoardRow {
  id: string;
  title: string;
  status: Board["status"];
  ord: number;
}

interface TaskRow {
  id: string;
  board_id: string;
  title: string;
  owner_agent_id: string | null;
  status: Task["status"];
  needs_json: string;
  pr_number: number | null;
  description: string;
  files_json: string;
  done_when: string;
  note: string | null;
  created_by: string | null;
  ord: number;
}

export class PlanStore {
  constructor(private readonly db: CompanyDb) {}

  load(projectId: string): { boards: Board[]; tasks: Task[] } {
    const boards = this.db
      .prepare("SELECT id, title, status, ord FROM boards WHERE project_id = ? ORDER BY ord, rowid")
      .all<BoardRow>(projectId)
      .map((r): Board => ({ id: r.id, title: r.title, status: r.status, order: r.ord }));
    const prefix = `${projectId}/`;
    const tasks = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY ord, rowid")
      .all<TaskRow>(projectId)
      .map((r): Task => {
        const t: Task = {
          id: r.id,
          boardId: r.board_id,
          title: r.title,
          ownerId: r.owner_agent_id?.startsWith(prefix) ? r.owner_agent_id.slice(prefix.length) : null,
          status: r.status,
          needs: JSON.parse(r.needs_json) as string[],
          prNumber: r.pr_number,
          description: r.description,
          files: JSON.parse(r.files_json) as string[],
          doneWhen: r.done_when,
          note: r.note,
        };
        if (r.created_by !== null) t.createdBy = r.created_by;
        return t;
      });
    return { boards, tasks };
  }

  putBoard(projectId: string, board: Board): void {
    this.tx(() =>
      this.db
        .prepare(
          `INSERT INTO boards(project_id, id, title, status, ord) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_id, id) DO UPDATE SET title = excluded.title, status = excluded.status, ord = excluded.ord`,
        )
        .run(projectId, board.id, board.title, board.status, board.order),
    );
  }

  /** `ownerId` is the project-local agent id. A task keeps its place (`ord`) once written. */
  putTask(projectId: string, task: Task): void {
    this.tx(() => {
      const existing = this.db.prepare("SELECT ord FROM tasks WHERE project_id = ? AND id = ?").get<{ ord: number }>(projectId, task.id);
      const ord =
        existing?.ord ??
        (this.db.prepare("SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM tasks WHERE project_id = ?").get<{ n: number }>(projectId)?.n ?? 0);
      this.db
        .prepare(
          `INSERT INTO tasks(project_id, id, board_id, title, owner_agent_id, status, needs_json, pr_number, description, files_json,
             done_when, note, created_by, ord)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, id) DO UPDATE SET board_id = excluded.board_id, title = excluded.title,
             owner_agent_id = excluded.owner_agent_id, status = excluded.status, needs_json = excluded.needs_json,
             pr_number = excluded.pr_number, description = excluded.description, files_json = excluded.files_json,
             done_when = excluded.done_when, note = excluded.note, created_by = excluded.created_by`,
        )
        .run(
          projectId,
          task.id,
          task.boardId,
          task.title,
          task.ownerId ? `${projectId}/${task.ownerId}` : null,
          task.status,
          JSON.stringify(task.needs ?? []),
          task.prNumber,
          task.description ?? "",
          JSON.stringify(task.files ?? []),
          task.doneWhen ?? "",
          task.note ?? null,
          task.createdBy ?? null,
          ord,
        );
    });
  }

  private tx<T>(fn: () => T): T {
    return this.db.inTransaction ? fn() : this.db.transaction(fn, "immediate");
  }
}

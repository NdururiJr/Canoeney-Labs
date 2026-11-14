import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeHq } from "../testing/hqFixture";
import { AgentRegistry } from "./agents";
import { AgentSecrets } from "./agentSecrets";
import { SqliteAuditSink } from "./audit";
import { FakeClock } from "./clock";
import { openCompanyDb } from "./db";
import { PlanStore } from "./planStore";

test("boards and tasks come back from the store after a restart, with plan.json deleted", async (t) => {
  const hq = await makeHq(t);
  const board = hq.planner.createBoard("Phase one", "active");
  const a = hq.planner.createTask({ boardId: board.id, title: "First", description: "do it", files: ["src/a.ts"], doneWhen: "tests pass", needs: [] }, "lead");
  const b = hq.planner.createTask({ boardId: board.id, title: "Second", needs: [a.id] }, "lead");
  hq.planner.assign(b.id, "ana", "lead");

  // HQ writes no plan file any more.
  assert.equal(existsSync(join(hq.hub.repo.root, ".jsmhq", "plan.json")), false);

  // A fresh reader of the same store sees what the planner holds in memory.
  const again = new PlanStore(hq.company.db).load(hq.slug);
  assert.deepEqual(again.boards, hq.hub.snap.boards);
  assert.deepEqual(again.tasks, hq.hub.snap.tasks);
  assert.deepEqual(
    again.tasks.map((x) => [x.id, x.ownerId, x.createdBy, x.needs]),
    [
      [a.id, null, "lead", []],
      [b.id, "ana", "lead", [a.id]],
    ],
  );
});

test("PlanStore keeps a task's place and its fields across a reopen of the file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "plan store "));
  const file = join(dir, "company.db");
  const db = openCompanyDb(file);
  const clock = new FakeClock("2026-11-13T08:00:00.000Z");
  const audit = new SqliteAuditSink(db, clock);
  const agents = new AgentRegistry(db, clock, audit, new AgentSecrets(db, clock, audit));
  agents.ensureProject({ slug: "p", name: "p", root: join(dir, "repo"), github: null });
  agents.register("p", { id: "ana", name: "Ana", cli: "claude" }, "builder", { kind: "hq", id: "hq" }, "config");
  const store = new PlanStore(db);
  store.putBoard("p", { id: "B1", title: "Backlog", status: "active", order: 0 });
  store.putTask("p", { id: "B1-T01", boardId: "B1", title: "One", ownerId: null, status: "todo", needs: [], prNumber: null });
  store.putTask("p", { id: "B1-T02", boardId: "B1", title: "Two", ownerId: "ana", status: "in-review", needs: ["B1-T01"], prNumber: 7, note: "PR open" });
  store.putTask("p", { id: "B1-T01", boardId: "B1", title: "One, renamed", ownerId: null, status: "done", needs: [], prNumber: 3 });
  db.close();

  const reopened = openCompanyDb(file);
  t.after(() => {
    reopened.close(); // before the folder goes: Windows keeps an open database locked
    rmSync(dir, { recursive: true, force: true });
  });
  const { boards, tasks } = new PlanStore(reopened).load("p");
  assert.deepEqual(boards, [{ id: "B1", title: "Backlog", status: "active", order: 0 }]);
  assert.deepEqual(
    tasks.map((x) => [x.id, x.title, x.status, x.ownerId, x.prNumber, x.note]),
    [
      ["B1-T01", "One, renamed", "done", null, 3, null],
      ["B1-T02", "Two", "in-review", "ana", 7, "PR open"],
    ],
  );
});

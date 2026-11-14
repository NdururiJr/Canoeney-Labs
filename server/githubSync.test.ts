// SR-E-12: a pull request belongs to the identity that opened it (M0-E Task 5).
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { GhPr } from "./github";
import { GitHubSync } from "./githubSync";
import { makeHq } from "./testing/hqFixture";

const ANA_BOT = 501;
const BEN_BOT = 502;

function pr(n: number, o: { title: string; branch: string; author: GhPr["author"]; state?: GhPr["state"] }): GhPr {
  return {
    number: n,
    title: o.title,
    url: `https://github.com/acme/site/pull/${n}`,
    headRefName: o.branch,
    createdAt: "2026-11-14T10:00:00Z",
    mergedAt: o.state === "MERGED" ? "2026-11-14T11:00:00Z" : null,
    state: o.state ?? "OPEN",
    mergeable: "MERGEABLE",
    isDraft: false,
    reviewDecision: null,
    author: o.author,
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: { nodes: [] },
  } as GhPr;
}

const bot = (databaseId: number, login = "hq-site-x") => ({ __typename: "Bot", login, databaseId });

/** HQ with a GitHubSync whose fetch returns `prs` (open and merged lists). */
async function synced(t: TestContext) {
  const hq = await makeHq(t);
  hq.hub.snap.setup = { ...hq.hub.snap.setup, checks: [...hq.hub.snap.setup.checks, { id: "gh", status: "ok", label: "gh", detail: "", fix: null, neededFor: "github" } as never] };
  const benTask = hq.planner.createTask({ title: "Ben's work", boardId: hq.planner.defaultBoard().id }, "lead");
  hq.planner.assign(benTask.id, "ben", "lead");
  const anaTask = hq.planner.createTask({ title: "Ana's work", boardId: hq.planner.defaultBoard().id }, "lead");
  hq.planner.assign(anaTask.id, "ana", "lead");
  let prs: { open: GhPr[]; merged: GhPr[] } = { open: [], merged: [] };
  const bots = new Map([
    [ANA_BOT, "ana"],
    [BEN_BOT, "ben"],
  ]);
  const sync = new GitHubSync(hq.hub, hq.planner, "acme/site", {
    fetch: async () => ({ ...prs, closed: [], rate: null }),
    agentForBot: (id) => bots.get(id) ?? null,
    audit: hq.company.audit,
  });
  const poll = async (next: { open?: GhPr[]; merged?: GhPr[] }) => {
    prs = { open: next.open ?? [], merged: next.merged ?? [] };
    (sync as unknown as { lastFetch: number }).lastFetch = 0;
    await sync.refresh();
  };
  return { hq, sync, poll, benTask, anaTask };
}

test("SR-E-12 [T-S3.8] a PR opened by A on b/… titled with B's task id is A's", async (t) => {
  const { hq, poll, benTask } = await synced(t);
  const forged = { title: `[${benTask.id}] Ben's work`, branch: "ben/forged", author: bot(ANA_BOT) };
  await poll({ open: [pr(7, forged)] });
  assert.equal(hq.hub.snap.pullRequests[0].authorId, "ana");
  assert.equal(hq.hub.snap.pullRequests[0].taskId, "");
  assert.equal(hq.planner.task(benTask.id)?.status, benTask.status, "ben's task did not move to review");
  await poll({ merged: [pr(7, { ...forged, state: "MERGED" })] });
  assert.notEqual(hq.planner.task(benTask.id)?.status, "done", "nor to done when it merged");
  const rows = hq.company.audit.query({ action: "pr.misattributed" });
  assert.equal(rows.length, 1, "flagged once");
  assert.deepEqual([rows[0].target, rows[0].data.author, rows[0].data.claimed], ["acme/site#7", "ana", "ben"]);
  const line = hq.hub.snap.activity.find((a) => /claims another agent/.test(a.text));
  assert.ok(line, "an activity line");
  assert.equal(line.text.includes("ben/forged"), false, "the branch name is agent text, kept out of HQ's sentence");
});

test("a PR by its own task's agent moves that task, as before", async (t) => {
  const { hq, poll, anaTask } = await synced(t);
  const own = { title: `[${anaTask.id}] Ana's work`, branch: "ana/work", author: bot(ANA_BOT) };
  await poll({ open: [pr(8, own)] });
  assert.equal(hq.planner.task(anaTask.id)?.status, "in-review");
  await poll({ merged: [pr(8, { ...own, state: "MERGED" })] });
  assert.equal(hq.planner.task(anaTask.id)?.status, "done");
  assert.equal(hq.company.audit.query({ action: "pr.misattributed" }).length, 0);
});

test("a PR opened by the owner is nobody's task", async (t) => {
  const { hq, poll, anaTask } = await synced(t);
  await poll({ open: [pr(9, { title: `[${anaTask.id}] by hand`, branch: "ana/hand", author: { __typename: "User", login: "acme" } })] });
  assert.equal(hq.hub.snap.pullRequests[0].authorId, "");
  assert.equal(hq.planner.task(anaTask.id)?.status, anaTask.status);
});

test("a PR by a User whose login equals an agent App's slug is nobody's task", async (t) => {
  const { hq, poll, anaTask } = await synced(t);
  await poll({ open: [pr(10, { title: `[${anaTask.id}] lookalike`, branch: "ana/x", author: { __typename: "User", login: "hq-site-ana-1a2b", databaseId: ANA_BOT } as never })] });
  assert.equal(hq.hub.snap.pullRequests[0].authorId, "");
  assert.equal(hq.planner.task(anaTask.id)?.status, anaTask.status);
});

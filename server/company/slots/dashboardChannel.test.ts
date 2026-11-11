import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeClock } from "../clock";
import { openCompanyDb } from "../db";
import { DashboardChannel } from "./dashboardChannel";

const START = "2026-11-11T06:00:00.000Z";

test("send writes one outbox row and returns its id", async (t) => {
  const db = openCompanyDb(":memory:");
  t.after(() => db.close());
  db.prepare("INSERT INTO humans(id, display_name, role, created_at) VALUES (?, ?, ?, ?)").run(
    "owner1",
    "Owner",
    "owner",
    START,
  );
  const channel = new DashboardChannel(db, new FakeClock(START));
  assert.equal(channel.name, "dashboard");

  const res = await channel.send({
    recipientHumanId: "owner1",
    decisionId: null,
    urgency: "high",
    title: "Approve refund?",
    body: "Reply with #K7Q2M",
    link: null,
  });
  assert.equal(res.ok, true);

  const rows = db.prepare("SELECT * FROM channel_outbox").all<Record<string, unknown>>();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.channel, "dashboard");
  assert.equal(row.status, "sent");
  assert.equal(row.recipient_human_id, "owner1");
  assert.equal(row.decision_id, null);
  assert.equal(row.urgency, "high");
  assert.equal(row.title, "Approve refund?");
  assert.equal(row.link, null);
  assert.equal(row.created_at, START);
  assert.equal(row.sent_at, START);
  assert.deepEqual(res, { ok: true, providerRef: String(row.id) });
});

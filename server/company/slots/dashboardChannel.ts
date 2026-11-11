import type { Clock } from "../clock";
import type { CompanyDb } from "../db";
import type { Channel, OutboundAlert, SendResult } from "./types";

// The always-available channel: alerts are recorded in channel_outbox for the
// dashboard to show. Real providers (WhatsApp, Telegram, email) come later.
export class DashboardChannel implements Channel {
  readonly name = "dashboard";

  constructor(
    private readonly db: CompanyDb,
    private readonly clock: Clock,
  ) {}

  async send(a: OutboundAlert): Promise<SendResult> {
    const now = this.clock.now().toISOString();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO channel_outbox(channel, recipient_human_id, decision_id, urgency, title, body, link, status, created_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)`,
      )
      .run(this.name, a.recipientHumanId, a.decisionId, a.urgency, a.title, a.body, a.link, now, now);
    return { ok: true, providerRef: String(lastInsertRowid) };
  }
}

import type { Migration } from "../migrations";

const up = `
CREATE TABLE channel_outbox(
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,
  recipient_human_id TEXT NOT NULL REFERENCES humans(id),
  decision_id TEXT NULL REFERENCES decisions(id),
  urgency TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
  created_at TEXT NOT NULL,
  sent_at TEXT NULL
);
`;

export const m003: Migration = { version: 3, name: "channel-outbox", up };

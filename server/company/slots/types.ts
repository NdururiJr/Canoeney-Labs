// Interfaces for the pluggable slots of the company core. Each slot has a
// default implementation elsewhere in server/company/.
import type { ActorKind, Urgency } from "../types";

export interface AuditEventInput {
  actorKind: ActorKind;
  actorId: string;
  action: string;
  target?: string | null;
  decisionId?: string | null;
  data?: Record<string, unknown>;
}

export interface AuditEvent {
  seq: number;
  at: string;
  actorKind: ActorKind;
  actorId: string;
  action: string;
  target: string | null;
  decisionId: string | null;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

// limit defaults to 100 and is capped at 1000; results are ordered by seq ascending.
export interface AuditQuery {
  actorId?: string;
  action?: string;
  decisionId?: string;
  afterSeq?: number;
  limit?: number;
}

export type AuditVerify = { ok: true; count: number; head: string | null } | { ok: false; brokenAtSeq: number };

export interface AuditSink {
  append(e: AuditEventInput): AuditEvent;
  head(): { seq: number; hash: string } | null;
  verify(): AuditVerify;
  query(q?: AuditQuery): AuditEvent[];
}

export type MemoryScope = { kind: "agent" | "client"; id: string };

export interface MemoryEntry {
  key: string;
  value: string;
  updatedAt: string;
}

export const MEMORY_VALUE_MAX_BYTES = 65_536;

// Long-term memory per agent or client. set throws RangeError when the value's
// UTF-8 length exceeds MEMORY_VALUE_MAX_BYTES; list is sorted by key.
export interface Memory {
  get(s: MemoryScope, key: string): string | null;
  set(s: MemoryScope, key: string, value: string): void;
  delete(s: MemoryScope, key: string): boolean;
  list(s: MemoryScope): MemoryEntry[];
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  body: string;
  version: number;
  updatedAt: string;
}

// The agent-facing, read-only view of company knowledge. Writes go through the
// owner path on the store (SqliteKnowledgeStore.put), never through this.
export interface Knowledge {
  get(id: string): KnowledgeDoc | null;
  list(): Omit<KnowledgeDoc, "body">[];
}

// An inbound message from the owner on any channel. text is untrusted input.
export interface InboundMessage {
  channel: string;
  senderRef: string;
  text: string;
  receivedAt: string;
}

export type Route =
  | { kind: "decision-reply"; code: string }
  | { kind: "unrouted"; reason: "no-code" | "ambiguous" };

// Finds which decision an inbound message answers. It never interprets the
// message (yes/no); that is a later step with its own checks.
export interface Router {
  route(m: InboundMessage): Route;
}

export interface OutboundAlert {
  recipientHumanId: string;
  decisionId: string | null;
  urgency: Urgency;
  title: string;
  body: string;
  link: string | null;
}

// retryable: false means the provider rejected the alert, so the caller falls
// straight through to the next channel instead of retrying this one.
export type SendResult = { ok: true; providerRef: string } | { ok: false; error: string; retryable: boolean };

export interface Channel {
  readonly name: string;
  send(a: OutboundAlert): Promise<SendResult>;
}

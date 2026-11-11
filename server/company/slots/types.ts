// Interfaces for the pluggable slots of the company core. Each slot has a
// default implementation elsewhere in server/company/.
import type { ActorKind } from "../types";

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

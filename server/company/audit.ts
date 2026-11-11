// Tamper-evident audit chain (docs/adr/0003-audit-hash-chain.md). Each row's
// hash covers the previous row's hash, so editing, deleting or reordering rows
// breaks verification from that point on. The head hash is anchored off-host
// by a later plan; without that anchor the tail of the chain can be truncated.
import { createHash } from "node:crypto";
import type { Clock } from "./clock";
import type { CompanyDb } from "./db";
import { canonicalJson } from "./canonicalJson";
import type { AuditEvent, AuditEventInput, AuditQuery, AuditSink, AuditVerify } from "./slots/types";
import type { ActorKind } from "./types";

export const GENESIS_HASH = "0".repeat(64);

// Key names that look like secret values. Names such as "secretName" are fine:
// secret names may be logged, secret values may not (spec section 4).
const SECRET_KEY = /^(secret|token|password|passphrase|pin|api[-_]?key|authorization|cookie|private[-_]?key)$/i;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const VERIFY_PAGE = 1000;

export class AuditSecretError extends Error {
  constructor(key: string) {
    super(`audit data has a secret-shaped key: ${key}`);
    this.name = "AuditSecretError";
  }
}

interface Row {
  seq: number;
  at: string;
  actor_kind: ActorKind;
  actor_id: string;
  action: string;
  target: string | null;
  decision_id: string | null;
  data_json: string;
  prev_hash: string;
  hash: string;
}

interface HashFields {
  seq: number;
  at: string;
  actorKind: string;
  actorId: string;
  action: string;
  target: string | null;
  decisionId: string | null;
  data: Record<string, unknown>;
}

function assertNoSecretKeys(value: unknown, seen: Set<object> = new Set()): void {
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return; // cycles are rejected later by canonicalJson
  seen.add(value);
  if (Array.isArray(value)) {
    for (const v of value) assertNoSecretKeys(v, seen);
    return;
  }
  for (const [key, v] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new AuditSecretError(key);
    assertNoSecretKeys(v, seen);
  }
}

function computeHash(prevHash: string, f: HashFields): string {
  const payload = canonicalJson({
    seq: f.seq,
    at: f.at,
    actorKind: f.actorKind,
    actorId: f.actorId,
    action: f.action,
    target: f.target,
    decisionId: f.decisionId,
    data: f.data,
  });
  return createHash("sha256")
    .update(prevHash + "\n" + payload)
    .digest("hex");
}

function toEvent(r: Row): AuditEvent {
  return {
    seq: r.seq,
    at: r.at,
    actorKind: r.actor_kind,
    actorId: r.actor_id,
    action: r.action,
    target: r.target,
    decisionId: r.decision_id,
    data: JSON.parse(r.data_json) as Record<string, unknown>,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

export class SqliteAuditSink implements AuditSink {
  constructor(
    private readonly db: CompanyDb,
    private readonly clock: Clock,
  ) {}

  append(e: AuditEventInput): AuditEvent {
    const data = e.data ?? {};
    // Refuse before opening the transaction: nothing is written on refusal.
    assertNoSecretKeys(data);
    const dataJson = canonicalJson(data); // also rejects unsupported values early
    const target = e.target ?? null;
    const decisionId = e.decisionId ?? null;
    const at = this.clock.now().toISOString();

    return this.db.transaction(() => {
      const last = this.head();
      const seq = last ? last.seq + 1 : 1;
      const prevHash = last ? last.hash : GENESIS_HASH;
      const hash = computeHash(prevHash, {
        seq,
        at,
        actorKind: e.actorKind,
        actorId: e.actorId,
        action: e.action,
        target,
        decisionId,
        data,
      });
      // Plain INSERT, never OR REPLACE: a clashing seq must fail, not overwrite.
      this.db
        .prepare(
          `INSERT INTO audit_events(seq, at, actor_kind, actor_id, action, target, decision_id, data_json, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(seq, at, e.actorKind, e.actorId, e.action, target, decisionId, dataJson, prevHash, hash);
      return {
        seq,
        at,
        actorKind: e.actorKind,
        actorId: e.actorId,
        action: e.action,
        target,
        decisionId,
        data: JSON.parse(dataJson) as Record<string, unknown>,
        prevHash,
        hash,
      };
    }, "immediate");
  }

  head(): { seq: number; hash: string } | null {
    const row = this.db.prepare("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1").get<{ seq: number; hash: string }>();
    // Rebuilt as a plain object: node:sqlite rows have a null prototype.
    return row ? { seq: row.seq, hash: row.hash } : null;
  }

  verify(): AuditVerify {
    const page = this.db.prepare("SELECT * FROM audit_events WHERE seq > ? ORDER BY seq ASC LIMIT ?");
    let prevSeq = 0;
    let prevHash = GENESIS_HASH;
    let count = 0;
    for (;;) {
      const rows = page.all<Row>(prevSeq, VERIFY_PAGE);
      if (rows.length === 0) break;
      for (const r of rows) {
        if (r.seq !== prevSeq + 1 || r.prev_hash !== prevHash || !rowIntact(r)) {
          return { ok: false, brokenAtSeq: r.seq };
        }
        prevSeq = r.seq;
        prevHash = r.hash;
        count++;
      }
    }
    return { ok: true, count, head: count === 0 ? null : prevHash };
  }

  query(q: AuditQuery = {}): AuditEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.actorId !== undefined) {
      where.push("actor_id = ?");
      params.push(q.actorId);
    }
    if (q.action !== undefined) {
      where.push("action = ?");
      params.push(q.action);
    }
    if (q.decisionId !== undefined) {
      where.push("decision_id = ?");
      params.push(q.decisionId);
    }
    if (q.afterSeq !== undefined) {
      where.push("seq > ?");
      params.push(Math.trunc(q.afterSeq));
    }
    const requested = q.limit === undefined || !Number.isFinite(q.limit) ? DEFAULT_LIMIT : Math.trunc(q.limit);
    const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);
    const sql = `SELECT * FROM audit_events${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY seq ASC LIMIT ?`;
    return this.db
      .prepare(sql)
      .all<Row>(...params, limit)
      .map(toEvent);
  }
}

// Recompute the hash from the stored columns; the stored hash is never trusted.
function rowIntact(r: Row): boolean {
  try {
    const data = JSON.parse(r.data_json) as Record<string, unknown>;
    if (canonicalJson(data) !== r.data_json) return false; // stored form must be canonical
    return (
      computeHash(r.prev_hash, {
        seq: r.seq,
        at: r.at,
        actorKind: r.actor_kind,
        actorId: r.actor_id,
        action: r.action,
        target: r.target,
        decisionId: r.decision_id,
        data,
      }) === r.hash
    );
  } catch {
    return false; // unparseable or unhashable row
  }
}

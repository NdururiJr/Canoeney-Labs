// Tamper-evident audit chain (docs/adr/0003-audit-hash-chain.md). Each row's
// hash covers the previous row's hash, so editing, deleting or reordering rows
// breaks verification from that point on. The head hash is anchored off-host
// by a later plan; without that anchor the tail of the chain can be truncated.
import { createHash } from "node:crypto";
import type { Clock } from "./clock";
import type { CompanyDb } from "./db";
import { canonicalJson } from "./canonicalJson";
import type { AuditEvent, AuditEventInput, AuditQuery, AuditSink, AuditVerify } from "./slots/types";
import { ACTOR_KINDS, type ActorKind } from "./types";

export const GENESIS_HASH = "0".repeat(64);

// Spec section 4: a secret value never enters the audit trail. Two guards:
//
// 1. Key names. A key is normalised (lower-cased, "-", "_" and whitespace
//    removed). A key that names a secret without holding one (ends with name,
//    names, id or ids: secretName, tokenId) is allowed. Otherwise it is refused
//    if it contains a secret word anywhere, or contains "token" not followed by
//    "s" or "count" (inputTokens and tokenCount are usage), or ends with one of
//    the short words, which would match too much inside other words (pinned).
// 2. Values. Every string in data, every key, the target and the action are
//    scanned for known credential shapes.
const SECRET_WORDS = [
  "secret",
  "password",
  "passphrase",
  "apikey",
  "accesskey",
  "privatekey",
  "privkey",
  "authorization",
  "authheader",
  "bearer",
  "credential",
  "cookie",
  "jwt",
];
const SECRET_SUFFIXES = ["pin", "pinhash", "pincode", "otp", "totp", "recoverycode", "recoverycodes", "pat", "auth", "signature"];
const NAMING_SUFFIXES = ["name", "names", "id", "ids"];
const TOKEN_WORD = /token(?!s|count)/;

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_\s]/g, "");
  if (NAMING_SUFFIXES.some((s) => k.endsWith(s))) return false;
  return SECRET_WORDS.some((w) => k.includes(w)) || TOKEN_WORD.test(k) || SECRET_SUFFIXES.some((s) => k.endsWith(s));
}

// Known credential shapes. The distinctive prefixes have no leading \b, so a
// credential glued to a letter, digit or "_" (xghp_..., key_hqa_...) still
// matches; sk- keeps it so ordinary words (task-..., disk-...) do not.
export const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /xox[abposr]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*-----/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /hqa_[A-Za-z0-9_-]{43}/,
];

export const hasCredentialShape = (s: string): boolean => CREDENTIAL_SHAPES.some((r) => r.test(s));

// A lone surrogate (category Cs in unicode mode). String.prototype.isWellFormed
// would do, but the ES2022 lib in tsconfig does not declare it.
const LONE_SURROGATE = /\p{Cs}/u;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const VERIFY_PAGE = 1000;

/** `where` names the field ("data.headers.auth", "target"); it never holds the matched text. */
export class AuditSecretError extends Error {
  constructor(where: string) {
    super(`audit refused a secret-shaped key or value at ${where}`);
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

function assertNoSecrets(value: unknown, where: string, seen: Set<object> = new Set()): void {
  if (typeof value === "string") {
    if (hasCredentialShape(value)) throw new AuditSecretError(where);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return; // cycles are rejected later by canonicalJson
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${where}[${i}]`, seen));
    return;
  }
  for (const [key, v] of Object.entries(value)) {
    if (hasCredentialShape(key)) throw new AuditSecretError(`${where}.<key>`);
    if (isSecretKey(key)) throw new AuditSecretError(`${where}.${key}`);
    assertNoSecrets(v, `${where}.${key}`, seen);
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

  // Callers that open their own transaction so a business write and its audit
  // event commit together should use mode "immediate": append then joins that
  // transaction instead of starting one. Without a caller transaction it runs
  // in its own BEGIN IMMEDIATE transaction.
  append(e: AuditEventInput): AuditEvent {
    // Types are checked at run time too: a number or object here would be
    // hashed as JSON but stored as SQLite text, so verify could never
    // reproduce the hash of that row.
    if (!(ACTOR_KINDS as readonly unknown[]).includes(e.actorKind)) throw new TypeError("audit actorKind must be agent, human or hq");
    if (typeof e.actorId !== "string") throw new TypeError("audit actorId must be a string");
    if (typeof e.action !== "string") throw new TypeError("audit action must be a string");
    for (const [name, v] of [
      ["target", e.target],
      ["decisionId", e.decisionId],
    ] as const) {
      if (v !== undefined && v !== null && typeof v !== "string") throw new TypeError(`audit ${name} must be a string or null`);
    }
    // Refuse before any transaction: nothing is written on refusal. SQLite TEXT
    // would store a lone surrogate as U+FFFD, and verify could then never
    // reproduce the hash of that row. (data is safe: JSON escapes surrogates.)
    for (const [name, v] of [
      ["actorId", e.actorId],
      ["action", e.action],
      ["target", e.target],
      ["decisionId", e.decisionId],
    ] as const) {
      if (typeof v === "string" && LONE_SURROGATE.test(v)) throw new TypeError(`audit ${name} is not well-formed unicode`);
    }
    if (hasCredentialShape(e.action)) throw new AuditSecretError("action");
    if (typeof e.target === "string" && hasCredentialShape(e.target)) throw new AuditSecretError("target");
    assertNoSecrets(e.data ?? {}, "data");
    const dataJson = canonicalJson(e.data ?? {}); // also rejects unsupported values early
    // Hash the stored form, never the caller's object: a getter or a later
    // mutation must not make the hash differ from the row that is stored.
    const data = JSON.parse(dataJson) as Record<string, unknown>;
    const target = e.target ?? null;
    const decisionId = e.decisionId ?? null;

    const write = (): AuditEvent => {
      // Read inside the write transaction, so another writer can never store a
      // later seq with an earlier time.
      const at = this.clock.now().toISOString();
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
    };
    return this.db.inTransaction ? write() : this.db.transaction(write, "immediate");
  }

  head(): { seq: number; hash: string } | null {
    const row = this.db.prepare("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1").get<{ seq: number; hash: string }>();
    // Rebuilt as a plain object: node:sqlite rows have a null prototype.
    return row ? { seq: row.seq, hash: row.hash } : null;
  }

  verify(): AuditVerify {
    // The walk below covers seq 1, 2, 3, ... only. A row below 1 is outside the
    // chain (the chain trigger refuses one, but a trigger can be dropped), so it
    // fails verification: brokenAtSeq is then the lowest such seq.
    const min = this.db.prepare("SELECT MIN(seq) AS m FROM audit_events").get<{ m: number | null }>()?.m ?? null;
    if (min !== null && min < 1) return { ok: false, brokenAtSeq: min };
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

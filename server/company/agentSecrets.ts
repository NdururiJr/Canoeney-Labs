// Per-agent secrets (spec M0.2; docs/adr/0005-agent-identity.md). A secret is
// "hqa_" + base64url of 32 random bytes. The store keeps only its SHA-256 hash
// (owner decision D8), so HQ can check a secret but never hand it out again.
import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "./clock";
import type { CompanyDb } from "./db";
import type { AuditSink } from "./slots/types";

export const AGENT_SECRET_PATTERN = /^hqa_[A-Za-z0-9_-]{43}$/;

export type RevokeReason = "stopped" | "paused" | "retired";

export type AuthResult =
  | { ok: true; companyAgentId: string }
  | { ok: false; reason: "malformed" | "unknown" }
  | { ok: false; reason: "revoked" | "inactive"; companyAgentId: string };

/** SHA-256 hex. No salt or slow hash is needed: the input is 256 random bits. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export class AgentSecrets {
  constructor(
    private readonly db: CompanyDb,
    private readonly clock: Clock,
    private readonly audit: AuditSink,
  ) {}

  /** Revokes the live secret (reason "rotated") and returns a new one. The clear value is never stored. */
  issue(companyAgentId: string): string {
    const secret = `hqa_${randomBytes(32).toString("base64url")}`;
    this.inTx(() => {
      const now = this.clock.now().toISOString();
      this.db
        .prepare("UPDATE agent_secrets SET revoked_at = ?, revoked_reason = 'rotated' WHERE agent_id = ? AND revoked_at IS NULL")
        .run(now, companyAgentId);
      this.db.prepare("INSERT INTO agent_secrets(agent_id, secret_hash, issued_at) VALUES (?, ?, ?)").run(companyAgentId, hashSecret(secret), now);
      this.audit.append({ actorKind: "hq", actorId: "hq", action: "agent.secret.issued", target: companyAgentId });
    });
    return secret;
  }

  authenticate(secret: string): AuthResult {
    if (typeof secret !== "string" || !AGENT_SECRET_PATTERN.test(secret)) return { ok: false, reason: "malformed" };
    const row = this.db
      .prepare(
        `SELECT s.agent_id AS agentId, s.revoked_at AS revokedAt, a.status AS status
         FROM agent_secrets s JOIN agents a ON a.id = s.agent_id WHERE s.secret_hash = ?`,
      )
      .get<{ agentId: string; revokedAt: string | null; status: string }>(hashSecret(secret));
    if (!row) return { ok: false, reason: "unknown" };
    if (row.revokedAt !== null) return { ok: false, reason: "revoked", companyAgentId: row.agentId };
    if (row.status !== "active") return { ok: false, reason: "inactive", companyAgentId: row.agentId };
    return { ok: true, companyAgentId: row.agentId };
  }

  /** Revokes the live secret, if any. Joins a caller's transaction when one is open. */
  revoke(companyAgentId: string, reason: RevokeReason): boolean {
    return this.inTx(() => {
      const { changes } = this.db
        .prepare("UPDATE agent_secrets SET revoked_at = ?, revoked_reason = ? WHERE agent_id = ? AND revoked_at IS NULL")
        .run(this.clock.now().toISOString(), reason, companyAgentId);
      if (changes > 0) this.audit.append({ actorKind: "hq", actorId: "hq", action: "agent.secret.revoked", target: companyAgentId, data: { reason } });
      return changes > 0;
    });
  }

  hasLive(companyAgentId: string): boolean {
    return !!this.db.prepare("SELECT 1 AS x FROM agent_secrets WHERE agent_id = ? AND revoked_at IS NULL").get(companyAgentId);
  }

  private inTx<T>(fn: () => T): T {
    return this.db.inTransaction ? fn() : this.db.transaction(fn, "immediate");
  }
}

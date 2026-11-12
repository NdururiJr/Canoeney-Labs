// Who is calling /mcp or /hook (spec M0.2, threat model SR-B-01 to SR-B-08,
// SR-B-21). The only source of identity is `Authorization: Bearer <secret>`.
// An agent id in the hook URL or an X-HQ-Agent header is a claim that must
// match the secret's agent. Every failure gets the same 401.
import type { IncomingMessage } from "node:http";
import type { Company } from "./company";
import type { RegisteredAgent } from "./company/agents";
import type { Hub } from "./hub";

export interface AuthLimits {
  /** Requests a secret may send at once. */
  perSecretBurst: number;
  /** Refill rate of a secret's bucket. */
  perSecretPerSecond: number;
  /** Failed requests per source per minute before failures get 429. */
  failuresPerSourcePerMinute: number;
}

export const DEFAULT_AUTH_LIMITS: AuthLimits = { perSecretBurst: 100, perSecretPerSecond: 50, failuresPerSourcePerMinute: 20 };

export type Endpoint = "mcp" | "hook";
export type CheckResult = { ok: true; agent: RegisteredAgent } | { ok: false; status: 401 | 429 };

type FailReason = "missing" | "malformed" | "unknown" | "revoked" | "inactive" | "other-project" | "not-in-config";

const MINUTE = 60_000;
const BEARER = /^Bearer ([^\s]+)$/i;

export class AgentAuth {
  private readonly slug: string;
  private readonly company: Company;
  private readonly hub: Hub;
  private readonly limits: AuthLimits;
  private buckets = new Map<string, { tokens: number; at: number }>();
  private failuresBySource = new Map<string, { start: number; count: number }>();
  /** Audit windows for failures, keyed by what failed (an agent, or a reason). */
  private failureWindows = new Map<string, { start: number; pending: number }>();
  /** Last minute an auth.rate-limited row was written, per key. */
  private limitedRows = new Map<string, number>();

  constructor(o: { projectSlug: string; company: Company; hub: Hub; limits?: Partial<AuthLimits> }) {
    this.slug = o.projectSlug;
    this.company = o.company;
    this.hub = o.hub;
    this.limits = { ...DEFAULT_AUTH_LIMITS, ...o.limits };
  }

  /** Never throws: anything that goes wrong inside, an audit write included, is a 401. */
  check(req: IncomingMessage, endpoint: Endpoint, claimedAgentId: string | null): CheckResult {
    try {
      return this.run(req, endpoint, claimedAgentId);
    } catch {
      return { ok: false, status: 401 };
    }
  }

  private run(req: IncomingMessage, endpoint: Endpoint, claimed: string | null): CheckResult {
    const source = req.socket.remoteAddress ?? "unknown";
    const header = req.headers.authorization;
    const m = typeof header === "string" ? BEARER.exec(header) : null;
    if (!m) return this.fail(source, endpoint, "missing", null);

    const auth = this.company.secrets.authenticate(m[1]);
    if (!auth.ok) return this.fail(source, endpoint, auth.reason, "companyAgentId" in auth ? auth.companyAgentId : null);
    const agent = this.company.agents.getById(auth.companyAgentId);
    if (!agent || agent.projectSlug !== this.slug) return this.fail(source, endpoint, "other-project", auth.companyAgentId);
    if (!this.hub.cfg(agent.agentId)) return this.fail(source, endpoint, "not-in-config", agent.companyId);

    if (!this.take(agent.companyId)) {
      this.limitedRow(agent.companyId, { target: agent.companyId, data: { endpoint } });
      return { ok: false, status: 429 };
    }

    if (claimed !== null && claimed !== agent.agentId) {
      // The claim is agent text: recorded as it is only when it names an agent of this project.
      const recorded = this.company.agents.get(this.slug, claimed) ? claimed : { chars: claimed.length };
      this.company.audit.append({
        actorKind: "agent",
        actorId: agent.companyId,
        action: "agent.identity-mismatch",
        data: { endpoint, claimed: recorded },
      });
      return { ok: false, status: 401 };
    }
    return { ok: true, agent };
  }

  /** Token bucket per secret (one live secret per agent, so per agent). */
  private take(key: string): boolean {
    const now = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.limits.perSecretBurst, at: now };
    b.tokens = Math.min(this.limits.perSecretBurst, b.tokens + ((now - b.at) / 1000) * this.limits.perSecretPerSecond);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private fail(source: string, endpoint: Endpoint, reason: FailReason, agentId: string | null): CheckResult {
    const now = this.now();
    // Audit, collapsed by what failed: one window per agent (when the hash
    // matched a stored row) or per reason. The source plays no part here: all
    // sandbox traffic arrives through one proxy, so it would hide everything.
    const key = agentId ? `agent:${agentId}` : `reason:${reason}`;
    const w = this.failureWindows.get(key);
    if (!w || now >= w.start + MINUTE) {
      const data: Record<string, unknown> = { endpoint, reason };
      if (w && w.pending > 0) data.suppressed = w.pending;
      this.failureWindows.set(key, { start: now, pending: 0 });
      this.company.audit.append({ actorKind: "hq", actorId: "hq", action: "auth.failed", target: agentId, data });
    } else {
      w.pending++;
    }
    // Rate limit failures per source. The secret is checked first, so a valid
    // secret is never refused because of failures.
    const s = this.failuresBySource.get(source);
    const f = !s || now >= s.start + MINUTE ? { start: now, count: 0 } : s;
    f.count++;
    this.failuresBySource.set(source, f);
    if (f.count > this.limits.failuresPerSourcePerMinute) {
      this.limitedRow(`source:${source}`, { target: null, data: { endpoint, source } });
      return { ok: false, status: 429 };
    }
    return { ok: false, status: 401 };
  }

  private limitedRow(key: string, row: { target: string | null; data: Record<string, unknown> }): void {
    const now = this.now();
    const last = this.limitedRows.get(key);
    if (last !== undefined && now < last + MINUTE) return;
    this.limitedRows.set(key, now);
    this.company.audit.append({ actorKind: "hq", actorId: "hq", action: "auth.rate-limited", target: row.target, data: row.data });
  }

  private now(): number {
    return this.company.clock.now().getTime();
  }
}

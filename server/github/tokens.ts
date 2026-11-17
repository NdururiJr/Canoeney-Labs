// Each agent's GitHub token (M0-E, ADR 0010, SR-E-04, SR-E-07). An
// installation token of the agent's own App, for one repository, with the
// App's three permissions. It lasts an hour; HQ refreshes it ten minutes before
// it expires while the agent runs, and revokes it explicitly when the agent
// stops, is paused or retired, or HQ stops. Tokens live in memory only: never
// in the store, a log or the audit trail.
import type { Actor } from "../company/agents";
import type { Clock } from "../company/clock";
import type { AuditSink } from "../company/slots/types";
import type { GitHubApi } from "./api";
import { APP_PERMISSIONS } from "./appManifest";
import { InstallationLookupError, type GitHubApps } from "./apps";

/** A token failure in HQ's own words (never sbx's or GitHub's text, which could repeat the token). */
export class TokenError extends Error {}

export type RevokeReason = "stopped" | "paused" | "retired" | "hq-stopped";

const REFRESH_BEFORE_MS = 10 * 60_000;
/** The shortest wait before a refresh, and the wait before its one retry (PR #12 review): a token already inside its window must not make a tight loop. */
const MIN_REFRESH_MS = 60_000;
const HQ: Actor = { kind: "hq", id: "hq" };

interface Held {
  token: string;
  companyId: string;
  repo: string;
  /** When GitHub says this token stops working. */
  expiresAt: number;
  cancel: () => void;
}

type Schedule = (fn: () => void, ms: number) => () => void;

const realSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, Math.max(0, ms));
  t.unref?.();
  return () => clearTimeout(t);
};

/**
 * Pausing or retiring one of this project's agents revokes its token, with the actor who
 * did it (SR-E-07). Returns the unsubscribe.
 */
export function revokeOnStatus(
  agents: { onStatusChange(fn: (companyId: string, to: string, by: Actor) => void): () => void },
  tokens: Pick<AgentTokens, "revoke">,
  slug: string,
): () => void {
  return agents.onStatusChange((cid, to, by) => {
    if ((to === "paused" || to === "retired") && cid.startsWith(`${slug}/`)) void tokens.revoke(cid.slice(slug.length + 1), to, by);
  });
}

/** hh:mm, on the host's own clock face. */
function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export class AgentTokens {
  private readonly held = new Map<string, Held>();
  private readonly schedule: Schedule;

  constructor(
    private readonly o: {
      apps: Pick<GitHubApps, "has" | "installation" | "jwtFor">;
      api: GitHubApi;
      sbx: { setKey(id: string, svc: string, v: string): Promise<void>; removeKey(id: string, svc: string): Promise<void> };
      clock: Clock;
      audit: AuditSink;
      schedule?: Schedule;
      /** One line in the project's activity feed. */
      activity?: (agentId: string, text: string) => void;
      /** The audit target of a revoke for an agent that holds nothing: the agent's company id. */
      companyIdOf?: (agentId: string) => string;
    },
  ) {
    this.schedule = o.schedule ?? realSchedule;
  }

  /** Each agent's deliveries, refreshes and revokes run one at a time, in order (final review, Critical 1). */
  private readonly lanes = new Map<string, Promise<unknown>>();

  private lane<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.lanes.get(agentId) ?? Promise.resolve()).then(fn, fn);
    const settled = next.catch(() => {});
    this.lanes.set(agentId, settled);
    void settled.then(() => {
      if (this.lanes.get(agentId) === settled) this.lanes.delete(agentId);
    });
    return next;
  }

  /**
   * Issues the agent's token and gives it to its own sandbox as its `github` key. An agent
   * with no identity has any `github` key in its sandbox removed: the only GitHub key an
   * agent ever holds is the one HQ gave it (final review, Important 6).
   */
  deliver(agentId: string, companyId: string, repo: string | null): Promise<"issued" | "no-identity"> {
    return this.lane(agentId, () => this.deliverNow(agentId, companyId, repo));
  }

  /**
   * `strict` (a refresh): a lookup GitHub could not answer throws, so the working key stays and
   * the refresh is retried. A first delivery keeps the conservative reading: no installation, no token.
   */
  private async lookup(companyId: string, repo: string, strict: boolean) {
    try {
      return await this.o.apps.installation(companyId, repo);
    } catch (err) {
      if (!(err instanceof InstallationLookupError)) throw err;
      if (strict) throw new TokenError("GitHub did not say whether the App is installed.");
      return null;
    }
  }

  private async deliverNow(agentId: string, companyId: string, repo: string | null, refreshing = false): Promise<"issued" | "no-identity"> {
    // A 404 is an App that is really not installed: no token, and the key goes. An answer HQ could not read is not a 404.
    const inst = repo && this.o.apps.has(companyId) ? await this.lookup(companyId, repo, refreshing) : null;
    if (!repo || !inst) {
      await this.o.sbx.removeKey(agentId, "github").catch(() => {});
      return "no-identity";
    }
    const r = await this.o.api.request<{ token: string; expires_at: string }>("POST", `/app/installations/${inst.id}/access_tokens`, {
      jwt: this.o.apps.jwtFor(companyId),
      body: { repositories: [repo.split("/")[1]], permissions: { ...APP_PERMISSIONS } },
    });
    if (r.status !== 201 || !r.json?.token) throw new TokenError(`GitHub did not issue a token (HTTP ${r.status}).`);
    const token = r.json.token;
    try {
      await this.o.sbx.setKey(agentId, "github", token);
    } catch {
      // Nobody holds it: revoke it now rather than leave it live for an hour.
      await this.revokeToken(token);
      throw new TokenError("sbx did not store the GitHub token for the sandbox.");
    }
    const previous = this.held.get(agentId);
    previous?.cancel();
    const expiresAt = Date.parse(r.json.expires_at);
    const due = expiresAt - this.o.clock.now().getTime() - REFRESH_BEFORE_MS;
    // A date HQ cannot read, or one already past, still waits: never a loop of instant refreshes.
    const cancel = this.schedule(() => void this.refresh(agentId, false), Number.isFinite(due) ? Math.max(MIN_REFRESH_MS, due) : MIN_REFRESH_MS);
    this.held.set(agentId, { token, companyId, repo, expiresAt, cancel });
    if (previous && previous.token !== token) await this.revokeToken(previous.token);
    return "issued";
  }

  /**
   * Revokes the agent's token on GitHub and removes it from its sandbox, after any delivery in
   * flight. An agent HQ holds no token for still has its sandbox's `github` key removed: HQ may
   * have restarted since it gave one (PR #12 review).
   */
  revoke(agentId: string, reason: RevokeReason, by: Actor = HQ): Promise<void> {
    return this.lane(agentId, async () => {
      const h = this.held.get(agentId);
      if (h) {
        this.held.delete(agentId);
        h.cancel();
        await this.revokeToken(h.token);
      }
      await this.o.sbx.removeKey(agentId, "github").catch(() => {
        /* the sandbox may be gone; the token is already revoked */
      });
      this.o.audit.append({
        actorKind: by.kind,
        actorId: by.id,
        action: "github.token-revoked",
        target: h?.companyId ?? this.o.companyIdOf?.(agentId) ?? agentId,
        data: h ? { reason } : { reason, held: false },
      });
    });
  }

  /** Every agent holding a token, or with a delivery in flight. */
  async revokeAll(reason: RevokeReason): Promise<void> {
    const ids = new Set([...this.held.keys(), ...this.lanes.keys()]);
    await Promise.all([...ids].map((id) => this.revoke(id, reason)));
  }

  /** A failed refresh is tried once more after 60 s; if that fails too, the activity feed says when the token stops working. */
  private refresh(agentId: string, retried: boolean): Promise<void> {
    return this.lane(agentId, async () => {
      const h = this.held.get(agentId);
      if (!h) return; // revoked meanwhile
      try {
        await this.deliverNow(agentId, h.companyId, h.repo, true);
      } catch {
        // The old token stays until it expires; the next start issues a new one.
        if (!retried) h.cancel = this.schedule(() => void this.refresh(agentId, true), MIN_REFRESH_MS);
        else this.o.activity?.(agentId, `${agentId}'s GitHub token could not be refreshed; it stops working at ${clockTime(h.expiresAt)}.`);
      }
    });
  }

  private async revokeToken(token: string): Promise<void> {
    try {
      await this.o.api.request("DELETE", "/installation/token", { token });
    } catch {
      /* an hour-long token that could not be revoked expires on its own */
    }
  }
}

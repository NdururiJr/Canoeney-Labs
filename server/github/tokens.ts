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
import type { GitHubApps } from "./apps";

export type RevokeReason = "stopped" | "paused" | "retired" | "hq-stopped";

const REFRESH_BEFORE_MS = 10 * 60_000;
const HQ: Actor = { kind: "hq", id: "hq" };

interface Held {
  token: string;
  companyId: string;
  repo: string;
  cancel: () => void;
}

type Schedule = (fn: () => void, ms: number) => () => void;

const realSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, Math.max(0, ms));
  t.unref?.();
  return () => clearTimeout(t);
};

export class AgentTokens {
  private readonly held = new Map<string, Held>();
  /** Bumped by each revoke, so a refresh already in flight issues nothing after it. */
  private readonly generation = new Map<string, number>();
  private readonly schedule: Schedule;

  constructor(
    private readonly o: {
      apps: Pick<GitHubApps, "has" | "installation" | "jwtFor">;
      api: GitHubApi;
      sbx: { setKey(id: string, svc: string, v: string): Promise<void>; removeKey(id: string, svc: string): Promise<void> };
      clock: Clock;
      audit: AuditSink;
      schedule?: Schedule;
    },
  ) {
    this.schedule = o.schedule ?? realSchedule;
  }

  /** Issues the agent's token and gives it to its own sandbox as its `github` key. */
  async deliver(agentId: string, companyId: string, repo: string | null): Promise<"issued" | "no-identity"> {
    if (!repo || !this.o.apps.has(companyId)) return "no-identity";
    const gen = this.generation.get(agentId) ?? 0;
    const inst = await this.o.apps.installation(companyId, repo);
    if (!inst) return "no-identity";
    const name = repo.split("/")[1];
    const r = await this.o.api.request<{ token: string; expires_at: string }>("POST", `/app/installations/${inst.id}/access_tokens`, {
      jwt: this.o.apps.jwtFor(companyId),
      body: { repositories: [name], permissions: { ...APP_PERMISSIONS } },
    });
    if (r.status !== 201 || !r.json?.token) throw new Error(`GitHub did not issue a token (HTTP ${r.status}).`);
    // A revoke that came while this was in flight wins: the new token is revoked at once.
    if ((this.generation.get(agentId) ?? 0) !== gen) {
      await this.revokeToken(r.json.token);
      return "issued";
    }
    await this.o.sbx.setKey(agentId, "github", r.json.token);
    const previous = this.held.get(agentId);
    previous?.cancel();
    const ms = Date.parse(r.json.expires_at) - this.o.clock.now().getTime() - REFRESH_BEFORE_MS;
    const cancel = this.schedule(() => void this.refresh(agentId), ms);
    this.held.set(agentId, { token: r.json.token, companyId, repo, cancel });
    if (previous && previous.token !== r.json.token) await this.revokeToken(previous.token);
    return "issued";
  }

  /** Revokes the agent's token on GitHub and removes it from its sandbox. Nothing to do when it holds none. */
  async revoke(agentId: string, reason: RevokeReason, by: Actor = HQ): Promise<void> {
    this.generation.set(agentId, (this.generation.get(agentId) ?? 0) + 1);
    const h = this.held.get(agentId);
    if (!h) return;
    this.held.delete(agentId);
    h.cancel();
    await this.revokeToken(h.token);
    try {
      await this.o.sbx.removeKey(agentId, "github");
    } catch {
      /* the sandbox may be gone; the token is already revoked */
    }
    this.o.audit.append({ actorKind: by.kind, actorId: by.id, action: "github.token-revoked", target: h.companyId, data: { reason } });
  }

  async revokeAll(reason: RevokeReason): Promise<void> {
    await Promise.all([...this.held.keys()].map((id) => this.revoke(id, reason)));
  }

  private async refresh(agentId: string): Promise<void> {
    const h = this.held.get(agentId);
    if (!h) return;
    try {
      await this.deliver(agentId, h.companyId, h.repo);
    } catch {
      /* the old token stays until it expires; the next start issues a new one */
    }
  }

  private async revokeToken(token: string): Promise<void> {
    try {
      await this.o.api.request("DELETE", "/installation/token", { token });
    } catch {
      /* an hour-long token that could not be revoked expires on its own */
    }
  }
}

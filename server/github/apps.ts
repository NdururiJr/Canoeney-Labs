// One GitHub App per agent (M0-E, docs/adr/0010-github-app-per-agent.md).
//
// The owner starts it from the dashboard with the PIN: HQ hands the browser a
// manifest and a one-time state, the browser posts the manifest to GitHub, and
// GitHub creates the App and sends the browser back to the dashboard with a
// code. The dashboard passes the code and the state back over the owner's own
// session; HQ converts the code, seals the App's private key with the owner
// key, and sends the owner on to install the App on the project's repo only.
import { createSign, randomBytes } from "node:crypto";
import type { Clock } from "../company/clock";
import type { CompanyDb } from "../company/db";
import { open, seal } from "../company/sealed";
import type { AuditSink } from "../company/slots/types";
import type { GitHubApi } from "./api";
import { manifestFor } from "./appManifest";

const STATE_TTL_MS = 10 * 60_000;

export type AppRefusal = "unknown-state" | "used" | "expired" | "other-session";

export class GitHubAppRefusedError extends Error {
  constructor(readonly reason: AppRefusal) {
    super("That GitHub App setup link is not valid any more. Start again from Settings → Team.");
    this.name = "GitHubAppRefusedError";
  }
}

/** GitHub's answer to "is this App installed here?" was neither yes (200) nor no (404). */
export class InstallationLookupError extends Error {
  constructor(readonly status: number) {
    super(`GitHub did not say whether the App is installed (${status ? `HTTP ${status}` : "no answer"}).`);
    this.name = "InstallationLookupError";
  }
}

interface Pending {
  companyAgentId: string;
  humanId: string;
  sessionId: string;
  at: number;
  used: boolean;
}

interface Row {
  agent_id: string;
  app_id: number;
  slug: string;
  bot_user_id: number;
  key_sealed: string;
  installation_id: number | null;
}

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export class GitHubApps {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly o: { db: CompanyDb; audit: AuditSink; clock: Clock; keyFile: string; api: GitHubApi },
  ) {}

  /** The manifest to post to GitHub, and the one-time state bound to this owner session. */
  start(companyAgentId: string, repo: string, humanId: string, sessionId: string, origin: string): { url: string; manifest: Record<string, unknown>; state: string } {
    const [project, agentId] = companyAgentId.split("/");
    const state = randomBytes(24).toString("base64url");
    // A state nobody came back with is dropped once it is older than its lifetime (PR #12 review).
    for (const [k, p] of this.pending) if (this.now() - p.at > STATE_TTL_MS) this.pending.delete(k);
    this.pending.set(state, { companyAgentId, humanId, sessionId, at: this.now(), used: false });
    const manifest = manifestFor({ project, agentId, repo, origin, rand: randomBytes(2).toString("hex") });
    return { url: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`, manifest, state };
  }

  /** Turns GitHub's code into the App; refused unless `state` is open, unused, recent and this session's. */
  async complete(state: string, code: string, humanId: string, sessionId: string): Promise<{ installUrl: string }> {
    const p = this.pending.get(state);
    const reason: AppRefusal | null = !p ? "unknown-state" : p.used ? "used" : this.now() - p.at > STATE_TTL_MS ? "expired" : p.sessionId !== sessionId || p.humanId !== humanId ? "other-session" : null;
    if (reason || !p) {
      this.o.audit.append({ actorKind: "human", actorId: humanId, action: "github.app-refused", target: p?.companyAgentId ?? null, data: { reason } });
      throw new GitHubAppRefusedError(reason ?? "unknown-state");
    }
    p.used = true;
    const conv = await this.o.api.request<{ id: number; slug: string; pem: string }>("POST", `/app-manifests/${encodeURIComponent(code)}/conversions`);
    if (conv.status !== 201 || !conv.json?.pem) throw new Error(`GitHub did not create the App (HTTP ${conv.status}).`);
    const { id, slug, pem } = conv.json;
    const bot = await this.o.api.request<{ id: number }>("GET", `/users/${encodeURIComponent(`${slug}[bot]`)}`);
    const botUserId = bot.json?.id;
    if (bot.status !== 200 || typeof botUserId !== "number") throw new Error(`GitHub did not report the App's bot user (HTTP ${bot.status}).`);
    const sealed = seal(this.o.keyFile, Buffer.from(pem));
    this.o.db.transaction(() => {
      this.o.db
        .prepare(
          `INSERT INTO agent_github_apps(agent_id, app_id, slug, bot_user_id, key_sealed, installation_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT(agent_id) DO UPDATE SET app_id = excluded.app_id, slug = excluded.slug, bot_user_id = excluded.bot_user_id, key_sealed = excluded.key_sealed, installation_id = NULL, created_at = excluded.created_at`,
        )
        .run(p.companyAgentId, id, slug, botUserId, sealed, this.iso());
      this.o.audit.append({ actorKind: "human", actorId: humanId, action: "github.app-created", target: p.companyAgentId, data: { app: slug, appId: id } });
    }, "immediate");
    return { installUrl: `https://github.com/apps/${slug}/installations/new` };
  }

  has(companyAgentId: string): boolean {
    return !!this.row(companyAgentId);
  }

  /** The App's numeric id (a ruleset's bypass actor). */
  appId(companyAgentId: string): number | null {
    return this.row(companyAgentId)?.app_id ?? null;
  }

  /** The App's slug, for the dashboard. */
  slug(companyAgentId: string): string | null {
    return this.row(companyAgentId)?.slug ?? null;
  }

  /** A JWT for the App: RS256, issued a minute back (clock skew), valid 9 minutes. */
  jwtFor(companyAgentId: string): string {
    const row = this.row(companyAgentId);
    if (!row) throw new Error(`${companyAgentId} has no GitHub App.`);
    const pem = open(this.o.keyFile, row.key_sealed);
    if (!pem) throw new Error(`The GitHub App key of ${companyAgentId} does not open with this owner key.`);
    const now = Math.floor(this.now() / 1000);
    const head = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iat: now - 60, exp: now + 540, iss: String(row.app_id) })}`;
    return `${head}.${createSign("RSA-SHA256").update(head).sign(pem.toString()).toString("base64url")}`;
  }

  /**
   * The App's installation on `repo` (owner/name), or null when GitHub says there is none
   * (404). Any other answer, or none, throws InstallationLookupError: "could not tell" is
   * never "not installed" (SR-F-08). Recorded once.
   */
  async installation(companyAgentId: string, repo: string): Promise<{ id: number; selection: "selected" | "all" } | null> {
    const r = await this.o.api.request<{ id: number; repository_selection: "selected" | "all" }>("GET", `/repos/${repo}/installation`, { jwt: this.jwtFor(companyAgentId) });
    if (r.status === 404) return null;
    if (r.status !== 200 || !r.json) throw new InstallationLookupError(r.status);
    const { id, repository_selection } = r.json;
    const row = this.row(companyAgentId)!;
    if (row.installation_id !== id) {
      this.o.db.prepare("UPDATE agent_github_apps SET installation_id = ? WHERE agent_id = ?").run(id, companyAgentId);
      this.o.audit.append({ actorKind: "hq", actorId: "hq", action: "github.app-installed", target: companyAgentId, data: { app: row.slug, repo, selection: repository_selection } });
    }
    return { id, selection: repository_selection };
  }

  /** The company agent whose App's bot user this is (PR attribution, SR-E-12). */
  agentForBot(botUserId: number): string | null {
    return this.o.db.prepare("SELECT agent_id FROM agent_github_apps WHERE bot_user_id = ?").get<{ agent_id: string }>(botUserId)?.agent_id ?? null;
  }

  private row(companyAgentId: string): Row | undefined {
    return this.o.db.prepare("SELECT * FROM agent_github_apps WHERE agent_id = ?").get<Row>(companyAgentId);
  }

  private now(): number {
    return this.o.clock.now().getTime();
  }

  private iso(): string {
    return this.o.clock.now().toISOString();
  }
}

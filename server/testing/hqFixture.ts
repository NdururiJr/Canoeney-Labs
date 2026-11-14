// A whole HQ for tests: a temporary repo folder and company home (both with a
// space in the name), a registered team (lead as cto, ana and ben as builders)
// and the HTTP server on a free port. Everything is closed when the test ends.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { AgentConfig, Board, HqConfig, Task } from "../../src/data/types";
import type { Authority } from "../company/authority";
import { WebSocket } from "ws";
import { AgentAuth, type AuthLimits } from "../agentAuth";
import type { HumanToEnroll } from "../company/humanAccounts";
import { stepOf, totpAt } from "../company/totp";
import { Dashboard, type CommandSpec } from "../dashboard";
import { OwnerAuth, SESSION_COOKIE, type OwnerAuthLimits } from "../ownerAuth";
import { FakeClock } from "../company/clock";
import { companyAgentId } from "../company/agents";
import { openCompany, type Company } from "../company";
import { startHttp } from "../http";
import { Hub } from "../hub";
import { Inbox } from "../inbox";
import { Planner } from "../planner";
import { offerImport } from "../repoConfigImport";
import type { RepoInfo } from "../repo";
import { defaultWorkflow, newAgent } from "../store";

export const FIXTURE_START = "2026-11-12T08:00:00.000Z";
/** The dashboard origin the fixture allows. */
export const ORIGIN = "http://hq.test";
export const OWNER_PASSWORD = "owner password 1";
export const OWNER_PIN = "583920";
export const SUPERVISOR = { id: "sup1", displayName: "Sam", role: "supervisor" as const, password: "supervisor password", pin: "246810" };

/** The authority fixtures seed a project with: an approved decision, so no human has to exist yet. */
export const SEED_AUTHORITY: Authority = { via: "decision", decisionId: "fixture-seed" };

/** Writes a team, its settings and grants into the store, as completing the welcome or an import would. */
export function seedProject(company: Company, slug: string, team: AgentConfig[], workflow: HqConfig["workflow"]): void {
  company.db
    .prepare(
      `INSERT OR IGNORE INTO decisions(id, requester_kind, requester_id, summary, urgency, status, reply_code, dedupe_key, idempotency_key, created_at)
       VALUES ('fixture-seed', 'hq', 'hq', 'test fixture seed', 'normal', 'approved', 'fixture-seed', 'fixture-seed', 'fixture-seed', ?)`,
    )
    .run(FIXTURE_START);
  const by = SEED_AUTHORITY;
  if (!company.settings.has(slug)) company.settings.create(slug, { github: null, workflow }, by);
  const ordered = [...team.filter((a) => a.isLead), ...team.filter((a) => !a.isLead)];
  for (const a of ordered) {
    const companyId = companyAgentId(slug, a.id);
    company.settings.addAgent(slug, { id: a.id, name: a.name, cli: a.cli, displayRole: a.role, color: a.color, mode: a.mode, model: a.model }, a.isLead && a === ordered[0] ? "cto" : "builder", by);
    company.settings.updateAgent(companyId, { roleMd: a.roleMd, workspacePath: a.workspacePath, resources: a.sandbox.resources }, by);
    company.settings.setGrants(companyId, "network-allow", a.sandbox.allow, by);
    company.settings.setGrants(companyId, "network-deny", a.sandbox.deny, by);
    company.settings.setGrants(companyId, "mcp-server", a.mcp ?? [], by);
    company.settings.setGrants(companyId, "skill", a.skills, by);
  }
}

/** Writes the repo's old .jsmhq/config.json and plan.json, as a repo from before M0-D1 (or a PR) carries them. */
export function writeRepoFiles(repoRoot: string, files: { config?: unknown; plan?: { boards: Board[]; tasks: Task[] } }): void {
  mkdirSync(join(repoRoot, ".jsmhq"), { recursive: true });
  if (files.config !== undefined) writeFileSync(join(repoRoot, ".jsmhq", "config.json"), JSON.stringify(files.config, null, 2));
  if (files.plan !== undefined) writeFileSync(join(repoRoot, ".jsmhq", "plan.json"), JSON.stringify(files.plan, null, 2));
}

export interface LoginResult {
  status: number;
  /** The `name=value` pair to send back in a Cookie header, when one was set. */
  cookie: string | null;
  setCookie: string | null;
  body: Record<string, unknown> | null;
}

export interface Hq {
  company: Company;
  clock: FakeClock;
  hub: Hub;
  inbox: Inbox;
  planner: Planner;
  auth: AgentAuth;
  readonly ownerAuth: OwnerAuth;
  readonly dashboard: Dashboard;
  /** The setup file HQ writes while no owner is enrolled. */
  setupFile: string;
  slug: string;
  repoRoot: string;
  /** The fixture's company home (HQ_COMPANY_HOME while the test runs). */
  companyHomeDir: string;
  /** Where temporary folders for this test may go; removed with the fixture. */
  scratch: string;
  readonly url: string;
  /** Enrolls a human (the owner by default) straight in the store; returns the TOTP seed. Once per human. */
  enroll(human?: HumanToEnroll & { password: string; pin: string }): Promise<Buffer>;
  /** The code for the next unused TOTP step of a human (the clock moves 30 s). */
  nextCode(humanId?: string): string;
  /** POST /auth/login. Enrolls the owner or the supervisor first if needed. */
  login(o?: { account?: string; password?: string; code?: string; headers?: Record<string, string> }): Promise<LoginResult>;
  /** A logged-in session cookie for the owner or the supervisor. */
  sessionCookie(who?: "owner" | "supervisor", headers?: Record<string, string>): Promise<string>;
  /** Closes the HTTP server and starts a new one on the same store, as an HQ restart does (sessions are lost). */
  restart(): Promise<void>;
  /** The agent's current secret, issued on first use. */
  secretFor(agentId: string): string;
  /** Issues a new secret for the agent (the old one is revoked). */
  rotate(agentId: string): string;
}

export async function makeHq(
  t: TestContext,
  opts: {
    team?: AgentConfig[];
    limits?: Partial<AuthLimits>;
    ownerLimits?: Partial<OwnerAuthLimits>;
    /** Leave the store without settings, as a fresh repo or an install from before M0-D1. */
    unseeded?: boolean;
    /** A built UI folder to serve (default: none). */
    distDir?: string;
    /** Builds the dashboard command table (default: none). */
    commands?: (p: { hub: Hub; planner: Planner; inbox: Inbox; company: Company }) => Record<string, CommandSpec>;
  } = {},
): Promise<Hq> {
  const dir = mkdtempSync(join(tmpdir(), "hq fixture "));
  const repoRoot = join(dir, "repo dir");
  mkdirSync(repoRoot);
  const repo: RepoInfo = { root: repoRoot, name: "fixture repo", originUrl: null, github: null, remotes: [], hasCodeRabbit: false, hasInsta: false };
  const team = opts.team ?? [
    newAgent("lead", "Lead", "Lead", "#ff77a8", true),
    newAgent("ana", "Ana", "Developer", "#29adff", false),
    newAgent("ben", "Ben", "Developer", "#00e436", false),
  ];
  const clock = new FakeClock(FIXTURE_START);
  const companyHomeDir = join(dir, "company home");
  // Code that asks for the company home (workspaceFor) gets this one, never the real ~/.jsmhq/_company.
  const previousHome = process.env.HQ_COMPANY_HOME;
  process.env.HQ_COMPANY_HOME = companyHomeDir;
  // HQ's own home (agents' clones, per-project records) too: tests never touch the real ~/.jsmhq.
  const previousHqHome = process.env.HQ_HOME;
  process.env.HQ_HOME = join(dir, "hq home");
  const company = openCompany({ home: companyHomeDir, repoRoot, clock });
  // The owner's row exists from the start (enrollment adds the credentials later), so commands run directly act as a real owner.
  company.db.prepare("INSERT INTO humans(id, display_name, role, created_at) VALUES ('owner', 'Owner', 'owner', ?)").run(FIXTURE_START);
  const slug = company.agents.ensureProject({ name: repo.name, root: repoRoot, github: repo.github });
  if (!opts.unseeded) seedProject(company, slug, team, defaultWorkflow(repo));

  const configSource = () => company.settings.view(slug, { path: repoRoot, hqPort: 0 });
  const hub = new Hub(repo, slug, configSource, company.plans.load(slug), { checks: [], checkedAt: FIXTURE_START } as never);
  offerImport(hub, company);
  const inbox = new Inbox(hub, { type: async () => false, enter: async () => false });
  const planner = new Planner(hub, inbox, () => company.agents.cto(slug, (id) => !!hub.cfg(id))?.agentId ?? null, {
    plans: company.plans,
    projectId: slug,
    roleOf: (id) => company.agents.get(slug, id)?.role ?? null,
  });
  const auth = new AgentAuth({ projectSlug: slug, company, hub, limits: opts.limits });
  const setupFile = join(companyHomeDir, "owner-setup.txt");
  const newOwnerAuth = () =>
    new OwnerAuth({ accounts: company.humans, clock, audit: company.audit, allowedOrigins: [ORIGIN], setupFile, limits: opts.ownerLimits });
  let ownerAuth = newOwnerAuth();
  ownerAuth.prepareSetup();
  const commands = opts.commands?.({ hub, planner, inbox, company }) ?? {};
  let dashboard: Dashboard;
  const start = (oa: OwnerAuth) =>
    startHttp({
      dashboard: (dashboard = new Dashboard(commands, { ownerAuth: oa, audit: company.audit, clock })),
      hub,
      inbox,
      planner,
      company,
      agentAuth: auth,
      ownerAuth: oa,
      port: 0,
      distDir: opts.distDir ?? null,
      allowedOrigins: [ORIGIN],
    });
  let server = await start(ownerAuth);
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  t.after(async () => {
    inbox.stop();
    await stop();
    company.close();
    if (previousHome === undefined) delete process.env.HQ_COMPANY_HOME;
    else process.env.HQ_COMPANY_HOME = previousHome;
    if (previousHqHome === undefined) delete process.env.HQ_HOME;
    else process.env.HQ_HOME = previousHqHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const secrets = new Map<string, string>();
  const rotate = (agentId: string) => {
    const s = company.secrets.issue(companyAgentId(slug, agentId));
    secrets.set(agentId, s);
    return s;
  };
  const seeds = new Map<string, Buffer>();
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const enroll: Hq["enroll"] = async (human = { id: "owner", displayName: "Owner", role: "owner", password: OWNER_PASSWORD, pin: OWNER_PIN }) => {
    const known = seeds.get(human.id);
    if (known) return known;
    const { seed } = await company.humans.startEnrollment(human, human.password, human.pin);
    if (!(await company.humans.confirmEnrollment(human.id, totpAt(seed, stepOf(clock.now()))))) throw new Error("fixture enrollment failed");
    seeds.set(human.id, seed);
    if (human.role === "owner") ownerAuth.prepareSetup();
    return seed;
  };
  const nextCode: Hq["nextCode"] = (humanId = "owner") => {
    const seed = seeds.get(humanId);
    if (!seed) throw new Error(`${humanId} is not enrolled`);
    clock.advance(30_000);
    return totpAt(seed, stepOf(clock.now()));
  };
  const login: Hq["login"] = async (o = {}) => {
    const account = o.account ?? "owner";
    if (account === "owner") await enroll();
    if (account === SUPERVISOR.id) await enroll(SUPERVISOR);
    const password = o.password ?? (account === SUPERVISOR.id ? SUPERVISOR.password : OWNER_PASSWORD);
    const code = o.code ?? (seeds.has(account) ? nextCode(account) : "000000");
    const res = await fetch(`${url()}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...o.headers },
      body: JSON.stringify({ account, password, code }),
    });
    const setCookie = res.headers.get("set-cookie");
    const m = setCookie ? new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie) : null;
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return { status: res.status, cookie: m && m[1] ? `${SESSION_COOKIE}=${m[1]}` : null, setCookie, body };
  };
  const sessionCookie: Hq["sessionCookie"] = async (who = "owner", headers) => {
    const r = await login({ account: who === "owner" ? "owner" : SUPERVISOR.id, headers });
    if (!r.cookie) throw new Error(`login failed: ${r.status}`);
    return r.cookie;
  };
  return {
    company,
    clock,
    hub,
    inbox,
    planner,
    auth,
    get ownerAuth() {
      return ownerAuth;
    },
    get dashboard() {
      return dashboard;
    },
    setupFile,
    slug,
    repoRoot,
    companyHomeDir,
    scratch: dir,
    get url() {
      return url();
    },
    secretFor: (agentId) => secrets.get(agentId) ?? rotate(agentId),
    rotate,
    enroll,
    nextCode,
    login,
    sessionCookie,
    restart: async () => {
      await stop();
      ownerAuth = newOwnerAuth();
      server = await start(ownerAuth);
    },
  };
}

/** One MCP `tools/call` over HTTP. Returns the HTTP status, the raw body and, when it parsed, the JSON-RPC message. */
export async function mcpCall(
  hq: Hq,
  secret: string | null,
  tool: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; json: { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } } | null }> {
  return mcpRequest(hq, secret, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }, headers);
}

export async function mcpRequest(hq: Hq, secret: string | null, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${hq.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json };
}

export async function hook(hq: Hq, secret: string | null, agentId: string, event: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const res = await fetch(`${hq.url}/hook/${agentId}/${event}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

/**
 * Opens a dashboard WebSocket. Resolves with 101 and the socket, or with the
 * refusal status. Frames are collected from the start: HQ sends its snapshot
 * right after the upgrade, sometimes in the same chunk as the 101.
 */
export function openWs(
  hq: Hq,
  headers: Record<string, string> = {},
  path = "/ws",
): Promise<{ status: number; ws: WebSocket | null; frames: Record<string, unknown>[] }> {
  return new Promise((resolve) => {
    const frames: Record<string, unknown>[] = [];
    const ws = new WebSocket(hq.url.replace("http", "ws") + path, { headers });
    ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
    ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode ?? 0, ws: null, frames }));
    ws.on("open", () => resolve({ status: 101, ws, frames }));
    ws.on("error", () => resolve({ status: -1, ws: null, frames }));
  });
}

/** The status of a WebSocket upgrade; a socket that opened is closed again. */
export async function wsStatus(hq: Hq, headers: Record<string, string> = {}, path = "/ws"): Promise<number> {
  const r = await openWs(hq, headers, path);
  r.ws?.close();
  return r.status;
}

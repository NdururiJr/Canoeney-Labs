// A whole HQ for tests: a temporary repo folder and company home (both with a
// space in the name), a registered team (lead as cto, ana and ben as builders)
// and the HTTP server on a free port. Everything is closed when the test ends.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { AgentConfig } from "../../src/data/types";
import { AgentAuth, type AuthLimits } from "../agentAuth";
import { FakeClock } from "../company/clock";
import { companyAgentId } from "../company/agents";
import { openCompany, type Company } from "../company";
import { startHttp } from "../http";
import { Hub } from "../hub";
import { Inbox } from "../inbox";
import { Planner } from "../planner";
import type { RepoInfo } from "../repo";
import { loadConfig, loadPlan, newAgent } from "../store";

export const FIXTURE_START = "2026-11-12T08:00:00.000Z";

export interface Hq {
  company: Company;
  clock: FakeClock;
  hub: Hub;
  inbox: Inbox;
  planner: Planner;
  auth: AgentAuth;
  slug: string;
  repoRoot: string;
  /** The fixture's company home (HQ_COMPANY_HOME while the test runs). */
  companyHomeDir: string;
  /** Where temporary folders for this test may go; removed with the fixture. */
  scratch: string;
  url: string;
  /** The agent's current secret, issued on first use. */
  secretFor(agentId: string): string;
  /** Issues a new secret for the agent (the old one is revoked). */
  rotate(agentId: string): string;
}

export async function makeHq(t: TestContext, opts: { team?: AgentConfig[]; limits?: Partial<AuthLimits> } = {}): Promise<Hq> {
  const dir = mkdtempSync(join(tmpdir(), "hq fixture "));
  const repoRoot = join(dir, "repo dir");
  mkdirSync(repoRoot);
  const repo: RepoInfo = { root: repoRoot, name: "fixture repo", originUrl: null, github: null, hasCodeRabbit: false, hasInsta: false };
  const { config } = loadConfig(repo, 0);
  config.team = opts.team ?? [
    newAgent("lead", "Lead", "Lead", "#ff77a8", true),
    newAgent("ana", "Ana", "Developer", "#29adff", false),
    newAgent("ben", "Ben", "Developer", "#00e436", false),
  ];
  const slug = config.project.id;
  const clock = new FakeClock(FIXTURE_START);
  const companyHomeDir = join(dir, "company home");
  // Code that asks for the company home (workspaceFor) gets this one, never the real ~/.jsmhq/_company.
  const previousHome = process.env.HQ_COMPANY_HOME;
  process.env.HQ_COMPANY_HOME = companyHomeDir;
  const company = openCompany({ home: companyHomeDir, repoRoot, clock });
  company.agents.ensureProject({ slug, name: config.project.name, root: repoRoot });
  company.agents.syncFromConfig(slug, config.team);

  const hub = new Hub(repo, slug, config, loadPlan(repoRoot), { checks: [], checkedAt: FIXTURE_START } as never);
  const inbox = new Inbox(hub, { type: async () => false, enter: async () => false });
  const planner = new Planner(hub, inbox, () => company.agents.cto(slug)?.agentId ?? null);
  const auth = new AgentAuth({ projectSlug: slug, company, hub, limits: opts.limits });
  const server = await startHttp({
    hub,
    inbox,
    planner,
    company,
    agentAuth: auth,
    port: 0,
    browserToken: "browser-token",
    distDir: null,
    allowedOrigins: [],
    commands: {},
  });
  t.after(async () => {
    inbox.stop();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    company.close();
    if (previousHome === undefined) delete process.env.HQ_COMPANY_HOME;
    else process.env.HQ_COMPANY_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const secrets = new Map<string, string>();
  const rotate = (agentId: string) => {
    const s = company.secrets.issue(companyAgentId(slug, agentId));
    secrets.set(agentId, s);
    return s;
  };
  return {
    company,
    clock,
    hub,
    inbox,
    planner,
    auth,
    slug,
    repoRoot,
    companyHomeDir,
    scratch: dir,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    secretFor: (agentId) => secrets.get(agentId) ?? rotate(agentId),
    rotate,
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

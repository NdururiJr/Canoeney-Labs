import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openCompany } from "../company";
import { FakeClock } from "../company/clock";
import { makeCommands } from "../commands";
import type { CommandCtx } from "../dashboard";
import { makeHq, OWNER_PIN } from "../testing/hqFixture";
import type { GitHubApi } from "./api";
import { GitHubAppRefusedError, GitHubApps } from "./apps";
import { APP_PERMISSIONS, manifestFor } from "./appManifest";

const NOW = "2026-11-14T10:00:00.000Z";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

/** A fake GitHub: records calls, answers the manifest conversion, the bot user and the installation. */
function fakeGitHub(o: { selection?: "selected" | "all"; installed?: boolean } = {}) {
  const calls: { method: string; path: string; jwt?: string; token?: string }[] = [];
  const api: GitHubApi = {
    async request(method, path, opts = {}) {
      calls.push({ method, path, jwt: opts.jwt, token: opts.token });
      if (method === "POST" && /^\/app-manifests\/[^/]+\/conversions$/.test(path)) return { status: 201, json: { id: 4242, slug: "hq-site-ana-1a2b", pem: PEM } as never };
      if (method === "GET" && path === `/users/${encodeURIComponent("hq-site-ana-1a2b[bot]")}`) return { status: 200, json: { id: 991 } as never };
      if (method === "GET" && path === "/repos/acme/site/installation")
        return o.installed === false ? { status: 404, json: null } : { status: 200, json: { id: 77, repository_selection: o.selection ?? "selected" } as never };
      return { status: 404, json: null };
    },
  };
  return { api, calls };
}

function store(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "hq apps "));
  const clock = new FakeClock(NOW);
  const company = openCompany({ home, repoRoot: null, clock });
  t.after(() => {
    company.close();
    rmSync(home, { recursive: true, force: true });
  });
  company.agents.ensureProject({ slug: "site", name: "site", root: join(home, "no repo"), github: "acme/site" });
  company.agents.register("site", { id: "ana", name: "Ana", cli: "claude" }, "builder", { kind: "hq", id: "hq" }, "import");
  company.db.prepare("INSERT INTO humans(id, display_name, role, created_at) VALUES ('owner', 'Owner', 'owner', ?)").run(NOW);
  return { company, clock, home };
}

function apps(t: TestContext, gh = fakeGitHub()) {
  const s = store(t);
  const a = new GitHubApps({ db: s.company.db, audit: s.company.audit, clock: s.clock, keyFile: join(s.home, "owner.key"), api: gh.api });
  return { ...s, a, gh };
}

test("SR-E-02 [T-S3.10] the manifest asks for contents, pull requests and metadata only", () => {
  const m = manifestFor({ project: "a-very-long-project-name", agentId: "an-even-longer-agent-id", repo: "acme/site", origin: "http://127.0.0.1:7420", rand: "1a2b" }) as Record<string, unknown>;
  // The list in ADR 0010: nothing that administers, merges by workflow, or reads secrets.
  assert.deepEqual(m.default_permissions, { contents: "write", pull_requests: "write", metadata: "read" });
  assert.deepEqual(APP_PERMISSIONS, { contents: "write", pull_requests: "write", metadata: "read" });
  assert.deepEqual(m.default_events, []);
  assert.equal(m.public, false);
  assert.deepEqual(m.hook_attributes, { active: false });
  assert.equal(m.redirect_url, "http://127.0.0.1:7420/github-app");
  assert.equal(m.url, "https://github.com/acme/site");
  assert.ok(String(m.name).length <= 34, String(m.name));
  assert.match(String(m.name), /^hq-.*-1a2b$/);
});

test("the app-created callback is refused without a matching one-time state", async (t) => {
  const { a, company, clock, gh } = apps(t);
  const refuse = async (state: string, session: string, reason: string) => {
    await assert.rejects(a.complete(state, "code1", "owner", session), (err: unknown) => err instanceof GitHubAppRefusedError && err.reason === reason, reason);
  };
  await refuse("no-such-state", "s1", "unknown-state");
  const other = a.start("site/ana", "acme/site", "owner", "s1", "http://127.0.0.1:7420");
  await refuse(other.state, "s2", "other-session");
  const old = a.start("site/ana", "acme/site", "owner", "s1", "http://127.0.0.1:7420");
  clock.advance(10 * 60_000 + 1);
  await refuse(old.state, "s1", "expired");
  const ok = a.start("site/ana", "acme/site", "owner", "s1", "http://127.0.0.1:7420");
  await a.complete(ok.state, "code1", "owner", "s1");
  await refuse(ok.state, "s1", "used");
  const rows = company.audit.query({ action: "github.app-refused" });
  assert.deepEqual(rows.map((r) => [r.actorId, r.data.reason]), [
    ["owner", "unknown-state"],
    ["owner", "other-session"],
    ["owner", "expired"],
    ["owner", "used"],
  ]);
  assert.equal(company.db.prepare("SELECT count(*) AS n FROM agent_github_apps").get<{ n: number }>()?.n, 1, "only the matching completion wrote a row");
  assert.equal(gh.calls.filter((c) => c.path.includes("conversions")).length, 1);
});

test("a created App's private key is stored sealed and never in clear", async (t) => {
  const { a, company } = apps(t);
  const s = a.start("site/ana", "acme/site", "owner", "s1", "http://127.0.0.1:7420");
  const { installUrl } = await a.complete(s.state, "code1", "owner", "s1");
  assert.equal(installUrl, "https://github.com/apps/hq-site-ana-1a2b/installations/new");
  const row = company.db.prepare("SELECT * FROM agent_github_apps").get<Record<string, unknown>>()!;
  assert.equal(row.agent_id, "site/ana");
  assert.equal(row.app_id, 4242);
  assert.equal(row.bot_user_id, 991);
  assert.equal(String(row.key_sealed).includes("BEGIN"), false);
  assert.equal(JSON.stringify(company.audit.query({})).includes("BEGIN"), false, "no key in the audit trail");
  assert.equal(company.audit.query({ action: "github.app-created" }).length, 1);
  // The JWT is signed with that key.
  const jwt = a.jwtFor("site/ana");
  const [h, p, sig] = jwt.split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url")));
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  const now = Date.parse(NOW) / 1000;
  assert.deepEqual([claims.iss, claims.iat, claims.exp], ["4242", now - 60, now + 540]);
  assert.equal(a.agentForBot(991), "site/ana");
  assert.equal(a.agentForBot(992), null);
});

test("an App installed on all repositories is reported", async (t) => {
  const { a } = apps(t, fakeGitHub({ selection: "all" }));
  const s = a.start("site/ana", "acme/site", "owner", "s1", "http://127.0.0.1:7420");
  await a.complete(s.state, "code1", "owner", "s1");
  assert.deepEqual(await a.installation("site/ana", "acme/site"), { id: 77, selection: "all" });
});

test("an installation is recorded once", async (t) => {
  const { a, company } = apps(t);
  const s = a.start("site/ana", "acme/site", "owner", "s1", "http://127.0.0.1:7420");
  await a.complete(s.state, "code1", "owner", "s1");
  assert.deepEqual(await a.installation("site/ana", "acme/site"), { id: 77, selection: "selected" });
  await a.installation("site/ana", "acme/site");
  assert.equal(company.audit.query({ action: "github.app-installed" }).length, 1);
  assert.equal(company.db.prepare("SELECT installation_id FROM agent_github_apps").get<{ installation_id: number }>()?.installation_id, 77);
});

test("creating a GitHub identity needs the owner's PIN and a local session", async (t) => {
  const stub = new Proxy({} as Record<string, unknown>, { get: () => async () => {} }) as never;
  const hq = await makeHq(t, { commands: ({ hub, planner, inbox, company }) => makeCommands(hub, stub, planner, inbox, stub, stub, company) });
  await hq.enroll();
  const base: CommandCtx = { actor: { kind: "human", id: "owner" }, role: "owner", remote: false, sessionId: "s1", projectId: hq.slug };
  const sup: CommandCtx = { ...base, actor: { kind: "human", id: "sup1" }, role: "supervisor" };
  assert.deepEqual(await hq.dashboard.dispatch(sup, { cmd: "createGithubIdentity", args: ["ana"], pin: OWNER_PIN }), { ok: false, error: "forbidden" });
  assert.deepEqual(await hq.dashboard.dispatch({ ...base, remote: true }, { cmd: "createGithubIdentity", args: ["ana"], pin: OWNER_PIN }), { ok: false, error: "remote" });
  assert.deepEqual(await hq.dashboard.dispatch(base, { cmd: "createGithubIdentity", args: ["ana"] }), { ok: false, error: "pin-required" });
  assert.equal(hq.company.db.prepare("SELECT count(*) AS n FROM agent_github_apps").get<{ n: number }>()?.n, 0);
});

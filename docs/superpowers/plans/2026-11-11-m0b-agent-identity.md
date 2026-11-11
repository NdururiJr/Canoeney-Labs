# M0-B Agent identity and roles: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every agent proves who it is with its own secret, HQ takes identity only from that secret, and what an agent may do comes from its role in the company store, with every tool call audited.

**Architecture:** The company store gains a registry of agents (one row per project agent, holding role and status) and a table of agent secrets that keeps only a SHA-256 hash of each secret. A new `AgentAuth` resolves the `Authorization` header of `/mcp` and `/hook` to a registered agent, refuses everything else with one uniform 401, and rate-limits. The MCP server builds each agent's tool list from its role, refuses calls outside it before the MCP SDK sees them, and runs every allowed call inside a store transaction that holds its audit row. Sessions issue a new secret just before launching an agent and never touch a running agent's files.

**Tech stack:** Node ≥ 22.13 (`node:crypto`, `node:sqlite`, `node:test`), TypeScript, the existing MCP SDK. No new packages.

**Spec:** `docs/superpowers/specs/2026-11-09-agentic-company-m0-m1-design.md`: M0.2 and M0.14 (first bullet), surfaces S1 and S2 (§2b), the role table §2a, audit scope §9.5. Requirements: `docs/security/threat-model-m0.md` §3.1, SR-B-01 to SR-B-24. Order and carry-forward: `docs/superpowers/plans/2026-11-11-m0-foundations-overview.md`.

## Owner decisions this plan relies on

- **D8 (2026-11-11): the store keeps only a hash of each agent secret.** SR-B-05 is built in full. Consequence: HQ cannot write the same secret twice, so a session HQ reattaches to keeps the files it has (Task 7).
- **D6 (2026-11-11): M0-B refuses agent secrets everywhere except `/mcp` and `/hook` (SR-B-24).** Separate listeners (SR-G-01) are M0-G.

## Where this plan reads the spec narrowly (for the reviewer)

- **Tool sets follow §2a exactly, for the tools that exist today.** §2a says "anything not listed is not available to the role". So the CTO loses `ask_user` and `request_access` (the lead has them today), and builders lose `list_workers`, `get_status` and `list_tasks`. SR-B-18 (what `get_status` and `list_tasks` show a builder) is then met by refusal (SR-B-13). Tools §2a names that do not exist yet (`get_charter`, `raise_decision`, …) are M1.
- **The role is read from the store at first registration and never again from config.** `isLead` in `.jsmhq/config.json` seeds the role once, on the first start of a project with no registered agents. Moving the rest of the config out of the repo is M0-D.
- **`isLead` stays for display and notices** (the UI, `access.ts`, `githubSync.ts`, `commands.ts` `updateWorkflow`). None of these is an authorisation decision. `mcp.ts` and `planner.agentId("lead")` stop reading it. M0-D removes it from config.
- **Origin binding (SR-B-09) is recorded, not built.** `sbx` is not installed on the build machine, so what the proxy shows HQ cannot be checked here. ADR 0006 records this and the residual risk; the check moves to M0-G, on the Linux host that runs Docker Sandboxes.

## Global constraints

- Keep the existing stack (spec §7). No new packages.
- Anti-goal §4: a secret value never enters "a log, an alert or the audit trail". The one secret that lives in an agent's folder is its own HQ secret: M0.2 accepts that "an agent can read its own secret". No other secret is written there.
- Anti-goal §4: existing capabilities must not regress: `pnpm typecheck`, `pnpm test`, `pnpm build`, `npx tsx scripts/session-backend-test.ts` and `scripts/smoke-test.mjs` pass on Ubuntu, macOS and Windows.
- Every enforcement test follows the threat model's rules (§3 preamble): the refusal is checked, the audit row for it is checked (actor = the authenticated caller), the targeted state is read back unchanged, and the test title is `SR-B-nn [T-…] …`.
- Times come from the injected `Clock` (M0-A).
- Renaming is M0-H. No product name in code. The secret prefix `hqa_` is neutral.
- `.jsmhq/config.json` and `plan.json` stay in the repo (M0-D). The store becomes authoritative for **identity, role and status** only.
- Until owner login exists (M0-C), dashboard commands are audited with the actor `{ kind: "human", id: "dashboard" }` (`DASHBOARD_ACTOR`). M0-C replaces it with the logged-in human.

## Review focus

1. **Agents that survive an HQ restart** (tmux on Linux and macOS): reattaching must not issue a secret or rewrite files, or the running agent is locked out (spec M0.2, M0 restart gate). Test: Task 7 `SR-B-07 [T-X3.6] reattaching to a live session issues no secret and writes no file`.
2. **Upgrading an existing install:** the existing lead must become the CTO, not a builder, and agents still running with the old shared token must be told to restart once. Tests: Task 3 `first sync imports the lead as cto`; Task 7 `a reattached agent with no live secret gets a restart notice`.
3. **Two projects on one company store:** both have an agent called `lead`. Their rows must not collide, and project X's secret must be refused by project Y's HQ. Tests: Task 3 `same agent id in two projects registers twice`; Task 4 `SR-B-04 [T-S1.4] a secret from another project gets the uniform 401`.
4. **Codex agents:** their TOML config must carry the new secret, no `X-HQ-Agent`, and mode 0600. Test: Task 7 `SR-B-23 [T-S1.10] codex config holds the secret, no agent header, mode 0600`.
5. **Removing an agent and adding one with the same name:** the retired id must not come back. Test: Task 7 `a new agent never reuses a retired agent's id`.

---

### Task 1: Audit sink hardening

Carry-forward: PR #1 finding 1 (value scan, key match) and the PR #1 review's non-blocking finding (clock read outside the write transaction). Also fixed here, found by CodeRabbit on PR #1 and confirmed: the hash is computed from the caller's `data` object, not from the JSON that is stored, so a getter can make a row that `verify()` rejects.

**Files:**
- Modify: `server/company/audit.ts`
- Test: `server/company/audit.test.ts`

**Interfaces:**
- Produces:
  - `AuditSecretError(where: string)`: `where` names the field (`"data.headers.auth"`, `"target"`, `"action"`) and **never contains the matched text**.
  - `CREDENTIAL_SHAPES: readonly RegExp[]` (exported for Task 2's test and future callers):
    - `/\bgh[pousr]_[A-Za-z0-9]{20,}/`, `/\bgithub_pat_[A-Za-z0-9_]{20,}/`
    - `/\bsk-[A-Za-z0-9_-]{20,}/` (covers `sk-ant-…`, `sk-proj-…`)
    - `/\bxox[abposr]-[A-Za-z0-9-]{10,}/`, `/\bAKIA[0-9A-Z]{16}\b/`, `/-----BEGIN [A-Z ]*-----/`
    - `/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/` (JWT)
    - `/\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i`
    - `/\bhqa_[A-Za-z0-9_-]{43}\b/` (HQ agent secrets, Task 2)
- Key rule (normalise as today: lower-case, drop `-`, `_`, whitespace):
  - Refused if the key **contains** one of `secret`, `password`, `passphrase`, `apikey`, `accesskey`, `privatekey`, `privkey`, `authorization`, `authheader`, `bearer`, `credential`, `cookie`, `jwt`, or contains `token` not followed by `s` or `count`.
  - Refused if the key **ends with** one of today's short words: `pin`, `pinhash`, `pincode`, `otp`, `totp`, `recoverycode`, `recoverycodes`, `pat`, `auth`, `signature`.
  - Allowed after that if the key ends with `name`, `names`, `id` or `ids` (a key that names a secret, never holds one).
  - Bare `key` stays allowed: memory keys and `idempotencyKey` are ids, and the value scan still applies.

- [ ] **Step 1: Write the failing tests**
  - `SR-B-11 [T-X1.4] refuses a credential shape in a data value, target or action`: for one sample of each shape, `append` throws `AuditSecretError` with the shape nested at `data.a[0].b`, in `target`, and in `action`. `query()` is unchanged after each. `err.message` does not contain the sample.
  - `SR-B-11 [T-X1.4] refuses secret words anywhere in a key`: `secretValue`, `tokenValue`, `apiKeyValue`, `authHeader`, `githubPat`, `accessKey`, `jwt`, `signature`, `privateKeyPem` each throw.
  - `SR-B-11 [T-X1.4] still allows usage and naming keys`: `inputTokens`, `outputTokens`, `tokenCount`, `secretName`, `secretNames`, `pinned`, `idempotencyKey`, `dedupeKey`, `key`, `author`, `footprint`, `path` append.
  - `at is read inside the write transaction`: a clock that returns a later time on each call, two sinks on one file appending in turn: across the chain, `at` never decreases as `seq` grows.
  - `hash uses the stored snapshot`: `data` with a getter returning `++i`: `append` succeeds and `verify().ok` is `true`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the new tests fail; the rest pass.
- [ ] **Step 3: Implement** the key rule and `CREDENTIAL_SHAPES` scan (over every string in `data`, every key in `data`, `target` and `action`), read `at` inside `write()`, and hash and return `JSON.parse(dataJson)`.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`. Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `fix(company): scan audit values for credentials, widen the key match, read the clock inside the write`.

---

### Task 2: Agent secrets (migration 004)

**Files:**
- Create: `server/company/schema/004_agent_secrets.ts` (register `m004` in `MIGRATIONS`)
- Create: `server/company/agentSecrets.ts`
- Test: `server/company/agentSecrets.test.ts`
- Create: `docs/adr/0005-agent-identity.md`

**Interfaces:**
- Migration 004 (literal SQL, as M0-A's rule requires):
  - `agent_secrets(id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), secret_hash TEXT NOT NULL UNIQUE CHECK (length(secret_hash) = 64), issued_at TEXT NOT NULL, revoked_at TEXT NULL, revoked_reason TEXT NULL CHECK (revoked_reason IN ('rotated','paused','retired')), CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)))`
  - `CREATE UNIQUE INDEX one_live_secret ON agent_secrets(agent_id) WHERE revoked_at IS NULL`
  - Triggers: no `DELETE`; an `UPDATE` may only set `revoked_at` and `revoked_reason` on a row whose `revoked_at` is NULL, and may change no other column.
- `agentSecrets.ts`:
  - `const AGENT_SECRET_PATTERN = /^hqa_[A-Za-z0-9_-]{43}$/` (`hqa_` + base64url of 32 bytes from `randomBytes`).
  - `function hashSecret(secret: string): string`: SHA-256 hex.
  - `class AgentSecrets { constructor(db: CompanyDb, clock: Clock, audit: AuditSink) }`
    - `issue(companyAgentId: string): string`: one immediate transaction: revoke the live secret with reason `rotated`, insert the new hash, append `agent.secret.issued` (`target` = the agent; no value, no hash). Returns the clear value; it is never stored.
    - `authenticate(secret: string): { ok: true; companyAgentId: string } | { ok: false; reason: "malformed" | "unknown" | "revoked" | "inactive" }`: pattern check, then lookup by `hashSecret`. `inactive` when the agent's status is not `active`.
    - `revoke(companyAgentId: string, reason: "paused" | "retired"): boolean`: joins a caller transaction when one is open (as `append` does).
    - `hasLive(companyAgentId: string): boolean`.

- [ ] **Step 1: Write the failing tests** (agents rows inserted directly; Task 3 adds the registry):
  - `SR-B-05 [T-S1.4 T-X3.7] a secret is 256-bit and only its hash is stored`: the value matches `AGENT_SECRET_PATTERN`. Then every column of every table, read with `SELECT *`, contains neither the value nor its base64url part.
  - `SR-B-06 [T-S1.2 T-S1.3] issuing again revokes the previous secret`: issue, issue again: the first gets `{ ok: false, reason: "revoked" }`, the second authenticates.
  - `SR-B-07 [T-X3.6] a secret survives closing and reopening the store`.
  - `SR-B-08 [T-S1.3 T-X2.13] revoke on pause stops the secret at once`: `revoke(id, "paused")`, then `authenticate` gives `revoked`.
  - `agent_secrets refuses delete and un-revoke`: a raw `DELETE` and `UPDATE … SET revoked_at = NULL` both throw.
  - `audit rows for issue hold neither value nor hash`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the migration and `agentSecrets.ts`.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`.
- [ ] **Step 5: Write ADR 0005**: the secret format, why SHA-256 without a salt or slow hash is enough for a 256-bit random value, lookup by hash, rotation per session, no rewrite on reattach (D8), the `Authorization: Bearer` header as the only carrier, and the role-to-tool table from Task 5.
- [ ] **Step 6: Commit** `feat(company): per-agent secrets stored as hashes (migration 004)`.

---

### Task 3: Agent registry

**Files:**
- Create: `server/company/agents.ts`
- Modify: `server/company/index.ts` (`Company` gains `agents: AgentRegistry` and `secrets: AgentSecrets`)
- Test: `server/company/agents.test.ts`

**Interfaces:**
- `const companyAgentId = (projectSlug: string, agentId: string) => \`${projectSlug}/${agentId}\``. Both parts must match `/^[a-z0-9][a-z0-9-]*$/`, or it throws.
- `const DASHBOARD_ACTOR: { kind: "human"; id: "dashboard" }`
- `interface RegisteredAgent { companyId: string; projectSlug: string; agentId: string; name: string; role: RoleId; status: AgentStatus; managerId: string | null }`
- `class AgentRegistry { constructor(db: CompanyDb, clock: Clock, audit: AuditSink, secrets: AgentSecrets) }`
  - `ensureProject(p: { slug: string; name: string; repo: string }): void`: inserts `projects(id = slug, kind = 'company')` if missing.
  - `register(projectSlug: string, a: { id: string; name: string; cli: AgentCli }, role: "cto" | "builder", by: { kind: ActorKind; id: string }, source: "import" | "dashboard" | "config"): RegisteredAgent`: `department_id = 'delivery'`; a builder's `manager_id` is the project's active CTO, or null. Throws if the id is registered already (any status). Audits `agent.registered` with `{ role, source }`.
  - `syncFromConfig(projectSlug: string, team: readonly { id: string; name: string; cli: AgentCli; isLead: boolean }[]): { registered: RegisteredAgent[]; ignoredLead: string[] }`:
    - If the project has **no** registered agents: register each with `role = isLead ? "cto" : "builder"`, `source = "import"`, actor `hq`.
    - Otherwise, each config agent without a row is registered as `builder` with `source = "config"`. If its `isLead` is true, its id goes in `ignoredLead`, and the audit data carries `ignoredIsLead: true`.
    - Rows with no config agent are left alone.
  - `get(projectSlug, agentId): RegisteredAgent | null`, `getById(companyId): RegisteredAgent | null`, `list(projectSlug): RegisteredAgent[]`, `cto(projectSlug): RegisteredAgent | null`.
  - `setRole(projectSlug, agentId, role: RoleId, by): void`. No dashboard command uses it in M0-B: changing a role from the dashboard needs the PIN (M0-C).
  - `setStatus(projectSlug, agentId, status: AgentStatus, by): void`: in one transaction, `paused` and `retired` call `secrets.revoke`. `retired` is final: it throws on any later status change.

- [ ] **Step 1: Write the failing tests**
  - `first sync imports the lead as cto and workers as builders`, with the builders' `managerId` set to the CTO.
  - `SR-B-14 [T-S1.7 T-S7.1] a later isLead in config does not make a cto`: sync once, then sync a new agent with `isLead: true`: it is a builder, `ignoredLead` names it, and its audit row has `ignoredIsLead: true`. An existing builder whose config now says `isLead` stays a builder.
  - `same agent id in two projects registers twice`: projects `alpha` and `beta` each register `lead`, as `alpha/lead` and `beta/lead`.
  - `SR-B-08 [T-S1.3 T-X2.13] pausing revokes in the same transaction`: issue a secret, `setStatus("paused")`, then `authenticate` gives `revoked`. Resuming leaves the old secret revoked.
  - `retired is final`: `setStatus("active")` after `retired` throws.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** `agents.ts` and wire it into `openCompany`.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(company): agent registry with roles and status`.

---

### Task 4: Authenticate `/mcp` and `/hook` by secret

**Files:**
- Create: `server/agentAuth.ts`
- Create: `server/testing/hqFixture.ts` (test helper, used by Tasks 4–7)
- Modify: `server/http.ts`, `server/paths.ts` (remove `agentToken`), `server/main.ts`
- Test: `server/agentAuth.test.ts`
- Create: `docs/adr/0006-sandbox-origin-binding.md`

**Interfaces:**
- `interface AuthLimits { perSecretBurst: number; perSecretPerSecond: number; failuresPerSourcePerMinute: number }`; `DEFAULT_AUTH_LIMITS = { perSecretBurst: 100, perSecretPerSecond: 50, failuresPerSourcePerMinute: 20 }`.
- `class AgentAuth { constructor(o: { projectSlug: string; company: Company; hub: Hub; limits?: Partial<AuthLimits> }) }`
  - `check(req: IncomingMessage, endpoint: "mcp" | "hook", claimedAgentId: string | null): { ok: true; agent: RegisteredAgent } | { ok: false; status: 401 | 429 }`
  - Reads only `Authorization: Bearer <secret>`. Refuses with 401 when the secret fails, belongs to another project, or the agent is not in the hub's config. When `claimedAgentId` (the hook URL's id, or an `X-HQ-Agent` header) names a different agent, it refuses with 401 and audits `agent.identity-mismatch` (actor = the authenticated agent; `claimed` clipped to 64 characters).
  - Failures: each 401 has the body `unauthorized` and no other header. The first failure per source per minute is audited as `auth.failed` (actor `hq`, `data: { endpoint, reason, source }`). Past `failuresPerSourcePerMinute`, failing requests from that source get 429, and one `auth.rate-limited` row is written per source per minute. A valid secret is never refused because of another source's failures.
  - Per secret: a token bucket (`perSecretBurst`, refilled at `perSecretPerSecond`, read from the injected clock). Over it: 429, and one `auth.rate-limited` row per secret per minute.
- `startHttp` options: `agentToken` is replaced by `agentAuth: AgentAuth` and `company: Company`. `/hook` passes `claimedAgentId` from the URL; `/mcp` from `X-HQ-Agent` (or null).
- `hqFixture.ts`: `makeHq(t: TestContext, opts?: { team?: … }): Promise<{ company; hub; planner; inbox; url: string; secretFor(agentId: string): string }>`. It builds a temp repo folder (a space in its name) and a temp company home, the team `lead` (cto), `ana` and `ben` (builders), and `startHttp` on port 0, and closes everything in `t.after`.
- `paths.ts`: `agentToken` is deleted. `main.ts` removes a leftover `agent-token` file in the project home at startup.

- [ ] **Step 1: Write the failing tests**
  - `SR-B-01 [T-S1.1] an X-HQ-Agent header naming another agent is refused`: with `ana`'s secret and `X-HQ-Agent: lead`, `create_task` is refused (401). The task count is unchanged, and an `agent.identity-mismatch` row has actor `<slug>/ana`.
  - `SR-B-02 [T-S2.1 T-S2.2 T-S2.3] a hook for B sent with A's secret has no effect`: queue two messages for `ben`. With `ana`'s secret, POST `Stop`, `SessionStart` and `Notification` to `/hook/ben/…`: each is 401, the body holds none of the message text, `ben`'s queue still holds two, his status is unchanged, and three mismatch rows have actor `<slug>/ana`.
  - `SR-B-03 [T-S1.1 T-S2.1] the old project token is refused and no agent-token file is created`.
  - `SR-B-04 [T-S1.4] every failure gets the same response`: no header, wrong scheme, unknown, revoked, malformed, and a secret from another project give byte-identical status, headers (except `Date`) and body. A burst of 100 failures from one source writes at most 2 audit rows.
  - `SR-B-21 [T-S1.12 T-S2.6] a flood from one secret gets 429 and others still work`: 500 calls in one fake-clock second with `ana`'s secret: later ones get 429, a call with `ben`'s secret succeeds, and there is exactly one `auth.rate-limited` row.
  - `SR-B-24 [T-S5.12] an agent secret opens no WebSocket`: an upgrade to `/ws` with `ana`'s secret in `?token=`, and again in `Authorization`, gets 401.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** `agentAuth.ts`, the fixture and the `http.ts` and `main.ts` changes. `main.ts` builds `new AgentAuth({ projectSlug: slug, company, hub })`.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`.
- [ ] **Step 5: Write ADR 0006 (SR-B-09).** Agents reach HQ at `host.docker.internal:<port>` through the `sbx` proxy. `sbx` was not available on the build machine, so whether HQ can tell one sandbox from another is unverified. Record the residual risk (T-S1.5: a secret copied to another sandbox works there until rotation) and that M0-G verifies it on the Linux host.
- [ ] **Step 6: Commit** `feat: authenticate /mcp and /hook by per-agent secret`.

---

### Task 5: Role tool sets and an audit row for every tool call

**Files:**
- Create: `server/company/roleTools.ts`
- Modify: `server/mcp.ts`, `server/planner.ts` (`agentId("lead")` → the registry's CTO)
- Test: `server/mcp.test.ts`

**Interfaces:**
- `const HQ_TOOLS = ["list_workers", "get_status", "list_tasks", "create_board", "create_task", "update_task", "assign_task", "get_my_task", "set_my_status", "ask_user", "request_access", "send_message"] as const`; `type HqTool`.
- `const TOOLS_BY_ROLE: Record<RoleId, readonly HqTool[]>` (§2a, existing tools only):
  - `cto`: `list_workers`, `get_status`, `list_tasks`, `create_board`, `create_task`, `update_task`, `assign_task`, `send_message`, `set_my_status`
  - `builder`: `get_my_task`, `set_my_status`, `send_message`, `request_access`, `ask_user`
  - every other role: `[]`
- `const MESSAGE_TO: Partial<Record<RoleId, readonly RoleId[]>> = { cto: ["ceo", "builder"], builder: ["cto", "builder"] }`.
- `handleMcp(hub: Hub, planner: Planner, company: Company, agent: RegisteredAgent, req, res, body)`:
  - It reads the role from `company.agents` on every request (SR-B-15).
  - It registers only the role's tools.
  - Before the SDK: a `tools/call` (alone, or inside a JSON-RPC batch) for a tool not in the set gets a JSON-RPC error and one `tool.denied` row (`target` = the tool name). Nothing else runs.
- Every registered tool runs through `audited(tool, targetOf, fn)`:
  - `company.db.transaction(() => { audit.append({ action: "tool.called", data: { tool, outcome: "ok", args } }); return fn(args) }, "immediate")`.
  - If `fn` throws, the row rolls back, then a `tool.called` row with `outcome: "error"` is appended (args included, error message clipped to 200 characters).
  - If that append throws too, the tool returns `"HQ could not record this action, so it was not done."` (SR-B-12).
  - `args` replaces the free-text fields `text`, `details`, `description`, `note`, `title`, `reason` and `doneWhen` with `{ chars: n }`.
- `mcp.ts` contains no `isLead`.

- [ ] **Step 1: Write the failing tests** (the fixture from Task 4, through real HTTP):
  - `SR-B-13 [T-S1.6] a builder cannot list or call lead tools`: `tools/list` for `ana` has exactly the builder set. A raw `tools/call` for `create_task`, `assign_task` and `update_task` is each refused, with one `tool.denied` row, and the plan is unchanged.
  - `SR-B-14 [T-S1.7 T-S7.1] isLead in config grants nothing`: set `ana.isLead = true` in the hub config: `create_task` is still refused.
  - `SR-B-15 [T-S1.7] a role change applies to the next call`: `lead` calls `get_status` (allowed). `setRole(lead → builder)`; the next `get_status` is refused.
  - `SR-B-16 [T-S1.9 T-X1.6] each call writes exactly one row with the authenticated actor`: each of `ana`'s tools, once allowed and once failing: the chain grows by one per call, the actor is `<slug>/ana` even when an argument names `ben`, and `verify().ok`.
  - `SR-B-12 [T-X1.3] a failing audit write stops the action`: an audit sink whose `append` throws: `set_my_status` returns the error text and the task's status is unchanged.
  - `SR-B-17 [T-S1.8] no argument chooses who acts`: as `ana`, `set_my_status` with `ben`'s task id in the note, and a `send_message` whose text starts "from ben": only `ana`'s task changes, and the delivered message is labelled from `ana`.
  - `SR-B-18 [T-S1.11] builders see only their own task`: `get_my_task` for `ana` returns no other agent's note, and a refusal's text names no other agent.
  - `message rules follow the role`: `ana` → `ben` and `ana` → `lead` are delivered.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Also change the generated role file: `RoleExtras` gains a required `role: RoleId`, and `roleMd(agent, cfg, extras)` takes its rules (CTO or builder) and its tool list from `extras.role` and `TOOLS_BY_ROLE`, never from `agent.isLead`. Task 7 passes the role in when it writes the files.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`.
- [ ] **Step 5: Commit** `feat: role tool sets and an audit row for every MCP call`.

---

### Task 6: Hooks as untrusted, best-effort input

**Files:**
- Modify: `server/hooks.ts` (`handleHook` gains `company: Company`)
- Test: `server/hooks.test.ts`

**Interfaces:**
- `cleanAgentText(s: string, max = 200): string`: strips C0 and C1 control characters (keeps none), collapses whitespace, and cuts to `max` characters with `…`.
- Audited hook events: `SessionStart`, `SessionEnd`, and a `Stop` that hands over queued messages, as `hook.<event>` with `data: { bestEffort: true }` (and `{ delivered: n }` for `Stop`). Other events are not audited (they fire on every tool use).

- [ ] **Step 1: Write the failing tests**
  - `SR-B-20 [T-S2.5] hook text is cut and cleaned`: a `Notification` whose message holds `\x1b[31m`, `\u0007`, `<script>` and 10,000 characters is stored in the agent's note at no more than 200 characters, with no control characters. The activity text is the same clean string.
  - `SR-B-19 [T-S2.4] hook-reported state decides nothing`: set `ana`'s hub state to `working` and `idle` in turn: `AgentAuth.check` and the MCP role check give the same result both times. The `hook.Stop` row has `bestEffort: true`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`.
- [ ] **Step 5: Commit** `feat: treat hook input as untrusted and audit it as best effort`.

---

### Task 7: Issue secrets at session start, register the team, and contain poll errors

Carry-forward: "`workspaceFor` can throw inside the sessions polling tick for a refused folder and starve later agents" (SR-B-22).

**Files:**
- Modify: `server/sessions.ts` (constructor takes `company: Company` instead of the token), `server/agentFiles.ts`, `server/adapters.ts`, `server/lib/agentFs.ts`, `server/commands.ts`, `server/main.ts`
- Test: `server/sessions.identity.test.ts`, `server/identity.e2e.test.ts`
- Modify: `docs/how-it-works.md` (section "Agent identity": one secret per agent, issued at session start, stored as a hash; roles from the company store)

**Interfaces:**
- `Sessions.start(id)`:
  - Refuses with a visible failure when the registry has no `active` row ("This agent is paused." / "This agent was retired.").
  - Checks `backend.exists(name)` **before** writing files. If the session exists, it reattaches and writes nothing.
  - Otherwise: `const secret = company.secrets.issue(reg.companyId)`, then `adapter.writeFiles(dir, agent, cfg, secret, { role: reg.role, … })`, then launches.
- `startPolling`: each agent's tick body is wrapped so a throw marks that agent `failed` with the message and the loop continues. When it reattaches an agent and `!company.secrets.hasLive(companyId)`, one activity line says: "`<name>` is running with an old HQ key. Restart `<name>` once so it gets its own."
- `agentFiles.ts` / `adapters.ts`: the `X-HQ-Agent` header is no longer written (Claude MCP config and Codex TOML). `.claude/settings.local.json` is written with mode `0o600`.
- `agentWrite(root, rel, data, opts)`: when `opts.mode` is set, it also `chmodSync`s, because `writeFileSync` applies the mode only to a new file.
- `commands.ts`:
  - `completeWelcome` registers the lead as `cto` and the workers as `builder` (`DASHBOARD_ACTOR`, source `dashboard`).
  - `addAgent` registers a `builder` and picks an id that is in neither the config nor the registry.
  - `removeAgent` calls `setStatus("retired")`.
- `main.ts`: `company.agents.ensureProject(...)`. If the config is not new, `syncFromConfig`, with one activity line per `ignoredLead` id ("`<name>` is marked lead in `.jsmhq/config.json`, but roles come from the company store; it was added as a builder."). Then `new Sessions(hub, company)`.

- [ ] **Step 1: Write the failing tests.** Use the fixture plus a fake `SessionBackend` (from `server/backends/types.ts`) assigned to `sessions.backend`, Local-mode agents with `workspacePath` set to a temp git repo, and setup checks with `tmux` and `claude` ok.
  - `SR-B-06 [T-S1.2 T-S1.3] a new session rotates the secret`: start `ana` and read the secret from `.claude/hq-mcp.json`. Give that secret to a client acting as `ben`. Stop and start `ana`: the old secret gets 401 on `/mcp` and an `auth.failed` row; the new one works.
  - `SR-B-07 [T-X3.6] reattaching to a live session issues no secret and writes no file`: the fake backend says the session exists. `start` and a poll tick leave `agent_secrets` unchanged and leave the files' mtimes unchanged.
  - `SR-B-08 [T-S1.3] a paused agent's secret stops at once and start is refused`: `setStatus("paused")`, then 401 on `/mcp` and `/hook`; `start` sets the session to failed with "paused".
  - `SR-B-22 [T-S7.6] one refused workspace does not stop the poll`: `ana`'s `workspacePath` is inside the company store; after a tick, `ben`'s session state still updates.
  - `SR-B-23 [T-S1.10] secret files are 0600, never written through a link, and git-excluded` (POSIX modes skipped on Windows): mode `0o600` on `hq-mcp.json` and `settings.local.json` (an existing `0o644` file too); a planted symlink at `hq-mcp.json` is replaced, not followed; `git check-ignore` matches both.
  - `SR-B-23 [T-S1.10] codex config holds the secret, no agent header, mode 0600`.
  - `a new agent never reuses a retired agent's id`: add `Cara`, remove her, add `Cara` again: the new id is `cara-2`.
  - `a reattached agent with no live secret gets a restart notice`.
  - `SR-B-10 [T-S1.10] the secret appears nowhere but the agent's own files` (in `identity.e2e.test.ts`): capture `console.*` and every hub event. Start `ana`, then run a `SessionStart` hook, ten tool calls, one refused call and a `Stop`. The secret appears in no captured line, no event, no audit row, no error text, and not in `git status --porcelain` of the repo.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the changes above, then update `docs/how-it-works.md`.
- [ ] **Step 4: Run the full checks**
  - Run: `pnpm typecheck && pnpm test && pnpm build`. Expected: exit 0, and `built dist-server/main.mjs`.
  - Run: `npx tsx scripts/session-backend-test.ts`. Expected: passes.
  - Run in bash: `mkdir -p pack && npm pack --ignore-scripts --pack-destination pack && node scripts/smoke-test.mjs pack/*.tgz 7431`. Expected: `✓ smoke test passed`.
- [ ] **Step 5: Commit** `feat: issue agent secrets at session start and register the team in the company store`.

## Done when

- **Checks:** `pnpm test`, `pnpm typecheck` and `pnpm build` pass locally; CI is green on all four jobs.
- **Requirements:** each of SR-B-01 to SR-B-24 has a test whose title names it, except SR-B-09, which ADR 0006 records and the overview carries to M0-G.
- **ADRs:** 0005 and 0006 are written.
- **Exit gate (§6):** "a test proves that agent A cannot act as agent B (M0.2)": `SR-B-01`, `SR-B-02` and `SR-B-06`.
- **Next:** M0-C (owner login), which needs no owner action first.

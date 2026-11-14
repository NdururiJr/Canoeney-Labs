# M0-E Least-privilege GitHub: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No agent can merge, administer a repo or reach another agent's branches. Each agent works on GitHub as its own App with a short-lived token for one repo. No secret value enters a sandbox.

**Architecture:**
- **One GitHub App per agent** (owner decision, 2026-11-14).
  - The owner creates each App from a manifest HQ prepares, and installs it on the project's repo only.
  - HQ keeps each App's private key sealed with the owner key, as it does the TOTP seed.
  - HQ mints a one-hour installation token for one repository. It gives the token to the agent's own sandbox as its `github` key, refreshes it while the agent runs, and revokes it when the agent stops, is paused or is retired.
- **GitHub enforces the limits, not HQ.** Branch protection on `main` requires the owner's code-owner review, with no bypass. One ruleset per agent lets only that agent's App write `<agent>/**` branches. Actions run read-only, cannot approve pull requests, and the repo has no secrets.
- **HQ checks those settings** when a project opens and daily, alerts on drift, and can apply them with the owner's PIN.
- **No global consequential key.** A `github` key set "for every sandbox" is refused, and while one exists no agent starts.
- **No env files (D2).** Env files reach no agent in M0 and M1.

**Tech stack:** Node ≥ 22.13 (`node:crypto` for RS256 and AES-GCM, `fetch`), TypeScript, React 18. No new packages.

**Spec:** `docs/superpowers/specs/2026-11-09-agentic-company-m0-m1-design.md`:
- M0.10: least-privilege credentials, branch protection, no global consequential secrets, no Local mode for company agents, merge-by as a gated setting, Actions hardening.
- The §6 exit item "least-privilege GitHub identities, branch protection and Actions hardening are live on the company-website repo".

Requirements: `docs/security/threat-model-m0.md`:
- §3 SR-E-01 to SR-E-15;
- §4.7 D2.

Order and carry-forward: `docs/superpowers/plans/2026-11-11-m0-foundations-overview.md`.

## Owner decisions this plan relies on

- **GitHub identity: one GitHub App per agent** (2026-11-14).
  - The owner first chose one App for everyone.
  - The builder then showed that a shared App cannot meet SR-E-03 (no agent writes another agent's branch) or SR-E-12 (a PR is attributed by its identity).
  - Each App is free. The owner's work is two clicks per agent: Create, then Install.
- **D2: env files reach no agent in M0 and M1** (2026-11-14). This covers every agent HQ runs, builders and the CTO included.
  - From M2 the owner approves named variables one at a time with the PIN, with test credentials only.
- **Spend: GitHub Pro later.** The company website repo `NdururiJr/CanoeneyLabsWebste` was made public on 2026-11-14 at the owner's request; it was empty. Branch protection and rulesets are therefore free on it.
  - When the owner moves to Pro, this repo (Canoeney-Labs) becomes private. That is a new owner-track row.

## Where this plan reads the spec narrowly (for the reviewer)

- **Local mode for project agents.** M0.10 forbids Local mode for company-level agents (done in M0-D2, SR-E-06). It keeps Local mode "for plain coding experiments", which builders may still use.
  - A Local-mode agent works with the owner's own git and `gh` login. SR-E-01 and SR-E-02 therefore hold for sandboxed agents.
  - Local mode is already a relaxing change that needs the PIN (M0-D1), and the dashboard labels it. The docs say what it means for GitHub.
- **SR-E-14 (CI spending limit)** applies to private repos.
  - On a public repo, GitHub Actions minutes are free, so the check reports "not applicable (public)".
  - It becomes a live check when a managed repo is private.
- **SR-E-15:** the default allow list is asserted to be empty, which is today's default. Keeping the proxy's request record is sbx's job, checked on the Linux host (M0-G).
- **SR-E-10 (a workflow pushed on an agent branch)** is closed before GitHub runs anything. No agent App has the `workflows` permission, so GitHub refuses the push of any file under `.github/workflows/`.
  - The live check pushes such a file and expects the refusal.
  - The settings check (read-only token, Actions limited) is the second layer.
- **The manifest flow returns to HQ on `127.0.0.1`.** GitHub sends the owner's browser back to the manifest's `redirect_url`, so a local HQ is reachable.
  - If GitHub refuses a loopback `redirect_url`, the fallback is the owner pasting the one-time `code` from GitHub's address bar into HQ.
  - The exit check confirms which path works.

## Global constraints

- Keep the existing stack (spec §7). No new packages.
- Anti-goal §4: no secret value in a log, an alert, the audit trail, the store in clear, or a sandbox. This covers App private keys, installation tokens and env-file values. The audit sink's value guard (M0-B) still applies.
- Anti-goal §4: existing capabilities must not regress. On Ubuntu and Windows these must pass:
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - `npx tsx scripts/session-backend-test.ts`
  - `scripts/smoke-test.mjs`
- Every enforcement test follows the threat model's rules (§3 preamble):
  - the refusal is checked;
  - its audit row is checked, with the authenticated caller as the actor;
  - the targeted state is read back unchanged;
  - the title is `SR-E-nn [T-…] …`.
- Live checks run only in the exit check, against `NdururiJr/CanoeneyLabsWebste`. Unit tests use a fake GitHub client and never reach the network.
- Times come from the injected `Clock`. That covers token expiry, refresh and the daily check.
- No product name in new code (M0-H).
- `.github/`, `CLAUDE.md` and `.claude/settings.json` of this repo are not touched. In a managed repo, CODEOWNERS and the first commit are the owner's.

## Values this plan fixes

| What | Value |
|---|---|
| App manifest (one per agent) | `name`: `hq-<project>-<agent>-<4 hex>`, at most 34 characters; the hex keeps it unique on GitHub. `url`: the project's GitHub URL. `public`: false. `hook_attributes.active`: false. `redirect_url`: `<dashboard origin>/github/app-created`. `default_permissions`: `{ contents: "write", pull_requests: "write", metadata: "read" }` and nothing else (no `workflows`, `administration`, `secrets`, `actions` or `members`). `default_events`: none |
| Installation token request | `POST /app/installations/{id}/access_tokens` with `repositories: [<repo name>]` and the same three permissions. The response's `expires_at` is kept in memory only |
| Token refresh and revoke | Refresh at `expires_at − 10 min` while the agent runs. On stop, pause, retire, or HQ stopping: `DELETE /installation/token` with that token, then `sbx secret rm github --sandbox <name>` |
| App JWT | RS256, `iat = now − 60 s`, `exp = now + 9 min`, `iss = app id` |
| Sealed App keys | AES-256-GCM with the key in `<company home>/owner.key`, the same key and format as the TOTP seed (M0-C) |
| Agent branches | `<agent id>/**`, as `branchAgent` already reads them. Ruleset `hq-agent-<agent id>`: creation, update, deletion and non-fast-forward restricted on `refs/heads/<agent id>/**`; bypass only that agent's App (`Integration`, always) and the repository admin |
| Other branches | Ruleset `hq-unclaimed`: creation and update restricted on every branch except `main` and the agent patterns; bypass only the repository admin |
| `main` protection | Pull request required; 1 approving review; `require_code_owner_reviews: true`; `dismiss_stale_reviews: true`; `enforce_admins: true`; no bypass allowances; `allow_force_pushes: false`; `allow_deletions: false` |
| Actions settings | `default_workflow_permissions: "read"`; `can_approve_pull_request_reviews: false`; `enabled: false`, or `allowed_actions: "selected"` with only GitHub-owned actions; 0 repository secrets; 0 self-hosted runners |
| Workflow file rules (SR-E-11) | No `pull_request_target`, `workflow_run` or `issue_comment` trigger. Every `uses:` is local (`./…`) or pinned to a 40-hex commit |
| CODEOWNERS required lines | `* @<owner>`, plus the D1 paths: `CLAUDE.md AGENTS.md ROLE.md .claude/ .mcp.json .agents/ .codex/ .github/ @<owner>` |
| Daily repo check | Every 24 h from each project's open, and at open |
| Global keys refused | `github` with global scope (SR-E-05). Other global service keys (model providers) stay allowed; each set or removal writes `sbx.key-changed` `{ service, scope: "global" }` |
| Token-shaped text (D2, T-S3.6) | `hasCredentialShape` from `server/company/audit.ts` (the audit sink's `CREDENTIAL_SHAPES`), reused, not copied |
| New audit actions | `github.app-created`, `github.app-installed`, `github.token-revoked` (`{ reason }`, never the token), `github.drift` (`{ repo, findings: [names] }`), `github.guard-applied`, `pr.misattributed`, `sbx.key-changed`, `message.refused` (`{ reason: "secret-shape" }`). `workspace.refused` gains `global-github-key` and `mcp-server` |

## Review focus

1. **A token that outlives its agent.** Pause, retire, stop and HQ stopping each revoke it, and a refresh timer never re-issues a token after a revoke.
   - Test: Task 2, `SR-E-07 [T-S3.9] pausing revokes the agent's GitHub token, and a pending refresh issues nothing`.
2. **HQ restarted while tmux agents keep running (Linux).** A running agent's token expires within the hour unless HQ refreshes it after the restart. On reattach, HQ issues a fresh token.
   - Test: Task 2, `a reattached running agent gets a fresh token`.
3. **The manifest callback reached without HQ's own state.** It may come from another tab, a replay or another user. It is refused unless the one-time state matches an open request from the same owner session within 10 minutes.
   - Test: Task 1, `the app-created callback is refused without a matching one-time state`.
4. **A repo whose settings drift after the check passed** (someone adds a bypass actor or a secret). The daily check alerts, naming the drift.
   - Test: Task 4, `SR-E-09 [T-S9.6] each bad setting is reported by name`.
5. **A PR opened by agent A on branch `b/…` with B's task id in its title.** It is attributed to A, B's task does not change even when the PR merges, and a flag is recorded.
   - Test: Task 5, `SR-E-12 [T-S3.8] …`.

---

### Task 1: One GitHub App per agent: manifest, callback and sealed key

**Files:**
- Create:
  - `server/github/appManifest.ts`, `server/github/api.ts`, `server/github/apps.ts`
  - `server/company/sealed.ts` (seal and open with `owner.key`, moved from `humanAccounts.ts`)
  - `server/company/schema/007_agent_github.ts`
  - `server/github/apps.test.ts`
- Modify:
  - `server/company/humanAccounts.ts` (use `sealed.ts`), `server/company/migrations.ts`, `server/company/index.ts` (`Company.githubApps`)
  - `server/http.ts` (`GET /github/app-created`), `server/commands.ts` (`createGithubIdentity`)
  - `src/ui/settings/TeamSettings.tsx` ("GitHub identity" per agent)
- Create: `docs/adr/0010-github-app-per-agent.md`

**Interfaces:**
- Migration 007: table `agent_github_apps(agent_id TEXT PRIMARY KEY REFERENCES agents(id), app_id INTEGER NOT NULL, slug TEXT NOT NULL, bot_login TEXT NOT NULL, key_sealed TEXT NOT NULL, installation_id INTEGER NULL, created_at TEXT NOT NULL)`.
- `sealed.ts`: `seal(home: string, plain: Buffer): string`, `open(home: string, sealed: string): Buffer`.
- `api.ts`: `interface GitHubApi { request<T>(method: string, path: string, o?: { body?: unknown; token?: string; jwt?: string }): Promise<{ status: number; json: T | null }> }`, plus `fetchGitHubApi(base = "https://api.github.com"): GitHubApi`.
- `appManifest.ts`: `manifestFor(o: { project: string; agentId: string; repo: string; origin: string; rand: string }): object`, matching the values table.
- `apps.ts`, `class GitHubApps`:
  - `start(companyAgentId: string, humanId: string, sessionId: string): { url: string; manifest: object; state: string }`;
  - `complete(state: string, code: string, sessionId: string): Promise<{ installUrl: string }>`. It converts with `POST /app-manifests/{code}/conversions`, seals the `pem`, and writes `github.app-created`.
  - `installation(companyAgentId: string, repo: string): Promise<number | null>`. It uses `GET /repos/{repo}/installation` with the App's JWT, and writes `github.app-installed` once.
  - `jwtFor(companyAgentId: string): string`;
  - `botLogin(companyAgentId: string): string | null`.
- `commands.ts`: `createGithubIdentity(agentId)`: role `owner`, `pin: true`, `localOnly: true`. It replies with `{ url, manifest, state }` for the page to post to GitHub.

- [ ] **Step 1: Write the failing tests**
  - `the manifest asks for contents, pull requests and metadata only`: the exact values-table permissions; the name is at most 34 characters.
  - `the app-created callback is refused without a matching one-time state`:
    - an unknown state, a used state, a state older than 10 minutes, and another owner session's state each get 403;
    - no row is written;
    - `auth.failed` is not used (this is a dashboard route): a `github.app-refused` row names the reason.
  - `a created App's private key is stored sealed and never in clear`: the row's `key_sealed` does not contain `BEGIN`, and `open()` gives back the `pem`.
  - `creating a GitHub identity needs the owner's PIN and a local session`: a supervisor gets `forbidden`, remote gets `remote`, no PIN gets `pin-required`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
  - The page posts the manifest from a form to `https://github.com/settings/apps/new?state=<state>`.
  - After `complete`, HQ redirects the browser to `https://github.com/apps/<slug>/installations/new`.
  - ADR 0010 records:
    - why one App per agent;
    - the permissions;
    - the sealing;
    - the refresh and revoke;
    - the loopback-redirect fallback.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: one GitHub App per agent, created from an HQ manifest, key sealed with the owner key`.

---

### Task 2: Short-lived tokens: issue, deliver, refresh, revoke (SR-E-04, SR-E-07)

**Files:**
- Create: `server/github/tokens.ts`, `server/github/tokens.test.ts`
- Modify: `server/sessions.ts` (start, reattach, stop), `server/company/agents.ts` (`onStatusChange`), `server/projectRuntime.ts` (wiring), `server/startHq.ts` (revoke all on close)

**Interfaces:**
- Consumes `GitHubApps` (Task 1).
- `agents.ts`: `AgentRegistry.onStatusChange(fn: (companyId: string, to: AgentStatus) => void): () => void`. It is called after the transaction commits.
- `tokens.ts`, `class AgentTokens`:
  - `constructor(o: { apps: GitHubApps; api: GitHubApi; sbx: { setKey(id: string, svc: string, v: string): Promise<void>; removeKey(id: string, svc: string): Promise<void> }; clock: Clock; audit: AuditSink })`;
  - `async deliver(agentId: string, companyId: string, repo: string): Promise<"issued" | "no-identity">`;
  - `async revoke(agentId: string, reason: "stopped" | "paused" | "retired" | "hq-stopped"): Promise<void>`;
  - `revokeAll(reason): Promise<void>`.
- Tokens live in a `Map` in memory only. Refresh timers use the clock.

- [ ] **Step 1: Write the failing tests** (fake `GitHubApi` and fake `sbx`):
  - `a sandboxed agent gets a one-repo token as its own github key`:
    - the token request body is the values table's;
    - `setKey(agentId, "github", <token>)` is called, scoped to the agent;
    - no audit row and no log line holds the token.
  - `the token is refreshed ten minutes before it expires, while the agent runs`.
  - `SR-E-07 [T-S3.9] pausing revokes the agent's GitHub token, and a pending refresh issues nothing`:
    - one `DELETE /installation/token`;
    - `removeKey(agentId, "github")`;
    - `github.token-revoked` with the owner as the actor;
    - advancing the clock past the refresh issues no token.
  - `stopping, retiring and HQ stopping each revoke`.
  - `a reattached running agent gets a fresh token`.
  - `an agent with no GitHub identity starts, without a github key, and the activity says it cannot push`.
  - `a Local-mode agent gets no token` (it runs on the host; the docs say so).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Sessions call `deliver` before the sandbox is created and on reattach, and call `revoke` in `stopNow`.
  - The runtime subscribes to `onStatusChange` for pause and retire.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck && npx tsx scripts/session-backend-test.ts`.
- [ ] **Step 5: Commit** `feat: agents get a one-hour, one-repo GitHub token, revoked when they stop`.

---

### Task 3: No global consequential key (SR-E-05)

**Files:**
- Modify: `server/commands.ts` (`setSecret`, `removeSecret`), `server/sbx.ts`, `server/sessions.ts`, `server/projectRuntime.ts` (startup check)
- Modify docs: `docs/getting-started.md` step 4, `README.md`
- Test: `server/globalKeys.test.ts`

**Interfaces:**
- `sbx.ts`: `globalGithubKey(): boolean | "unknown"`, read from the last `refresh()`. It answers `"unknown"` when the read failed, as `githubKeyFor` does.
- `workspace.ts`: `WorkspaceRefusedError` reason `global-github-key`.

- [ ] **Step 1: Write the failing tests**
  - `SR-E-05 [T-S3.1] a github key for every sandbox is refused`:
    - `setSecret(null, "github", …)` with the PIN replies `failed`, with the message;
    - `settings.refused` names `github` and `global`;
    - the fake sbx records no `secret set`.
  - `SR-E-05 [T-S3.1] with a global github key present, the startup check reports it and no agent starts`:
    - the check writes an action item for the owner and an audit row;
    - `start` is refused with `global-github-key`, with the owner as the actor;
    - no session is created.
  - `a global model key is recorded when set or removed` (`sbx.key-changed`, never the value). This closes the PR #8 carry-forward row "a key set for every sandbox has no row".
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Getting-started step 4 now says: give each agent a GitHub identity (Settings → Team), and never set a `github` key for every sandbox.
  - It also tells the owner to remove an existing global one: `sbx secret rm github --force`.
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** `feat: no GitHub key for every sandbox; agents do not start while one exists (SR-E-05)`.

---

### Task 4: The repo guard: check daily, alert on drift, apply with the PIN (SR-E-02, 03, 09, 11, 14)

**Files:**
- Create: `server/github/repoGuard.ts`, `server/github/repoGuard.test.ts`, `server/github/workflowScan.ts`
- Modify: `server/projectRuntime.ts` (check at open and daily), `server/commands.ts` (`applyRepoGuard`), `src/ui/settings/ProjectSettings.tsx` ("GitHub protection" panel)

**Interfaces:**
- `repoGuard.ts`:
  - `interface Finding { name: string; detail: string; fixable: boolean }`.
  - `async checkRepo(gh: GitHubApi, repo: string, o: { owner: string; agents: { id: string; appId: number }[] }): Promise<Finding[]>`. It reads:
    - `main` protection;
    - the rulesets;
    - `actions/permissions`;
    - `actions/permissions/workflow`;
    - `actions/secrets`;
    - `actions/runners`;
    - `CODEOWNERS` (root or `.github/`);
    - each file under `.github/workflows/` (through `workflowScan`);
    - the repo's visibility (SR-E-14).
  - `async applyRepoGuard(gh: GitHubApi, repo: string, o: …): Promise<Finding[]>`. It sets everything fixable to the values table and returns what is left. CODEOWNERS and workflow files are never written: they are the owner's.
- `workflowScan.ts`: `scanWorkflow(path: string, yaml: string): Finding[]`. It uses line rules for the three triggers and for `uses:`, with no YAML package.
- The host's `gh` login (the owner's) is the client: `ghCliApi(exec): GitHubApi` runs `gh api`.
- `commands.ts`: `applyRepoGuard()`: role `owner`, `pin: true`. It writes `github.guard-applied` with the names it changed.

- [ ] **Step 1: Write the failing tests** (fake client):
  - `SR-E-09 [T-S9.6] each bad setting is reported by name`. Starting from a good repo, each bad setting in turn gives exactly one finding with its name:
    - workflow token `write`;
    - Actions may approve PRs;
    - all actions allowed;
    - one repository secret;
    - a self-hosted runner;
    - `enforce_admins` off;
    - a bypass allowance;
    - no code-owner review;
    - an agent ruleset missing;
    - an agent ruleset bypassed by another App;
    - CODEOWNERS missing a D1 path.
  - `SR-E-11 [T-S9.3 T-S9.4] a privileged trigger or a tag-pinned action is a finding`: `pull_request_target`, `workflow_run`, `issue_comment` and `uses: actions/checkout@v4` each give a finding; a 40-hex pin and `./local` give none.
  - `SR-E-14 [T-S9.5] a public repo reports the spending limit as not applicable; a private one without a limit is a finding`.
  - `drift found by the daily check is an owner action item and a github.drift row, once per finding`.
  - `applying the guard needs the PIN and sets only fixable settings`: the fake client records the exact calls; CODEOWNERS is not written.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** `feat: HQ checks each repo's protection daily and applies it with the owner's PIN`.

---

### Task 5: A pull request belongs to the identity that opened it (SR-E-12)

**Files:**
- Modify: `server/github.ts` (fetch `author.login`), `server/githubSync.ts`
- Test: `server/githubSync.test.ts` (new)

**Interfaces:**
- Consumes `GitHubApps.botLogin` (Task 1).
- `toPullRequest` takes `authorId` from the agent whose `bot_login` equals the PR's `author.login`. A PR by any other login has no agent author.
- `taskIdOf` and `branchAgent` are kept only as claims, which are checked against that author.

- [ ] **Step 1: Write the failing tests**
  - `SR-E-12 [T-S3.8] a PR opened by A on b/… titled with B's task id is A's`:
    - the PR's author is A;
    - B's task status is unchanged when the PR opens and when it merges;
    - one `pr.misattributed` row (A, the claimed agent, the PR number);
    - an activity line labels the claim as agent text.
  - `a PR opened by the owner is nobody's task`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** `feat: a pull request is attributed to the App that opened it (SR-E-12)`.

---

### Task 6: No secret values into sandboxes (SR-E-13, D2), and the other agent gates

**Files:**
- Modify:
  - `server/sessions.ts` (no `--env-file`, no env loading, for every agent);
  - `server/commands.ts` (`openEnvFile` refused; `sendMessage`, `resolveActionItem` and `resolveAccess` notes checked);
  - `src/ui/settings/SandboxSettings.tsx` (App variables explains D2);
  - `server/planner.ts` (nothing new; the merge rule test only).
- Test: `server/agentGates.m0e.test.ts`

**Interfaces:**
- Uses `hasCredentialShape(text: string): boolean`, already exported from `server/company/audit.ts`.
- `workspace.ts` reason `mcp-server`.

- [ ] **Step 1: Write the failing tests**
  - `SR-E-13 [T-S3.5] an agent started while its env file exists gets no --env-file`:
    - sandbox and Local mode;
    - the launch spec has no env file;
    - an activity line says the file was not passed (D2);
    - the file itself is untouched.
  - `SR-E-13 [T-S3.6] a message or answer to an agent that looks like a key is refused`:
    - a `ghp_…` value in `sendMessage`, an action item's note and an access answer;
    - each is refused with `message.refused` (`secret-shape`, never the text);
    - nothing is typed into the session.
  - `SR-E-08 [T-S3.4] merge.by changes only with the PIN`: from a supervisor, without the PIN and from HQ, refused and audited; the workflow is read back unchanged.
  - `SR-E-06 [T-S3.2] …`: rename M0-D2's "a company-level agent is never started in Local mode" to carry the id. The test is unchanged.
  - `a company-level agent with an MCP server grant does not start` (`mcp-server`; PR #9 finding 5: an MCP server can hold a GitHub token).
  - `SR-E-15 [T-S3.7] a new agent's allow list is empty`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** `feat: no secret value reaches a sandbox (D2); remaining agent gates`.

---

### Task 7: The hook secret leaves the command line

**Files:**
- Modify: `server/agentFiles.ts`, `server/adapters.ts`, `server/lib/agentFs.ts`
- Test: `server/agentFiles.test.ts` (new), `server/lib/agentFs.test.ts` (new)

**What it does** (carry-forward rows from PR #2 and M0-B's final review):
- The hook command no longer holds the secret.
  - Sandbox: `curl … -H @<folder>/.claude/hq-hook-auth`.
  - Windows Local: `node .jsmhq-hook.mjs <url> <auth file>`, and the script reads the file.
- The auth file (`Authorization: Bearer <secret>`) is written 0600 and git-excluded with HQ's other files.
- `agentWrite` with a mode writes to a temporary file created with that mode, then renames it over the target. No moment exists where the secret sits in a 0644 file.

- [ ] **Step 1: Write the failing tests**
  - `no hook command holds the agent's secret`: every generated hook command, and the Codex config's hook lines, lack the secret.
  - `a hook reaches HQ with the secret read from its file`: the sandbox-form command run with `sh` against a fixture server; skipped where `sh` or `curl` is missing.
  - `rewriting a 0644 file with a secret never leaves it readable`: POSIX only. Pre-create the file 0644, write with `mode: 0o600`, and assert the mode after, plus that the write went through a rename. The inode changes.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Add the auth file to `HQ_OWN_FILES`, so a repo that commits it is refused (SR-D-07).
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck && npx tsx scripts/session-backend-test.ts`.
- [ ] **Step 5: Commit** `fix: the hook secret is read from a 0600 file, never the command line`.

---

### Task 8: M0-D2 leftovers and the docs

**What each item does** (carry-forward rows from PR #10):
1. **A renamed or transferred GitHub repo** (round 1, finding 1).
   - The `other-repo` refusal names a way back: `confirmProjectRepo(projectId)`, which takes the owner and the PIN.
   - It sets the stored `github` to the folder's current repo, writes `project.repo-confirmed`, and opens the project.
   - `how-it-works.md` describes the state.
2. **`Sessions.githubKeyFor` defaults to `"unknown"`** (round 1, finding 2). With D2, env files are never read for a start, so the env-file half of that finding is closed by Task 6.
3. **Add project shows progress** (round 1, finding 3). The dialog stays open, showing "Adding…", until the reply arrives.
4. **The import's link check covers the `.jsmhq` folder** (round 1, finding 4): the file's real path must sit inside the repo's real path.
5. **Concurrent `addProject` for one path opens one runtime**: a pending open is kept per id.
6. **An explicit `--repo` that is not a git repo** stops HQ with an error, even when the store has other projects.
7. **A project skipped as "inside HQ's home" is labelled with that reason** (`ProjectSummary.note`). A `select` of a project that isn't open answers with `projects.updated`.
8. **`Projects.add` and `registerStart` use `this.detect`.**
9. **`githubOf` accepts `www.github.com` and `ssh.github.com:443`.**
10. **Docs:**
    - `how-it-works.md` says a chosen monorepo subfolder is refused for any tracked agent-settings file in the repo, a sibling folder's included;
    - GitHub identities, protection and the Local-mode caveat;
    - getting-started: removing the global `github` key, and creating each agent's identity.

**Files:** `server/projects.ts`, `server/startHq.ts`, `server/main.ts`, `server/hqSource.ts`, `server/repoConfigImport.ts`, `server/sessions.ts`, `server/commands.ts`, `src/ui/setup/AddProjectDialog.tsx`, `src/data/types.ts`, docs. Test: `server/leftovers.m0d2b.test.ts`.

- [ ] **Step 1: Write the failing tests**, one per item 1–9. Titles:
  - `a renamed repo can be confirmed with the PIN, and only with it`;
  - `githubKeyFor is unknown until wired`;
  - `add project shows progress until the reply`;
  - `a linked .jsmhq folder is not read`;
  - `two adds of one path open one runtime`;
  - `an explicit --repo that is not a repo stops HQ`;
  - `a project inside HQ's home is labelled so`;
  - `selecting a project that is not open answers with the list`;
  - `add and the start repo use the injected detect`;
  - `githubOf reads www and ssh-443 forms`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the items and the docs.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck && pnpm build`.
- [ ] **Step 5: Commit** `fix: M0-D2 leftovers (renamed repo, add progress, link check, concurrent add) and GitHub docs`.

---

## Exit check for M0-E

On `NdururiJr/CanoeneyLabsWebste`, with HQ on Windows and a throwaway HQ home.

**Owner steps before the check:**
- the first commit to `main`, with CODEOWNERS as in the values table;
- Create and Install for two agents' Apps (`lead`, `ana`);
- name one of the owner's private repos for SR-E-04.

**The checks:**
1. **Repo guard.** `applyRepoGuard` with the PIN, then `checkRepo` reports no finding.
2. **SR-E-01 and SR-E-03.** With `ana`'s token, `ana` opens a PR from `ana/x`, and `lead`'s App approves it. `gh pr merge` with `ana`'s token is refused, and the PR stays unmergeable without the owner's review.
3. **SR-E-02.** With `ana`'s token, each of these is refused:
   - pushing to `main`;
   - force-pushing `ana/x` over a protected history (the ruleset);
   - deleting `main`;
   - `PATCH /repos/{repo}`;
   - `GET /repos/{repo}/actions/secrets`;
   - pushing `.github/workflows/x.yml`.
4. **SR-E-03.** With `ana`'s token, pushing to `lead/y` is refused.
5. **SR-E-04.** With `ana`'s token, reading the named private repo is refused.
6. **SR-E-07.** Pause `ana`; its token is refused by the next API call.
7. **SR-E-10.** Covered by step 3's refused workflow push. The settings check confirms the read-only workflow token as the second layer.
8. **SR-E-12.** `ana`'s PR on a branch named `lead/z` is attributed to `ana`.

The PR description reports each step and its result. Whether the loopback `redirect_url` or the pasted-code fallback was used is recorded too.

**Not in this check:** a token delivered into a real sandbox and refreshed there; that needs `sbx` (M0-G, Linux host). The unit tests cover the delivery calls.

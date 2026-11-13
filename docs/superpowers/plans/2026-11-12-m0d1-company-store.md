# M0-D1 The company store holds the configuration, and agents ignore repo-carried settings: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nothing committed to a managed repo changes what an agent is, what it may do, or what it is told.
- HQ's configuration and task board live in the company store.
- They change only through the owner, or through an approved decision. A change that relaxes a control needs the owner's PIN.
- Agents start without the repo's own agent settings. They read the project's `CLAUDE.md` only as the copy the owner last approved.

**Architecture:**
- **Store.** Migration 006 adds:
  - project settings and per-agent settings;
  - boards and tasks;
  - the owner-approved project notes.
  - Per-agent grants use the `permissions` table from M0-A.
- **Writes.** `ProjectSettings` is the only code that writes configuration.
  - Every write names its authority: the PIN, a decision, the owner's session, or HQ itself.
  - One classifier says which changes relax a control. Such a change is refused unless its authority is the owner's PIN or an approved decision.
  - The dashboard's PIN rules come from the same classifier, so the two cannot drift apart.
- **Reads.**
  - HQ builds the dashboard's `HqConfig` view from the store, at startup and after every write.
  - `.jsmhq/config.json` and `.jsmhq/plan.json` are read in one place only: a one-time import that the owner confirms with the PIN.
- **Agents.**
  - HQ's clones use git's sparse checkout. The repo's `CLAUDE.md`, `AGENTS.md`, `ROLE.md`, `.claude/`, `.mcp.json`, `.agents/` and `.codex/` never appear in an agent's folder.
  - The project's `CLAUDE.md` reaches agents only inside HQ's generated role, as the copy the owner last approved.

**Tech stack:** Node ≥ 22.13 (`node:sqlite`), TypeScript, React 18, and git ≥ 2.35 for `sparse-checkout set --no-cone`. No new packages.

**Spec:** `docs/superpowers/specs/2026-11-09-agentic-company-m0-m1-design.md`:
- M0.11: permissions, company configuration and task state move out of the repo.
- §2b, surface S7. The plan PR extends S7 to the agent configuration files, as D1 decided.
- The §6 exit item "company configuration and `plan.json` live in the company store".

Requirements: `docs/security/threat-model-m0.md` §3.3: SR-D-01, 02, 03, 04, 07, 08, 10 and 11. M0-D2 covers SR-D-05, 06 and 09. Order and carry-forward: `docs/superpowers/plans/2026-11-11-m0-foundations-overview.md`.

## How M0-D is split

The owner chose full multi-project for M0-D on 2026-11-12: one running HQ manages several repos, with a project switcher. That is two separate pieces of work, so M0-D becomes two plans, each reviewed and merged separately:

| Plan | Covers |
|---|---|
| **M0-D1 (this plan)** | M0.11: the configuration and the task board move to the company store. S7 and D1: agents ignore the agent configuration a repo carries. The M0-D carry-forward items |
| **M0-D2** (written after D1 merges) | M0.12: one HQ serves many projects, with a project switcher; HQ's own fork cannot be a project (SR-D-05); the company website is the first project. M0.14: company-level workspaces (SR-D-06). Each project's boards, tasks and messages are isolated from the others (SR-D-09) |

D1 keys every new table by project id. D2 therefore adds projects without moving this data a second time.

## Owner decisions this plan relies on

- **D1 (2026-11-12), as recommended.** HQ supplies company agents' instructions, settings, MCP servers and skills itself.
  - The repo's `CLAUDE.md` and `AGENTS.md`, `ROLE.md`, `.claude/`, `.mcp.json` and committed skills stay in the repo, but agents don't load them.
  - For `CLAUDE.md` (the project notes), HQ keeps a copy the owner approved. A changed repo copy reaches agents only after the owner approves it.
  - CODEOWNERS review on those paths is a second lock. It lives in each managed repo's `.github/`, so the owner adds it (an owner-track row, with M0-E's branch protection).
- **The `hq/auth` actor for audit rows written before login was accepted (2026-11-12).** Nothing changes in code.
- **M0-D scope (2026-11-12): full multi-project,** split as above.

## Where this plan reads the spec narrowly (for the reviewer)

- **"Only the owner, or an approved decision, can change them" (M0.11, SR-D-03) follows the direction rule of §9 item 2.**
  - A change that relaxes a control needs the owner's PIN or an approved decision. The classifier is in "Values this plan fixes".
  - A change that tightens a control, and a cosmetic change, needs only the logged-in owner. It is audited the same way, with `authority: "session"`.
  - This settles part of a PR #5 carry-forward: turning review off and changing the project's GitHub repo now need the PIN. `forwardPort` is not configuration, so it stays with the M1 decision-engine plan.
- **The decision authority is accepted, though no decisions exist yet.**
  - The store accepts `{ via: "decision" }` only for a `decisions` row whose status is `approved`.
  - The tests seed such rows. Nothing in M0-D1 creates decisions; M1.4 does.
- **The repo export.**
  - HQ stops writing `.jsmhq/config.json` and `.jsmhq/plan.json`.
  - The readable export is the existing opt-in `docs/plan.md`, which HQ writes and never reads.
  - Files a repo already has stay where they are, and HQ reads them only in the import (SR-D-02).
- **The project id comes from the store, never from the file.**
  - For a repo, HQ uses the store row whose root is that repo. Every install that ran M0-B or later has one, because M0-B's `ensureProject` registered it.
  - With no such row, the id is the folder name as a slug, with `-2`, `-3` and so on appended if a repo that still exists already uses it.
  - The import ignores `project.id` in the file. Spec M0.17 notes there are no installs in production. An older install whose ids differ keeps its old sandboxes under the old names, and `sbx rm` removes them.
- **SR-D-04 applies to a folder someone chooses.**
  - HQ's own clone, `~/.jsmhq/<project>/<agent>`, sits inside HQ's home by design.
  - A chosen `workspacePath` is refused if it is inside the store or HQ's home, or contains either, links and junctions included.
- **SR-D-07 uses sparse checkout, not command-line flags.**
  - Sparse checkout keeps the files off the agent's disk, so neither Claude Code nor Codex can load them, and CI can test it with real git.
  - Claude Code's `--setting-sources` could add a second layer. Whether HQ's own hooks still run with project settings turned off has not been checked, so the overview carries that check to M0-G, on the Linux host.
  - An agent can turn sparse checkout off in its own folder. That changes only its own instructions, which it can already do (T-S6.10, accepted). What D1 closes is one merged PR changing every agent at once.
- **A chosen folder is checked, never changed.** HQ refuses to start an agent in a chosen folder that holds the repo's agent configuration. It does not hide files in the owner's own checkout.
- **`AGENTS.md` is not a second source of project notes.** The approved `CLAUDE.md` copy goes into the role for both CLIs.
- **SR-D-10 and secret names.**
  - HQ applies no secret when a session starts: sbx holds keys per sandbox.
  - A `secret-name` grant records which key the owner set for which agent.
  - The test covers network rules and MCP servers. Keys set for every sandbox have no agent row; removing global consequential keys is M0-E's work.
- **SR-D-08 and the CTO.** The CTO keeps `update_task` with any status, because §2a gives it that tool. A builder's `set_my_status done` is refused, and the task stays as it was.
- **SR-B-12's task-state half closes here.** A task row is written inside the tool call's transaction, before HQ's memory changes. A write that fails changes nothing.

## Global constraints

- Keep the existing stack (spec §7). No new packages.
- Anti-goal §4: no secret value in a log, an alert or the audit trail. Grants record service names, domains and MCP server names, never values. The audit sink's value guard (M0-B) still applies.
- Anti-goal §4: existing capabilities must not regress. On Ubuntu and Windows these must pass (macOS dropped from CI by the owner on 2026-11-13, PR #7): `pnpm typecheck`, `pnpm test`, `pnpm build`, `npx tsx scripts/session-backend-test.ts` and `scripts/smoke-test.mjs`.
- Every enforcement test follows the threat model's rules (§3 preamble):
  - the refusal is checked;
  - its audit row is checked, with the authenticated caller as the actor;
  - the targeted state is read back unchanged;
  - the title is `SR-D-nn [T-…] …`.
- Times come from the injected `Clock`.
- No product name in new code (M0-H). Old paths are reached through the existing constants (`HQ_DIRNAME`).
- Migration 006 is frozen literal SQL, as migration 001's header requires. The `schema.test.ts` tripwire is extended to every new CHECK list.
- `.github/`, `CLAUDE.md` and `.claude/settings.json` of this repo are not touched.

## Values this plan fixes

| What | Value |
|---|---|
| Changes that relax a control (need the PIN or a decision) | Granting `network-allow`, `mcp-server`, `secret-name`, `tool` or `skill`. Revoking `network-deny`. Turning `review.enabled` off; any change to `review.tool` or `review.command`. `merge.by` to `lead`. Any `deploy` change except turning it off. Changing the project's `github` repo or its `stack`. An agent's `mode` to `local`; any change of `cli`, `roleMd` or a non-empty `workspacePath`. Adding an agent. Importing a repo config. Approving project notes |
| Everything else (needs only the owner's session) | The reverse of each item above, plus names, colours, display roles, models, sandbox size, `officeName` and `exportPlan` |
| Authorities | `{ via: "pin", humanId }`, `{ via: "decision", decisionId }`, `{ via: "session", humanId }`, `{ via: "hq" }`. HQ itself may only revoke. `pin` and `session` must name a human whose role is `owner` |
| Sparse patterns (non-cone) | `/*`, `!CLAUDE.md`, `!CLAUDE.local.md`, `!AGENTS.md`, `!AGENTS.override.md`, `!ROLE.md`, `!.mcp.json`, `!.claude/`, `!.agents/`, `!.codex/` |
| HQ's own files a repo may not commit | `.jsmhq-role.md`, `.jsmhq-hook.mjs`, `.claude/settings.local.json`, `.claude/hq-mcp.json`, `.codex/config.toml` |
| Project notes | `CLAUDE.md` at the root of the project's repo (the owner's checkout). Only a regular file (a link is not offered), at most 20,000 characters, identified by the SHA-256 of its bytes |
| New audit actions | `settings.changed`, `settings.refused`, `permission.granted`, `permission.revoked`, `settings.imported` (with the previewed `sha256` and counts), `project-notes.approved`. Each `data` carries `authority`; a decision also fills the row's `decision_id` |

## Review focus

1. **Upgrading an install from M0-C.**
   - The store already has agent rows, but no settings, and `.jsmhq/config.json` exists.
   - The dashboard must offer the import. Until the owner confirms it, agents show with default settings and no grants. Nothing reads the file until the owner asks for the preview, and the import writes only what the preview showed.
   - Test: Task 3 `an upgraded store offers the import and grants nothing before it`.
2. **An existing clone where an agent edited `CLAUDE.md`.** Sparse checkout leaves a modified file on disk. HQ must refuse to start the agent, not load the file quietly.
   - Test: Task 5 `a clone with local changes to CLAUDE.md does not start`.
3. **A repo that commits `.claude/settings.local.json`.** HQ's file holds the agent's secret, and over a tracked path it could be committed. HQ must refuse.
   - Test: Task 5 `a repo that commits one of HQ's own files is refused`.
4. **A grant sbx refuses.** Today HQ adds the domain, syncs, and takes it back off when sbx does not apply it. The rollback must leave no active grant behind.
   - Test: Task 3 `a grant sbx refuses is revoked again`.
5. **Windows paths.** A junction to `~/.jsmhq`, or a path that differs from it only in letter case, used as `workspacePath`.
   - Test: Task 4 `SR-D-04 [T-S7.6] a chosen folder that is, holds, or sits inside the store or HQ's home is refused` (its junction and case-variant cases).

---

### Task 1: Project state in the company store, and its one writer

**Files:**
- Create: `server/company/schema/006_project_state.ts` (register `m006`)
- Create: `server/company/authority.ts`, `server/company/projectSettings.ts`, `server/company/projectSettings.test.ts`
- Modify: `server/company/index.ts` (`Company.settings`), `server/company/schema.test.ts` (tripwire), `server/store.ts` (`defaultWorkflow(repo)` and `newAgent` stay; nothing else uses the file functions after Task 3)
- Create: `docs/adr/0008-company-store-holds-configuration.md`

**Interfaces:**
- Migration 006 (literal SQL):
  - `project_settings(project_id TEXT PRIMARY KEY REFERENCES projects(id), github TEXT NULL, workflow_json TEXT NOT NULL, stack_json TEXT NULL, office_name TEXT NULL, export_plan INTEGER NOT NULL DEFAULT 0 CHECK (export_plan IN (0, 1)), imported_at TEXT NULL, updated_at TEXT NOT NULL)`.
  - `agent_settings(agent_id TEXT PRIMARY KEY REFERENCES agents(id), display_role TEXT NOT NULL, color TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL CHECK (mode IN ('sandbox', 'local')), workspace_path TEXT NULL, role_md TEXT NOT NULL, cpus INTEGER NULL, memory_gb REAL NULL, updated_at TEXT NOT NULL)`.
  - `boards(project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'planned', 'done')), ord INTEGER NOT NULL, PRIMARY KEY (project_id, id))`.
  - `tasks(project_id TEXT NOT NULL, id TEXT NOT NULL, board_id TEXT NOT NULL, title TEXT NOT NULL, owner_agent_id TEXT NULL REFERENCES agents(id), status TEXT NOT NULL CHECK (status IN ('todo', 'in-progress', 'in-review', 'done', 'blocked')), needs_json TEXT NOT NULL DEFAULT '[]', pr_number INTEGER NULL, description TEXT NOT NULL DEFAULT '', files_json TEXT NOT NULL DEFAULT '[]', done_when TEXT NOT NULL DEFAULT '', note TEXT NULL, created_by TEXT NULL, ord INTEGER NOT NULL, PRIMARY KEY (project_id, id), FOREIGN KEY (project_id, board_id) REFERENCES boards(project_id, id))`.
  - `project_notes(project_id TEXT NOT NULL REFERENCES projects(id), version INTEGER NOT NULL, sha256 TEXT NOT NULL CHECK (length(sha256) = 64), content TEXT NOT NULL, approved_by_human_id TEXT NULL REFERENCES humans(id), approved_by_decision_id TEXT NULL REFERENCES decisions(id), approved_at TEXT NOT NULL, PRIMARY KEY (project_id, version), CHECK (approved_by_human_id IS NOT NULL OR approved_by_decision_id IS NOT NULL))`, append-only (the `appendOnly` triggers pattern of 001).
- `server/company/types.ts`: `type PermissionKind = "network-allow" | "network-deny" | "mcp-server" | "secret-name" | "tool" | "skill"`, the kinds in migration 001's CHECK.
- `authority.ts`:
  - `type Authority` as in the values table.
  - `type ConfigChange =`
    - `{ kind: "grant" | "revoke"; permission: PermissionKind; value: string }`
    - `| { kind: "workflow"; before: WorkflowConfig; after: WorkflowConfig }`
    - `| { kind: "project"; field: "name" | "officeName" | "exportPlan" | "github" | "stack"; before: unknown; after: unknown }`
    - `| { kind: "agent"; field: "displayRole" | "color" | "model" | "mode" | "cli" | "workspacePath" | "roleMd" | "resources"; before: unknown; after: unknown }`
    - `| { kind: "agent-added" | "agent-retired" | "import" | "notes-approved" }`.
  - `relaxes(c: ConfigChange): boolean`, exactly the values table.
  - `class AuthorityError extends Error { reason: "pin-or-decision-required" | "not-owner" | "decision-not-approved" | "hq-cannot-grant" }`.
- `ProjectSettings`:
  - `constructor(db: CompanyDb, clock: Clock, audit: AuditSink, agents: AgentRegistry)`.
  - `has(projectId): boolean`: a `project_settings` row exists.
  - `create(projectId, init: { github: string | null; workflow: WorkflowConfig; stack?: StackConfig; officeName?: string }, by: Authority): void`. This counts as an `import` change, so it needs the PIN.
  - `view(projectId, runtime: { path: string; hqPort: number }): HqConfig`.
    - `team` holds the project's agents that are not retired, in `created_at` order.
    - `isLead` is true when the agent's role is `cto`.
    - `sandbox.allow`, `deny`, `mcp` and `skills` come from the active grants.
    - An agent with no settings row gets `DEFAULT_AGENT_SETTINGS`: sandbox mode, the CLI's default model, and a `roleMd` from `newAgent`.
  - `updateWorkflow(projectId, patch: WorkflowPatch, by)`, `updateProject(projectId, patch, by)` and `updateAgent(companyId, patch: AgentSettingsPatch, by)`. `cli` is written to `agents.cli`.
  - `addAgent(projectId, a: { id; name; cli; displayRole; color; mode; model }, role: "cto" | "builder", by, managerId?): RegisteredAgent`. It writes the `agents` row through `AgentRegistry.register`, plus a settings row, and **no grants**.
  - `grants(companyId, kind?: PermissionKind): { kind: PermissionKind; value: string }[]`.
  - `grant(companyId, kind, value, by): boolean` and `revoke(companyId, kind, value, by): boolean`. Each returns false when there was nothing to change.
  - `setGrants(companyId, kind, values: string[], by): { added: string[]; removed: string[] }` diffs the active grants and checks each change in its own direction.
  - Every write runs in one `immediate` transaction:
    1. check the authority: the human's role is `owner`; a decision's status is `approved`;
    2. write the change;
    3. append the audit row.
  - A refusal appends `settings.refused` (actor: the human, or `hq`; `data`: `{ change: c.kind, field?, reason }`), outside the failed transaction, then throws `AuthorityError`.

- [ ] **Step 1: Write the failing tests**
  - `migration 006 creates the project tables, and the tripwire covers their CHECK lists`. Grow `AgentMode`, `BoardStatus` and `TaskStatus` in a scratch copy, and check that the tripwire names each one.
  - `SR-D-03 [T-S7.1] each relaxing write is refused without the PIN or an approved decision`.
    - Table-driven over every relaxing item in the values table, with `{ via: "session", humanId: "owner" }`.
    - Each throws `AuthorityError("pin-or-decision-required")` and writes a `settings.refused` row whose actor is `owner`.
    - A dump of `project_settings`, `agent_settings`, `agents` and `permissions` is unchanged.
  - `SR-D-03 [T-S7.1] a pending or denied decision authorises nothing; an approved one does, and its row names it`. The row's `decision_id` is set and `data.authority` is `"decision"`.
  - `SR-D-03 [T-S7.1] HQ itself can revoke but never grant`.
  - `SR-D-03 [T-S7.1] a supervisor changes nothing`. Every write with a supervisor's id gives `not-owner`, and the state is unchanged.
  - `tightening and cosmetic changes need only the owner's session, and their rows say "session"`: review on, `merge.by: human`, a deny added, an allow revoked, a rename and a colour change.
  - `SR-D-11 [T-S4.8] a new agent starts with no grants`. The CTO holds `network-allow` and `mcp-server` grants; after `addAgent`, `grants(new)` is empty.
  - `view builds the dashboard config from the store alone`: the team order, `isLead` from the role, lists from grants, and retired agents left out.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the new tests fail; the rest pass.
- [ ] **Step 3: Implement** the migration, `authority.ts` and `ProjectSettings`. Write ADR 0008 covering:
  - what moved to the store;
  - the authority model and the direction classifier;
  - why the repo files are never read back.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`. Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat(company): project settings, grants and boards in the store, written only with a named authority`.

---

### Task 2: The task board in the company store

**Files:**
- Create: `server/company/planStore.ts`, `server/company/planStore.test.ts`
- Modify: `server/company/index.ts` (`Company.plans: PlanStore`), `server/planner.ts`, `server/hub.ts` (`planChanged` writes only the opt-in `docs/plan.md`), `server/mcp.test.ts`, `src/data/types.ts` (`Task.createdBy?: string`)

**Interfaces:**
- `PlanStore`:
  - `constructor(db: CompanyDb)`.
  - `load(projectId): { boards: Board[]; tasks: Task[] }`. Tasks come back in `ord` order. `ownerId` is the project-local agent id.
  - `putBoard(projectId, board: Board): void` and `putTask(projectId, task: Task): void` are upserts. They join the caller's transaction when one is open (`db.inTransaction`) and otherwise run their own.
- `Planner` constructor: `(hub, inbox, ctoLookup, opts: { plans: PlanStore; projectId: string; roleOf: (agentId: string) => RoleId | null })`.
  - Every mutation works out the next board or task, calls `putBoard` or `putTask`, and only then changes memory and emits.
  - `createTask` sets `createdBy` to `byId`.
  - `setStatus(agentId, "done")` for a builder throws `SELF_DONE`: "HQ marks a task done when its PR is merged. Call set_my_status in-review with the PR number."
  - `assign()` quotes the task's title with `hub.name(task.createdBy ?? null)` as its author (PR #5 carry-forward).

- [ ] **Step 1: Write the failing tests**
  - `boards and tasks come back from the store after a restart, with plan.json deleted`.
  - `SR-B-12 [T-X1.3] a task change whose store write fails changes nothing`.
    - Make `putTask` throw, then call `update_task` through MCP.
    - The result is an error, the in-memory task and the stored row are unchanged, and the call's row has `outcome: "error"`, not `"ok"`.
  - `SR-D-08 [T-S7.7] a builder's set_my_status done leaves the task in review`.
    - A builder's task is `in-review` with a PR number.
    - `set_my_status done` returns the `SELF_DONE` error, the memory and the store still say `in-review`, and the `tool.called` row has `outcome: "error"`.
  - `the CTO can still close a task with update_task`.
  - `a merged PR marks its task done in the store` (the `githubSync` path).
  - `an assigned task's title is quoted as written by whoever created it`. The CTO creates it and the owner assigns it: the quote's author is the CTO.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: tasks live in the company store and change with their audit row; builders cannot close their own task`.

---

### Task 3: HQ runs on the store, and the repo files have no effect

**Files:**
- Modify: `server/main.ts`, `server/hub.ts`, `server/store.ts` (remove `loadConfig`, `saveConfig`, `loadPlan` and `savePlan`)
- Modify: `server/company/agents.ts`:
  - `projectForRoot(root): string | null`;
  - `ensureProject({ name, root }): string`, which picks the id as the reading notes say;
  - `ProjectIdTakenError` is removed;
  - `syncFromConfig` is kept for the import only.
- Create: `server/repoConfigImport.ts`, `server/repoConfigImport.test.ts`
- Modify: `server/commands.ts`, `server/sbx.ts` (injectable `exec`, as `SbxMcp` has; `syncRules` reads grants from the store), `server/access.ts`, `server/sbxMcp.ts`, `server/dashboard.ts` (`CommandCtx.pin: boolean`), `server/sessions.ts`
- Modify: `server/testing/hqFixture.ts` (seed through `ProjectSettings`; a `writeRepoFiles` helper), `scripts/smoke-test.mjs`
- Modify: `src/data/types.ts` (`OfficeSnapshot.importable?: true`, `OfficeSnapshot.importPreview?: { sha256: string; lines: { text: string; fromFile: string[] }[]; tasks: number }`), `src/data/source.ts`, `src/data/ws/wsSource.ts`, `src/data/mock/mockSource.ts`, `src/ui/setup/WelcomeModal.tsx`
- Create: `src/ui/setup/ImportPreview.tsx` and its markup test
- Modify: `README.md` (the upgrade step), `docs/how-it-works.md` ("Where HQ keeps things")

**Interfaces:**
- Startup:
  1. `const slug = company.agents.ensureProject({ name: repo.name, root: repo.root })`.
  2. The welcome screen shows while `!company.settings.has(slug)`.
  3. `importable` is set when `.jsmhq/config.json` exists. Only `existsSync` is used here; the file is never read.
  4. `Hub` takes `configSource: () => HqConfig`. `hub.configChanged()` rebuilds `snap.config` from the store and emits it, and it no longer writes any file.
- Every write in `commands.ts`, `sbx.ts`, `access.ts` and `sbxMcp.ts` goes through `company.settings` with `authorityOf(ctx)`: `{ via: ctx.pin ? "pin" : "session", humanId: ctx.actor.id }`. The PIN rules of these commands become `pin: (args) => relaxes(changeOf(args))`, each with its own `changeOf`:
  - `updateWorkflow`, `updateProject`, `updateAgent`, `updateStack`, `updateSandbox`;
  - `addAgent`, which no longer copies the lead's sandbox;
  - `setAgentMcp`, `answerApproval`, `resolveAccess`, `setSecret` and `removeSecret`.
- `Sbx`:
  - `constructor(hub, company, opts?: { exec?: typeof run })`.
  - `wantedRules(agentId): Set<string>` builds the `"allow host"` and `"deny host"` entries from `company.settings.grants` only, and `syncRules` applies exactly that set.
  - `SbxMcp.attachAll` reads the `mcp-server` grants the same way.
- A rollback after sbx refuses a rule revokes the grant with `{ via: "hq" }`.
- `completeWelcome` (PIN) calls `settings.create` and `settings.addAgent`.
- `repoConfigImport.ts` is the only reader of `.jsmhq/config.json` and `.jsmhq/plan.json`. The owner sees what an import will write before the PIN, and the PIN binds to exactly that (D3, as `approveProjectNotes` does):
  - `readImport(root): { sha256: string; plan: ImportPlan }`. It reads each file's bytes once. `sha256` is the SHA-256 of `JSON.stringify({ config: <hex SHA-256 of config.json>, plan: <hex SHA-256 of plan.json> | null })`. `plan` is parsed from those same bytes:
    - `changes: ConfigChange[]`: every write the import will make. That means the workflow, stack, office name, `exportPlan` and `github` (from `project.repo`); each agent, with `syncFromConfig`'s first-import rule for the CTO; each agent's settings; and the grants from `sandbox.allow`, `sandbox.deny`, `mcp` and `skills`.
    - `boards` and `tasks`.
  - `previewImport(plan): ImportLine[]`, where `ImportLine = { change: ConfigChange; text: string; fromFile: string[] }`. It covers exactly the changes in `plan.changes` for which `relaxes()` is true, in the classifier's order: who the CTO is; each agent added, with its mode, CLI, chosen folder and role text; every grant; `merge.by`; review; deploy; the repo; the stack. `fromFile` holds the values taken from the file, such as names, domains, paths and role text. Because the preview and the import use the same `plan`, the preview cannot leave out a write.
- `previewRepoImport()`: owner session, no PIN, and it writes nothing. It is refused once `settings.has(slug)`. It sets `importPreview` on the owner's snapshot, with each line's `text` and `fromFile` (the `change` stays on the server). `viewFor` drops it for the supervisor.
- `importRepoConfig({ sha256 })`: owner, `pin: true`.
  - It is refused when `settings.has(slug)`, since the import happens once.
  - It calls `readImport` again. If that hash differs from `sha256`, the files changed after the owner saw them. The import is then refused with an activity line and a `settings.refused` row (`reason: "import-changed"`), and the store is unchanged. Otherwise it applies that read's `plan`, the same bytes it hashed, with the PIN authority.
  - Each setting and grant gets its own `settings.changed` or `permission.granted` row. The import then appends `settings.imported` with `{ sha256, counts }`.
- `resolveAccess` with `everyone` writes one `network-allow` grant for each agent that exists at that moment, each with its own row. An agent added later gets none (SR-D-11). D5, the width of a grant, is still the owner's to decide before the M1 plan and may remove this answer.
- `Sessions.start` for an agent with no store row says "This agent is not in the company store. Add it from the dashboard." (M0-B carry-forward: the restart wording).

- [ ] **Step 1: Write the failing tests**
  - `SR-D-01 [T-S7.1 T-S7.2 T-S7.4] the repo's config and plan change nothing, at startup or while running`.
    - Write a `config.json` that makes a builder the lead, adds an allowed domain, sets Local mode, sets `merge.by: lead` and turns review off. Write a `plan.json` that marks every task done.
    - Dump the store and `hub.snap` (config, tasks and boards), restart the fixture, and dump them again. The two are equal.
    - The CTO is unchanged, and `wantedRules` (below) is unchanged.
  - `SR-D-02 [T-S7.4] only the import reads the repo's config files`. A source scan of `server/` (tests excluded) finds `config.json` and `plan.json` only in `repoConfigImport.ts`.
  - `SR-D-02 [T-S7.4] the import is refused without the PIN, and a second time`.
    - Without the PIN: `pin-required`, a refused row, and the store unchanged.
    - Once settings exist: refused (an activity line and a `settings.refused` row), and the store unchanged.
  - `the import carries the team, grants, workflow and tasks into the store`. Each setting and grant has its own row, and `settings.imported` carries the previewed `sha256`.
  - `SR-D-02 [T-S7.1 T-S7.4] the import preview names every relaxing change it will write`.
    - The file sets a builder to `mode: "local"`, allows `docs.example.com` and sets `merge.by: "lead"`. The preview's lines name all three.
    - After the import, every `settings.changed` and `permission.granted` row whose change `relaxes()` matches one preview line, and there are as many rows as lines.
  - `SR-D-02 [T-S7.4] an import of files that changed after the preview is refused`.
    - Preview, then add an allowed domain to the file, then import with the previewed hash.
    - Result: refused, a `settings.refused` row with `reason: "import-changed"`, and the store unchanged.
  - `the import preview shows the file's values as agent text`. A markup test: `textOutside` holds none of an agent name, a domain or the role text from the file.
  - `the supervisor's view has no import preview`.
  - `an upgraded store offers the import and grants nothing before it`.
    - Agent rows exist, but no settings, and the file exists.
    - The snapshot has `welcome` and `importable`, and the agents have no grants.
    - Nothing reads the file until the owner asks for the preview: spy on `fs.readFileSync` for that path.
  - `SR-D-03 [T-S7.1] each relaxing command asks for the PIN, and the store refuses it without one`.
    - Through `Dashboard.dispatch`, every relaxing command without a PIN gives `pin-required`.
    - Calling its `run` directly with `ctx.pin = false` throws `AuthorityError`.
  - `SR-D-10 [T-S4.7 T-S7.1] a session started with no grants gets no allow rule beyond HQ's port`.
    - The fake `exec` records every `sbx policy` call.
    - With an empty `permissions` table and a config file full of domains, starting an agent issues only `localhost:<port>` and `host.docker.internal:<port>`.
    - `Sbx.wantedRules(agentId)` is empty.
  - `SR-D-11 [T-S4.8] an agent added from the dashboard gets none of the lead's grants`. Also: after an access request answered for `everyone`, each existing agent has the grant, and an agent added afterwards does not.
  - `a grant sbx refuses is revoked again`. The fake `exec` fails the allow; afterwards `grants(agent)` has no active `network-allow` for that host, and a `permission.revoked` row with `authority: "hq"` exists.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
  - When `importable` is set, the welcome modal shows **Review import from .jsmhq/config.json**, which sends `previewRepoImport`.
  - `src/ui/setup/ImportPreview.tsx` lists the lines. Every value from the file is shown through `AgentText`, labelled ".jsmhq/config.json". Role text is preformatted, not rendered markdown.
  - Under the list, **Import with PIN** sends `importRepoConfig({ sha256 })` through `sendWithPin`.
  - The smoke test enrolls the owner and completes the welcome with the PIN.
  - Carry-forward (CodeRabbit on PR #1): the smoke test kills the second HQ when its 60 s wait times out.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck && pnpm build && npm pack --pack-destination pack && node scripts/smoke-test.mjs pack/*.tgz 7431`. Expected: all pass. On the smoke test, delete any old tarball in `pack/` first.
- [ ] **Step 5: Commit** `feat: HQ runs on the company store; repo config is read only by a PIN-confirmed import`.

---

### Task 4: Workspaces, sessions and the M0-B and M0-C leftovers

**Files:**
- Modify: `server/workspace.ts`, `server/company/home.ts` (`hqHome()`), `server/workspace.test.ts`
- Modify: `server/sessions.ts`, `server/sessions.identity.test.ts`, `server/agentAuth.ts` or `server/mcp.ts` (re-read the status), `server/mcp.test.ts`
- Modify: `server/agentAuth.test.ts` (SR-B-03), `server/hooks.test.ts` (SR-B-19), `server/identity.e2e.test.ts` (SR-B-10)
- Modify: `server/commands.ts` (`authMcp` is `localOnly`), `server/sbx.ts` (activity lines on failure), `server/main.ts` (`quit()` flushes the dashboard)

**Interfaces:**
- `hqHome(): string`: `HQ_HOME`, or `join(homedir(), HQ_DIRNAME)`. Tests set `HQ_HOME`.
- `workspaceFor(agent, projectSlug, roots = { store: companyHome(), hq: hqHome() })`. A chosen `workspacePath` is refused when `isInside(dir, root) || isInside(root, dir)` for either root.
- `Sessions` serialises `start`, `stop`, `recreate` and `removeResources` per agent: `private lane(id, fn)`.
- The poll tick works out the workspace before it attaches. A refused folder is marked failed once and stays that way until the agent's settings change.
- `/mcp` refuses a paused or retired agent on every request, as it already does for the role.
- Activity lines for sbx failures name the action and never repeat sbx's text when that text contains an agent-chosen host. The agent's words stay in `quote`.

- [ ] **Step 1: Write the failing tests**
  - `SR-D-04 [T-S7.6] a chosen folder that is, holds, or sits inside the store or HQ's home is refused`, for each of:
    - the home itself, the store itself, and their parent (as `~` would be);
    - a folder inside each;
    - a symlink (a junction on Windows) to each;
    - on Windows, a case variant of HQ's home.
    - `ensureWorkspace` throws, and no clone is made.
  - `HQ's own clone inside HQ's home is allowed`.
  - Carry-forward: `a refused folder is marked failed once, not on every poll`.
  - Carry-forward: `stop during start leaves the agent stopped with no live secret`.
  - Carry-forward: `a paused agent's in-flight MCP request is refused`.
  - Carry-forward (stronger tests):
    - SR-B-03 starts the fixture on a fresh `HQ_HOME` and lists every file under it: none is named `agent-token`.
    - SR-B-19 lists by source scan every read of hook-reported state in `server/` (`.state`, `.note`, `lastHookAt`) and checks each against a fixed allow-list of display and delivery sites.
    - SR-B-10 adds `sessions.stop` to its run.
  - Carry-forward (PR #5): `authMcp is refused in a remote session`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck && npx tsx scripts/session-backend-test.ts`. Expected: all pass.
- [ ] **Step 5: Commit** `fix: refuse workspaces that hold HQ's records, serialise agent start and stop, and close the M0-B leftovers`.

---

### Task 5: Agents start without the repo's agent configuration (D1, SR-D-07 part 1)

**Files:**
- Create: `server/agentIsolation.ts`, `server/agentIsolation.test.ts`
- Modify: `server/workspace.ts` (clone without checkout, then isolate; check a chosen folder), `server/agentFiles.ts` (drop `adoptRoleFile`'s inclusion and `RoleExtras.ownRole`, but keep removing a `ROLE.md` that an older HQ generated), `server/adapters.ts` (one refusal for tracked HQ files, replacing the Codex-only check)
- Modify: `server/skills.ts` (`syncSkillsInto` reports what it skipped), `server/sessions.ts` (the activity line)
- Modify: `docs/adr/0008-company-store-holds-configuration.md` (an "Agents ignore repo-carried configuration" section)

**Interfaces:**
- `AGENT_CONFIG_PATTERNS: readonly string[]`, the sparse patterns from the values table.
- `isAgentConfigPath(rel: string): boolean`. True when the base name is one of the six files, or any path segment is `.claude`, `.agents` or `.codex`.
- `isolateClone(dir): Promise<void>`. Runs `git sparse-checkout set --no-cone --stdin` with the patterns. A failure throws "HQ needs git 2.35 or later to keep the repo's agent settings out of agent folders: <git's first line>".
- `agentConfigOnDisk(dir): Promise<string[]>`. Tracked paths (`git ls-files -z`) that match `isAgentConfigPath` and exist on disk (`lstat`).
- `trackedHqFiles(dir): Promise<string[]>`. The HQ file names from the values table that the repo tracks.
- `ensureWorkspace`:
  - For HQ's own clone: `git clone --no-checkout`, `isolateClone`, then populate the working tree. An existing clone is isolated again on every start.
  - For any folder: if `agentConfigOnDisk` is not empty, throw "<dir> has the repo's agent settings on disk (<first path>). HQ keeps them out of agent folders. Commit or discard the change in <dir>, then start again." For a chosen folder the message ends "Use an HQ-managed folder for this agent." instead.
  - If `trackedHqFiles` is not empty, throw: the repo commits `<path>`, which HQ writes with the agent's secret.
- A skill name the repo tracks wins, and the agent runs without HQ's skill of that name:
  - `syncSkillsInto` returns `{ installed: string[]; skipped: string[] }`. A path the repo tracks goes to `skipped`; today it is dropped silently.
  - With sparse checkout the repo's copy is not on disk either, so the agent has neither copy.
  - `prepareSkills` passes `skipped` on. `Sessions` adds one activity line per skipped skill: "The repo commits <path>, so <agent> starts without the stack's <name> skill." `<name>` comes from HQ's skill cache, not from the repo.
  - Refusing to start the agent instead would let any PR stop every agent by committing one file. M0-F replaces the skill source, and the overview carries the question there.

- [ ] **Step 1: Write the failing tests** (a real git fixture repo).
  - `SR-D-07 [T-S7.3] a clone HQ makes holds none of the repo's agent configuration`.
    - The repo commits: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, `ROLE.md`, `.mcp.json`, a `.claude/settings.json` with a hook, `.claude/skills/x/SKILL.md`, `.agents/skills/y/SKILL.md`, `docs/CLAUDE.md`, `pkg/.claude/settings.json`, and `src/a.ts`.
    - After `ensureWorkspace`, none of them is on disk except `src/a.ts`, and `git status --porcelain` is empty.
  - `SR-D-07 [T-S7.3] … and none appears after the repo gains one`. Commit `web/CLAUDE.md` upstream, then `git pull` in the clone: it is not on disk.
  - `SR-D-07 [T-S7.3] the generated role and HQ's settings carry nothing from the repo`.
    - The role holds neither the `ROLE.md` marker nor the `CLAUDE.md` marker.
    - Every hook command in `.claude/settings.local.json` carries HQ's mark.
    - `hq-mcp.json` lists only `hq`.
    - The Codex config's `developer_instructions` holds neither marker.
  - `a clone made before this change is cleaned at its next start`.
  - `a clone with local changes to CLAUDE.md does not start`. The error names the path, and the file is kept.
  - `a chosen folder holding the repo's agent configuration is refused and left as it is`.
  - `a repo that commits one of HQ's own files is refused`, for `.claude/settings.local.json` and for `.jsmhq-role.md`.
  - `a stack skill whose name the repo commits is skipped, and the activity says so`. The repo commits `.claude/skills/x/SKILL.md`, and the stack installs `x`. After start, neither copy is on disk, the agent starts, `skipped` holds `.claude/skills/x`, and one activity line names it.
  - `the sparse patterns and isAgentConfigPath agree`. Over the fixture's `git ls-files`, a path is outside the sparse set exactly when `isAgentConfigPath` is true.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: agent folders leave out the repo's CLAUDE.md, AGENTS.md, ROLE.md, .claude, .mcp.json and skills (D1)`.

---

### Task 6: The owner approves the project notes agents read (D1, SR-D-07 part 2)

**Files:**
- Create: `server/company/projectNotes.ts`, `server/company/projectNotes.test.ts`
- Modify: `server/company/index.ts` (`Company.notes`), `server/agentFiles.ts` and `server/adapters.ts` (the notes section), `server/sessions.ts` (refresh the pending notes before each start), `server/commands.ts` (`approveProjectNotes`), `server/main.ts` (the first refresh), `server/dashboard.ts` (`viewFor` drops `projectNotes`)
- Modify: `src/data/types.ts` (`OfficeSnapshot.projectNotes?: { approved: { version: number; approvedAt: string } | null; pending: { sha256: string; text: string } | null }`, plus the `projectNotes.updated` event), `src/data/source.ts`, `src/data/ws/wsSource.ts`, `src/data/mock/mockSource.ts`
- Modify: `src/ui/systemItems.tsx` (`ProjectNotesRow`). Create: `src/ui/drawers/ProjectNotesDrawer.tsx` and its markup test.
- Modify: `README.md`, ADR 0008
- Modify: `docs/how-it-works.md`: agents cannot see or change the repo's `CLAUDE.md`, `AGENTS.md`, `ROLE.md`, `.mcp.json`, `.claude/`, `.agents/` or `.codex/` (they are outside the sparse set, and `git add` refuses them). A task like "update CLAUDE.md" therefore cannot go to an agent. The owner edits those files and approves the notes.

**Interfaces:**
- `ProjectNotes`:
  - `constructor(db, clock, audit)`.
  - `current(projectId): { version; sha256; content; approvedAt } | null`.
  - `readFrom(root: string): { sha256: string; content: string } | { error: "missing" | "link" | "too-long" }`.
  - `approve(projectId, sha256, content, by: Authority): number`. It is a `notes-approved` change, so it needs the PIN or a decision. It appends `project-notes.approved` with `{ version, sha256 }` and never the content.
- HQ keeps `pending`: the read copy when its hash differs from `current`. It refreshes `pending` at startup and before each agent start, and emits `projectNotes.updated`.
- `approveProjectNotes(sha256)`: owner, `pin: true`. Refused, with an activity line and no write, when `sha256` is not the pending hash: the file changed after the owner saw it (D3).
- The role gains `## Project notes (CLAUDE.md, version N, approved by the owner)` with the approved content, for Claude Code and Codex alike. With no approved copy, the section is left out.
- The UI shows the pending text through `AgentText`, labelled "CLAUDE.md in <repo>", as preformatted text, not rendered markdown, so the owner approves exactly the bytes HQ stores.

- [ ] **Step 1: Write the failing tests**
  - `SR-D-07 [T-S7.3] a changed CLAUDE.md reaches agents only after the owner approves it`.
    - Version 1, "alpha", is approved. The file is changed to "beta".
    - The generated role holds "alpha" and not "beta", and the snapshot's `pending` holds "beta".
    - After approval with the PIN, the role holds "beta".
  - `SR-D-07 [T-S7.3] approving without the PIN is refused and changes nothing`: `pin-required`, a refused row, and `current` unchanged.
  - `an approval for text the owner did not see is refused`: the hash differs from `pending`.
  - `approved notes are append-only`: an `UPDATE` or `DELETE` aborts.
  - `a CLAUDE.md that is a link, or longer than 20,000 characters, is not offered`.
  - `the supervisor's view has no project notes`.
  - `the notes drawer shows the text as agent text, labelled with its source`: `textOutside` holds none of the payload.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck && pnpm build`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: agents read the project's CLAUDE.md only as the copy the owner approved (D1)`.

---

## Exit check for M0-D1

- §6 "company configuration and `plan.json` live in the company store": Tasks 1 to 3. SR-D-01 and SR-D-02 prove the files have no effect.
- SR-D-01, 02, 03, 04, 07, 08, 10 and 11 each have a test titled with their id.
- The overview's M0-D carry-forward rows are closed in Tasks 2 to 4, and so are the PR #5 rows this plan takes.
- The PR description reports a manual check: an M0-C install upgraded with the import, an agent started in a sandbox, and its folder listed without the repo's `CLAUDE.md` or `.claude/settings.json`.

# M0-D2 One HQ, many projects: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One running HQ manages several project repos, each isolated from the others. HQ's own source can never be one of them. Company-level agents work in a folder that holds no repo and reaches no GitHub credential.

**Architecture:**
- **One runtime per project.** Today `main.ts` builds one `Hub`, `Sessions`, `Inbox`, `Planner`, `Sbx`, `SbxMcp`, `GitHubSync` and command table for the repo HQ was started in.
  - That wiring moves into `ProjectRuntime`, and `Projects` holds one runtime per registered project.
  - Every one of those classes already keys its state by the project slug. The store already keys every project table by project id (M0-D1). So nothing is shared between two projects except the HTTP server, the company store and sbx's own global settings.
- **Routing.**
  - `/mcp` and `/hook` find the caller's project from its secret (the agent row names the project) and use that project's runtime.
  - Each dashboard connection views one project at a time, and its commands act on that project only.
- **Projects come in two ways:**
  - HQ registers the repo it is started in, as today;
  - the owner adds a project from the dashboard, with the PIN.
  - Both refuse HQ's own source.
- **Company-level workspaces.** An agent whose role is CEO, CIO or Security & Audit gets an empty folder under HQ's home instead of a clone, and its sandbox does not start while a GitHub credential can reach it.

**Tech stack:** Node ≥ 22.13 (`node:sqlite`), TypeScript, React 18, git ≥ 2.35. No new packages.

**Spec:** `docs/superpowers/specs/2026-11-09-agentic-company-m0-m1-design.md`:
- M0.12: the company sits above projects; HQ's own source is off-limits; the company website is the first project.
- M0.14: a company-level workspace kind for the CEO, CIO and Security & Audit.
- The §6 exit item "company configuration and `plan.json` live in the company store" (many projects).

Requirements: `docs/security/threat-model-m0.md` §3.3: SR-D-05, SR-D-06 and SR-D-09. Order and carry-forward: `docs/superpowers/plans/2026-11-11-m0-foundations-overview.md`.

## Owner decisions this plan relies on

- **M0-D scope (2026-11-12): full multi-project,** built as M0-D1 (merged in #8) and then this plan.
- **The manual sandbox check from M0-D1's exit check moves to M0-G (accepted 2026-11-13).** It gets a carry-forward row for M0-G.
- **Needed before the code starts: a reused folder name.** M0-D1 recognises a moved repo when a project's old folder is gone and a new repo has the same folder name. Since M0-D1, a project id carries grants, Local mode and approved project notes. So a different repo that happens to reuse a deleted repo's folder name inherits all of them.
  - Proposed fix (Task 1): treat it as a move only when the GitHub remote matches too.
  - The builder and the reviewer both recommend it.
  - If the owner says no, Task 1 drops that step and its test, and the row stays open.
- **Needed before this plan's exit check: the company website repo.** M0.12 makes it the first project, and M0-E's live checks run on it. The owner creates it on GitHub (or names an existing one). That needs the owner's account, so it is a new owner-track row.

## Where this plan reads the spec narrowly (for the reviewer)

- **"Company-level workspaces" (M0.14, SR-D-06).**
  - M1 adds the CEO, CIO and Security & Audit agents, with their tools and a company-level runtime of their own.
  - This plan adds the workspace kind and its guarantees. Any agent whose role is one of those three gets them, wherever it is registered. M1 uses the same functions.
  - Until M1, only a role change in the store gives a project agent one of those roles. The dashboard still adds CTOs and builders only.
- **"Company-level roles see what §2a gives them" (SR-D-09).** In M0 those roles have no MCP tools at all (`roleTools.ts`), so the test checks that they get none of the project's task tools.
- **"The company website as first project" (M0.12).**
  - The code makes no project special.
  - The getting-started guide tells the owner to add the website repo first, and the exit check registers it.
- **Registering the repo HQ starts in.**
  - This stays as today: no PIN. Starting HQ on the host is already the owner's action.
  - Adding a project from the dashboard needs the PIN (SR-D-03). A phone session is not the host.

## Global constraints

- Keep the existing stack (spec §7). No new packages.
- Anti-goal §4: no secret value in a log, an alert or the audit trail. The audit sink's value guard (M0-B) still applies.
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
  - the title is `SR-D-nn [T-…] …`.
- Times come from the injected `Clock`.
- No product name in new code (M0-H). The one exception is the list of HQ's source repos in the values table: it names repos, not the product.
- No new migration: the tables from 001 and 006 already carry a project id.
- `.github/`, `CLAUDE.md` and `.claude/settings.json` of this repo are not touched.

## Values this plan fixes

| What | Value |
|---|---|
| HQ's source repos (SR-D-05) | `jsmastery-pro/jsm-hq` and `NdururiJr/Canoeney-Labs`, compared in lower case. They are matched against every remote of the repo (`git config --get-regexp ^remote\..*\.url$`), in the https, ssh and `git@` forms, with or without `.git` |
| HQ's package identity (SR-D-05) | A `package.json` at the repo root whose `name` equals the `name` in HQ's own `package.json`, read at runtime (today `@therealjsmastery/jsm-hq`) |
| HQ's install folder (SR-D-05) | `hqSourceRoot()`, the folder above `server/`. A repo or chosen folder that is, holds or sits inside it is refused (`isInside`, both ways) |
| A moved project | Its old folder is gone **and** its stored `project_settings.github` equals the new repo's `github`, with both non-null, compared in lower case. Anything else is a new project, `<slug>-2` and so on |
| Session names | `sessionName(slug, agentId)` stays `hq-<slug>-<agent>`. It must be unique across the company: `addAgent` refuses an id whose session name another agent in any project already has. Example: project `a` agent `b-c` against project `a-b` agent `c` |
| Adding a project | Owner only, PIN always (`relaxes({ kind: "project-added" })` is true) |
| Company-level roles | `ceo`, `cio` and `security-audit` |
| Company workspace | `<hqHome>/_workspaces/<project slug>/<agent id>`. An empty folder that is not inside any git work tree |
| GitHub credentials a company sandbox must not reach | The sbx service key `github`, global or scoped to the sandbox. In the agent's env file: `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` |
| Dashboard view | `{ type: "select", projectId }` on the WebSocket. HQ answers with that project's snapshot, and later events come from that project only. A connection starts on the project HQ was started in, or else on the first open project |
| Snapshot additions | `projectId: string` and `projects: ProjectSummary[]`, where `ProjectSummary = { id: string; name: string; state: "open" \| "missing" }` |
| New audit actions | `project.refused` (`data.reason`: `hq-remote`, `hq-package`, `hq-folder` or `not-a-repo`); `project.registered` gains `authority` when the owner added it. `workspace.refused` gains the reasons `hq-source`, `company-git` and `github-credential` |

## Review focus

1. **Starting HQ inside its own source.** `pnpm dev:hq` runs in this repo with no `--repo`. Today that registers HQ's source as the project. HQ must not register it. If the store has other projects, HQ opens them; if not, it stops with a message that says to pass `--repo`.
   - Test: Task 2 `HQ started in its own source registers nothing and opens the stored projects`.
2. **Two projects whose agents share an id.** Both projects have an `ana`. Messages, task ids, hooks and the dashboard's agent commands must reach only the `ana` of the project they belong to.
   - Test: Task 4 `SR-D-09 [T-S7.8] same agent id in two projects: each message, hook and command reaches its own project's agent`.
3. **A clone of HQ's source with the fork only as a second remote**, or with an `ssh://` or `git@` URL in mixed case.
   - Test: Task 1 `SR-D-05 [T-S7.5] a repo with HQ's source as any remote, in any URL form, is refused`.
4. **HQ's home inside a git work tree** (a home folder kept in a dotfiles repo). A company workspace there would sit inside a repo.
   - Test: Task 5 `SR-D-06 [T-S3.10] a company workspace inside a git work tree is refused`.
5. **A project whose folder was deleted while HQ was stopped.** HQ must still start, list the project as missing, and start none of its agents.
   - Test: Task 2 `a project whose folder is gone is listed as missing and none of its agents start`.

---

### Task 1: Projects: HQ's source refused, moves need the remote, unique session names

**Files:**
- Create: `server/hqSource.ts`, `server/hqSource.test.ts`
- Modify: `server/company/agents.ts` (`ensureProject` gains `github`; delete the dead `syncFromConfig`), `server/company/projectSettings.ts` (`addAgent` checks session names), `server/company/authority.ts` (`project-added`), `server/workspace.ts` (chosen folder), `server/repo.ts` (`remotes`)
- Test: `server/company/agents.test.ts`, `server/company/projectSettings.test.ts`, `server/workspace.test.ts`

**Interfaces:**
- `hqSource.ts`:
  - `HQ_SOURCE_REPOS: readonly string[]`, the values table, in lower case.
  - `hqSourceRoot(): string`.
  - `githubOf(url: string): string | null`. It handles the https, `ssh://`, `git@` and `.git` forms.
  - `async hqSourceReason(root: string): Promise<"hq-remote" | "hq-package" | "hq-folder" | null>`.
  - `class ProjectRefusedError extends Error { reason: "hq-remote" | "hq-package" | "hq-folder" | "not-a-repo" }`.
  - `async refuseHqSource(company: Company, root: string, actor: Actor): Promise<void>`. When `hqSourceReason` is not null, it appends `project.refused` (the actor, `data.reason`) and throws `ProjectRefusedError`. Every path that registers a project calls it first.
- `repo.ts`: `RepoInfo` gains `remotes: string[]`, the `owner/name` of every GitHub remote, from `githubOf`.
- `agents.ts`: `ensureProject(p: { name: string; root: string; github: string | null; slug?: string }): string`, with the move rule from the values table.
- `authority.ts`: `ConfigChange` gains `{ kind: "project-added" }`, and `relaxes` returns true for it.
- `projectSettings.ts`: `addProject(repo: { name: string; root: string; github: string | null }, by: Authority): string`.
  - It runs `authorized([{ kind: "project-added" }], …)` around `ensureProject`. It writes no settings row, so the new project gets the welcome, as a fresh repo does.
- `workspace.ts`: a chosen folder whose `hqSourceReason` is not null throws `WorkspaceRefusedError("hq-source", …)`.

- [ ] **Step 1: Write the failing tests**
  - `SR-D-05 [T-S7.5] a repo with HQ's source as any remote, in any URL form, is refused`. Cases:
    - `origin` is `https://github.com/NdururiJr/Canoeney-Labs.git`;
    - an `upstream` remote is `git@github.com:jsmastery-pro/jsm-hq`;
    - an `origin` of `ssh://git@github.com/ndururijr/canoeney-labs` written in upper case.
    - Each returns `"hq-remote"`.
    - `refuseHqSource` with the owner as the actor throws `ProjectRefusedError("hq-remote")` and appends one `project.refused` row whose actor is the owner. The `projects` table is unchanged.
  - `SR-D-05 [T-S7.5] a folder holding HQ's package identity, or HQ's own folder, is refused`.
    - A repo whose `package.json` has HQ's name gives `"hq-package"`.
    - `hqSourceRoot()` and a folder inside it give `"hq-folder"`.
    - A repo with an unrelated `package.json` gives `null`.
  - `SR-D-05 [T-S7.5] a chosen agent folder that is a clone of HQ's source is refused`. `ensureWorkspace` throws `WorkspaceRefusedError` with reason `hq-source`.
  - `addProject is refused without the PIN, and a supervisor adds nothing` (SR-D-03).
  - `a repo in a reused folder name is a new project unless its GitHub remote matches`.
    - Old project `site` was at a folder that is now deleted, with `github: "acme/site"`.
    - A repo at a new path with remote `acme/other` gets `site-2`.
    - A repo with remote `ACME/site` takes over `site` (`project.moved`).
    - A repo with no remote gets a new id.
  - `an agent whose session name another project's agent already has is refused`. Project `a` has agent `b-c`; adding agent `c` to project `a-b` throws and writes no row.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the new tests fail; the rest pass.
- [ ] **Step 3: Implement.**
  - Delete `syncFromConfig` and its tests (PR #8 deferred minor: dead code).
  - Callers of `ensureProject` pass `repo.github`.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`. Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat: HQ's own source can never be a project; a move needs the same remote; session names are unique`.

---

### Task 2: One HQ runs many projects

**Files:**
- Create: `server/projectRuntime.ts`, `server/projects.ts`, `server/startHq.ts`, `server/projects.test.ts`
- Modify: `server/main.ts` (argument parsing, then `startHq`), `server/http.ts`, `server/agentAuth.ts`, `server/dashboard.ts`, `server/commands.ts` (`addProject` in a company table), `server/testing/hqFixture.ts`, `scripts/smoke-test.mjs`
- Create: `docs/adr/0009-one-hq-many-projects.md`
- Test: `server/projects.test.ts`, `server/agentAuth.test.ts`, `server/dashboard.test.ts`, `server/repoConfigImport.test.ts` (SR-D-01 through `startHq`)

**Interfaces:**
- `projectRuntime.ts`: `class ProjectRuntime`.
  - Members: `slug`, `repo`, `hub`, `sessions`, `inbox`, `planner`, `sbx`, `mcp` and `commands: Record<string, CommandSpec>`.
  - `static async open(company: Company, repo: RepoInfo, slug: string, o: { port: number }): Promise<ProjectRuntime>`. It holds everything `main.ts` builds per project today: the setup checks, `offerImport`, `refreshProjectNotes`, the session callbacks and `makeCommands`.
  - `start(): void` starts session polling, sbx approval polling and `GitHubSync`.
  - `stop(): void` is what `quit()` does per project today.
- `projects.ts`:
  - `class Projects` (uses Task 1's `refuseHqSource` and `ProjectRefusedError`):
    - `constructor(company: Company, open: (repo: RepoInfo, slug: string) => Promise<ProjectRuntime>)`.
    - `get(slug: string): ProjectRuntime | null`.
    - `list(): ProjectSummary[]`, in registration order.
    - `defaultId(): string | null`.
    - `openAll(): Promise<void>` opens every registered project whose folder is a git repo and is not HQ's source. The others are `missing`.
    - `registerStart(start: string): Promise<string | null>`: the repo HQ was started in, or null. HQ's source is not registered; HQ logs why.
    - `add(path: string, by: Authority): Promise<string>`: `detectRepo` (a folder that is not a repo is `ProjectRefusedError("not-a-repo")`), then `refuseHqSource`, then `settings.addProject`, then `open`, then `start`.
    - `subscribe(fn: (list: ProjectSummary[]) => void): () => void`.
    - `stopAll(): void`.
- `startHq.ts`: `startHq(o: { start: string; port: number; dev: boolean; distDir: string | null; uiOrigin: string; extraOrigins: string[] }): Promise<{ projects: Projects; url: string; close(): void }>`.
  - It opens the company, then `registerStart`, then `openAll`.
  - It throws `"No project to open. Run HQ in your project's repo, or pass --repo <path>."` when the store has no project and none was registered.
- `agentAuth.ts`: `constructor(o: { company: Company; projects: { get(slug: string): { hub: Hub } | null }; limits? })`. `other-project` now means the caller's project has no open runtime.
- `http.ts`: `startHttp` takes `projects: Projects` instead of `hub`, `inbox` and `planner`.
  - `/hook` and `/mcp` use `projects.get(who.agent.projectSlug)`.
  - Each WebSocket keeps its selected project, handles `select` and sends `{ type: "projects.updated", projects }` to every connection.
- `dashboard.ts`:
  - `CommandCtx` gains `projectId: string | null`.
  - `new Dashboard(companyCommands, { …, projectCommands: (projectId: string) => Record<string, CommandSpec> | null })`.
  - `dispatch` looks a command up in the company table first, then in the selected project's table. The audit row's `data` gains `project`.
- `commands.ts`: `makeCompanyCommands(projects: Projects): Record<string, CommandSpec>` with `addProject(path)`: role `owner`, `pin: true`, target `null`.
- `hqFixture.ts`:
  - `makeHq(t, { …, extraProjects?: { slug: string; team: AgentConfig[] }[] })`.
  - `Hq` gains `projects: Projects` and `runtime(slug): ProjectRuntime`. `hub`, `planner` and `inbox` remain the first project's.

- [ ] **Step 1: Write the failing tests**
  - `two projects run side by side: each view shows only its own team and board`. The WebSocket starts on project A. After `select` B, the snapshot and the next `agent.updated` event are B's.
  - `/mcp from an agent of project B is served by project B's runtime`. `list_tasks` returns B's tasks.
  - `adding HQ's own source from the dashboard is refused`: `addProject(hqSourceRoot())` with the PIN replies `failed`, writes `project.refused`, and lists no new project.
  - `addProject needs the owner's PIN, and its row names the authority`. Without the PIN the reply is `pin-required`; with the PIN, `project.registered` has `authority: "pin"` and a new runtime is listed `open`. A supervisor gets `forbidden`.
  - `HQ started in its own source registers nothing and opens the stored projects`. `startHq({ start: hqSourceRoot() })`:
    - with a stored project, opens it and writes no `project.registered` row;
    - with an empty store, throws the "No project to open" message.
  - `a project whose folder is gone is listed as missing and none of its agents start`. `startAgent` on it replies `failed`; no session is created.
  - `SR-D-01 [T-S7.1] startHq ignores the repo's .jsmhq files`. The SR-D-01 test runs again through `startHq` (PR #8 deferred minor: SR-D-01 did not run `main.ts` startup).
  - `HQ starts from a folder that is not a repo when the store has projects`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
  - Move the per-project wiring out of `main.ts` without changing its order: `offerImport` and `refreshProjectNotes` before `Sessions`, and `hq.started` only once HQ serves.
  - `hq.started` and `hq.stopped` carry `data.projects` (the open ids).
  - `smoke-test.mjs` checks that the `/ws` snapshot has `projects` with its one repo `open`.
  - Write ADR 0009:
    - why there is one runtime per project, not one project-aware hub;
    - what is shared (HTTP, the store, sbx's global settings, including keys "for every sandbox");
    - the session name rule.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck && npx tsx scripts/session-backend-test.ts`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: one HQ runs many projects, each with its own runtime`.

---

### Task 3: The project switcher, and tooltips that name their author

**Files:**
- Create: `src/ui/hud/ProjectSwitcher.tsx`, `src/ui/hud/ProjectSwitcher.test.tsx`, `src/ui/setup/AddProjectDialog.tsx`
- Modify: `src/data/types.ts`, `src/data/source.ts`, `src/data/ws/wsSource.ts`, `src/data/mock/mockSource.ts` (two demo projects), `src/store/office.ts`, `src/ui/hud/TopBar.tsx`, `src/ui/drawers/AgentDrawer.tsx`, `src/ui/drawers/BoardsDrawer.tsx`, `src/ui/hud/ActivityFeed.tsx`

**Interfaces:**
- `types.ts`:
  - `ProjectSummary`;
  - `OfficeSnapshot` gains `projectId?: string` and `projects?: ProjectSummary[]`;
  - `OfficeEvent` gains `{ type: "projects.updated"; projects: ProjectSummary[] }`.
- `OfficeSource`:
  - `selectProject(id: string): void`.
  - `addProject(path: string, pin: string): Promise<CommandResult>`, which uses the same PIN prompt as `importRepoConfig`.
- `ProjectSwitcher` shows `<select aria-label="Project">` in the top bar, in the `projects` order.
  - A `missing` project is a disabled option labelled `<name> (folder missing)`.
  - The owner also gets an "Add project" button, which opens `AddProjectDialog`. The dialog asks for a folder path and the PIN.
- **Rule for native `title` tooltips (PR #5 carry-forward):**
  - A `title` that holds agent text starts with `Written by <author>` and a blank line.
  - The three places that do this today:
    - `BoardsDrawer.tsx:100`, the task's description and files. The author is `task.createdBy`.
    - `ActivityFeed.tsx:54`, an activity line flagged as agent text. The author is its agent.
    - `AgentDrawer.tsx:159`, an access request's title and host. The author is the requesting agent.

- [ ] **Step 1: Write the failing tests**
  - `the switcher lists the projects and selecting one asks for its snapshot`. It renders with two projects and changes the select; `selectProject("b")` was called.
  - `a missing project cannot be selected`.
  - `a supervisor sees no Add project button`.
  - `a tooltip that holds agent text names its author`. One render per place above: the `title` starts with `Written by Ana`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the new tests fail.
- [ ] **Step 3: Implement.** Switching clears the per-project UI state: open drawers, the selected agent and the terminal tabs.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck && pnpm build`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(ui): project switcher; tooltips with agent text name their author`.

---

### Task 4: Each project sees only its own boards, tasks and messages (SR-D-09)

**Files:**
- Modify: `server/planner.ts` (the self-close rule), plus whatever the tests show leaks
- Create: `server/isolation.m0d2.test.ts`

**Interfaces:**
- Uses Task 2's `makeHq({ extraProjects })` and `hq.runtime(slug)`.
- `planner.ts`: `set_my_status done` is refused unless the caller's role is `cto` (was: refused when the role is `builder`; PR #8 round 1 non-blocking finding 1).

- [ ] **Step 1: Write the failing tests.** Projects `x` and `y` each have a CTO `lead` and a builder `ana`. Each has one board with tasks, and the task ids are different.
  - `SR-D-09 [T-S7.8] a builder of project X calling the task tools with ids from project Y gets nothing and changes nothing`.
    - X's `ana` calls `get_my_task`, and `set_my_status` with a task id of Y's.
    - X's `lead` calls `update_task`, `assign_task` (Y's task to X's `ana`) and `list_tasks`.
    - Each call is refused or returns X's data only.
    - Each refusal's `tool.called` row has `outcome: "refused"` and X's agent as the actor.
    - `plans.load("y")` is unchanged.
  - `SR-D-09 [T-S7.8] same agent id in two projects: each message, hook and command reaches its own project's agent`.
    - X's `lead` sends to `ana`: only X's inbox gets it.
    - A hook carrying Y's `ana` secret updates Y's status only.
    - A dashboard `stopAgent("ana")` with `x` selected stops X's `ana` only.
  - `SR-D-09 [T-S7.8] a company-level role gets none of the project's task tools`. After `setRole("x", "ana", "ceo")`, `tools/list` for `ana` holds none of the CTO or builder tools.
  - `only the CTO may close a task with set_my_status done`. A `qa` role is refused with `SELF_DONE`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the self-close test fails. A SR-D-09 test that passes at once is fine only if it fails when its check is removed: run it once with the project lookup in `http.ts` hard-coded to `x` and see it fail.
- [ ] **Step 3: Implement** the self-close rule and fix any leak the tests found.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `test: each project sees only its own boards, tasks and messages (SR-D-09)`.

---

### Task 5: Company-level workspaces (SR-D-06)

**Files:**
- Create: `server/companyWorkspace.ts`, `server/companyWorkspace.test.ts`
- Modify: `server/sessions.ts` (the folder by workspace kind), `server/sbx.ts` (`githubKeyFor`), `server/company/home.ts` (`COMPANY_WORKSPACES_DIRNAME = "_workspaces"`)

**Interfaces:**
- `companyWorkspace.ts`:
  - `COMPANY_ROLES: readonly RoleId[] = ["ceo", "cio", "security-audit"]`.
  - `workspaceKind(role: RoleId): "company" | "project"`.
  - `companyWorkspaceFor(projectSlug: string, agentId: string): string`.
  - `async ensureCompanyWorkspace(projectSlug, agentId): Promise<string>`. It creates the folder. It throws `WorkspaceRefusedError("company-git")` when the folder holds a `.git` or `git rev-parse --is-inside-work-tree` is true there.
  - `githubCredentialIn(envFile: string | null): string[]`: the names from the values table found in the env file, never their values.
- `sbx.ts`: `githubKeyFor(agentId: string): "global" | "sandbox" | null`, read from the last `refresh()`.
- `sessions.ts`: when `workspaceKind(reg.role) === "company"`:
  - the folder is the company workspace;
  - no clone, no project notes and no stack skills;
  - before any sandbox or session is created, a GitHub key or env name throws `WorkspaceRefusedError("github-credential")`. Its `workspace.refused` row has the reason and the names, never values.

- [ ] **Step 1: Write the failing tests**
  - `SR-D-06 [T-S3.10] a company-level agent's folder has no .git and is not a clone`. After `setRole("x", "ana", "ceo")` and `start`, the folder exists under `_workspaces/x/ana`; it has no `.git`, and `git rev-parse` fails there.
  - `SR-D-06 [T-S3.10] a company-level agent does not start while a GitHub credential can reach its sandbox`. Three cases: a global `github` key, a sandbox-scoped one, and `GH_TOKEN=` in the env file.
    - Each is refused with a `workspace.refused` row: `reason: "github-credential"`, the owner as the actor.
    - The fake `exec` records no `sbx create`.
    - The row holds no token value.
  - `SR-D-06 [T-S3.10] a company workspace inside a git work tree is refused`: `HQ_HOME` inside a temporary repo.
  - `a builder still gets its sparse clone`, as a regression check.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: company-level agents get a folder with no repo and no GitHub credential (SR-D-06)`.

---

### Task 6: M0-D1 leftovers and the docs

**Files:**
- Modify:
  - Import: `server/repoConfigImport.ts`, `server/store.ts`.
  - Settings: `server/company/projectSettings.ts`.
  - Launching: `server/backends/pty.ts`.
  - Sandbox and workspace: `server/sbx.ts`, `server/workspace.ts`, `server/agentIsolation.ts`, `server/commands.ts`.
  - Docs: `docs/how-it-works.md`, `docs/getting-started.md`, `README.md`.
- Test: `server/repoConfigImport.test.ts`, `server/company/projectSettings.test.ts`, `server/backends/pty.test.ts` (new), `server/agentIsolation.test.ts`, `server/leftovers.m0d1.test.ts`

**What each item does** (the carry-forward rows this plan takes; PR #8):
1. **The import cleans domains and MCP names the way the dashboard does** (round 1 finding 4).
   - Domains are lower-cased and must match `DOMAIN` (`access.ts`); MCP names must match `MCP_NAME` (`sbxMcp.ts`).
   - A value that fails is dropped, and the preview says how many were dropped.
2. **The `cmd.exe` quoting in `backends/pty.ts`** (round 1 finding 5).
   - `resolveCommand` builds the command line for a `.cmd` or `.bat` shim itself and passes node-pty one string.
   - Each argument is quoted with cross-spawn's rule for shims, written inline (no package):
     - a backslash run before a `"` or at the end is doubled;
     - `"` becomes `\"`;
     - the argument is wrapped in `"…"`;
     - then every `()%!^"<>&|` is prefixed with `^`, twice for a shim.
3. **A model name may not start with `-`** (round 2 finding): `MODEL_NAME = /^(?!-)[A-Za-z0-9._:/\[\]-]*$/`.
4. **`imported_at` is written** when the import completes.
5. **`readImport` and a bad config file.**
   - It refuses a `config.json` or `plan.json` that is a link (`lstat`).
   - A file that is not valid JSON gives "`.jsmhq/config.json` is not valid JSON; fix or delete it", not a generic error.
6. **The SR-D-02 scan also matches the literal `".jsmhq/config.json"`.**
7. **Delete the unused `defaultWorkflow`.**
8. **A chosen folder that is a repo subfolder.** `checkFolder` and `trackedHqFiles` run `git ls-files` from `git rev-parse --show-toplevel`, so a root `CLAUDE.md` above the chosen folder is found.
9. **`allowAll` writes its grants in one `ProjectSettings.transaction`.**
10. **`importRepoConfig` keeps running agents' statuses.** It refreshes the config view without resetting `hub.snap.agents` entries of agents that are still in the team.
11. **Docs.**
    - `how-it-works.md` covers several projects and the switcher.
    - It also says that a chosen folder is checked when its agent starts: a later `git pull` there can bring `CLAUDE.md` back until the next start (round 1 finding 2).
    - `getting-started.md` says to add the company website repo as the first project, and to start `pnpm dev:hq` with `--repo`.

- [ ] **Step 1: Write the failing tests:**
  - `the import drops domains and MCP names the dashboard would refuse`;
  - `a cmd shim receives each argument unchanged`:
    - Windows only (skipped elsewhere).
    - A temporary `.cmd` runs `node -e "console.log(JSON.stringify(process.argv.slice(1)))" %*`.
    - The arguments are `a"&echo hacked&"b`, `100%`, `^x`, `(y)` and `back\\`.
    - They come back unchanged, and nothing prints `hacked`.
  - `a model name starting with - is refused`;
  - `the import records imported_at`;
  - `a linked config.json is not read, and a broken one names the file`;
  - `the SR-D-02 scan catches the literal path`;
  - `a chosen subfolder of a repo with a root CLAUDE.md is refused`;
  - `allow all is one transaction: a failing grant leaves none behind`;
  - `importing keeps a running agent's status`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the new tests fail; the shim test is skipped off Windows.
- [ ] **Step 3: Implement** the items, and write the docs.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck && pnpm build && npx tsx scripts/session-backend-test.ts`. Expected: all pass.
- [ ] **Step 5: Commit** `fix: M0-D1 leftovers (import cleaning, cmd.exe quoting, model names) and multi-project docs`.

---

## Exit check for M0-D2

- **§6 "company configuration and `plan.json` live in the company store", for many projects:** Tasks 2 and 4.
- **Requirement tests:** SR-D-05, SR-D-06 and SR-D-09 each have a test titled with their id.
- **Carry-forward:** the overview rows assigned to M0-D2 are closed in Tasks 1, 3, 4 and 6.
- **The PR description reports a manual check on Windows:**
  - HQ started in this repo with `--repo` pointing at the company website repo;
  - a second project added from the dashboard with the PIN;
  - the switcher moving between the two;
  - HQ started with no `--repo` from this repo, registering nothing.
- **Not in this check:** starting agents in a real sandbox stays with M0-G, on the Linux host.

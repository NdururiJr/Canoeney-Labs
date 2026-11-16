# M0-F Per-role skills: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent's skills come only from the company's own skills repo, at a commit the owner pinned, checked by a hash over every file. The set depends on the agent's role. At every start HQ puts back exactly that set, and nothing an upstream author, a repo or an agent changes reaches the next session.

**Architecture:**
- **One company skills repo:** `NdururiJr/canoeney-skills` (public, owner decision 2026-11-15).
  - Upstream skills are copied ("vendored") into it and edited there.
  - Only the owner writes to it.
- **The owner pins one commit of that repo, with the PIN.**
  - HQ fetches the repo's default branch with plain `git`, with no installer and no credentials, and refuses a commit that is not on it. GitHub serves a stranger's pull-request commit by its SHA, so the SHA alone proves nothing.
  - It refuses links, escaping paths and oversized skills.
  - It hashes each skill folder (every path and every byte) and shows a preview. The owner confirms the preview with the PIN.
  - HQ then keeps the lock in the company store and the content in HQ's home. Agents can reach neither.
  - A category 2 decision (M1) can do the same; that path is coded and tested now.
- **Role sets live in the company store**, seeded with §2a's starting sets. Changing one needs the PIN or a decision.
- **At every start, HQ installs the agent's set from its own store.** The set is the role's skills, plus the agent's own skill grants, plus the project's stack skills, as far as each one is pinned.
  - HQ checks the hash before and after copying.
  - It moves anything else out of the agent's skill folders and records the drift.
  - A session start fetches nothing.
- **Nothing else adds skills.** New sandboxes are created with sbx's shared skills store off. A skill the repo commits cannot shadow HQ's copy.
- **HQ checks the skills repo** at pin time and daily: it has branch rules, only the owner is a collaborator, and no agent App is installed on it (SR-F-08).

**Tech stack:** Node ≥ 22.13 (`node:crypto` sha256), git ≥ 2.37, TypeScript, React 18. No new packages.

**Spec:** `docs/superpowers/specs/2026-11-09-agentic-company-m0-m1-design.md`:
- M0.18: skills vendored into company-owned forks, pinned by hash, installed per role, changes as category 2, policy only in `Knowledge`, one skill family per concern, superpowers forks edited for "your manager";
- §2a, the "Skills" column;
- S12 in §2b;
- the §6 exit item "per-role skills are vendored and pinned".

Requirements: `docs/security/threat-model-m0.md` §3, SR-F-01 to SR-F-08 (T-S12.1 to T-S12.8).

Order and carry-forward: `docs/superpowers/plans/2026-11-11-m0-foundations-overview.md`.

## Owner decisions this plan relies on

- **The skills repo is `NdururiJr/canoeney-skills`, public** (2026-11-15). It was created private first.
  - On GitHub Free a private repo gets no branch protection or rulesets: GitHub answered 403 "Upgrade to GitHub Pro or make this repository public".
  - That would break SR-F-08, so the owner chose public.
  - Public also means HQ fetches it with no stored credential.
  - A ruleset `skills-main` already blocks deleting and force-pushing the default branch.
- **App installations are limited to selected repos** (2026-11-15). The owner checked that no App is installed on "all repositories" and deleted the three test Apps from the M0-E exit check.
- **D1 (2026-11-12):** a skill committed to a managed repo is not loaded. This decides SR-F-05, which the threat model marked "(proposed)".

## Where this plan reads the spec narrowly (for the reviewer)

- **"Copied into company-owned forks":** one company repo holds every vendored skill, each in its own folder with its source recorded, instead of one GitHub fork per upstream repo.
  - A fork would carry each upstream repo's whole history and settings, which would need the SR-F-08 check repeated per fork.
- **Category 2 decisions arrive in M1.** In M0 the owner's PIN is the only working authority. The `decision` path goes through the same `authorized()` check as M0-D1, and is tested with an approved row written directly.
- **"Branch protection" on the skills repo (SR-F-08)** means: rules on the default branch blocking deletion and non-fast-forward; the owner as the only collaborator; no agent App installed.
  - A required pull request review is not demanded. The owner is the only writer, and GitHub does not let an author approve their own pull request.
- **SR-F-04 says the extra skills are "gone".** HQ moves them out of the agent's folder into HQ's home rather than deleting them.
  - In an owner-chosen folder they may be the owner's own files.
  - The audit row names where they went. HQ keeps the newest 5 moves per agent.
- **SR-F-07 is a review item, not code.** Task 8's vendoring PR on the skills repo carries the check, skill by skill.
- **Stack skills** install only once they are vendored and pinned; until then the start says which are missing.
  - Fetching them live from upstream is the threat (T-S12.1, T-S12.2), so the live fetch goes.
  - Task 8 vendors the stack skills of the stacks the company's projects use today, so no running project loses one.
- **Role sets are seeded by migration** with §2a's starting sets. The migration reaches `main` only through the owner's merge, so it is an owner-approved change.
- **Three §2a skills wait for M1:** humanizer and the charter-first planning skill (CEO), and the company-audit skill (Security & Audit, M1.8). No CEO or Security & Audit agent runs in M0, and two of the three are new work, not vendoring. The overview carries them to M1.
- **"A `../` path" (SR-F-06)** means a file path in the pinned commit that leaves its skill's folder; the code refuses it (Task 2). A `../` written inside a skill's text or script is not code HQ can judge; Task 8's edit rule 4 removes it in review.
- **A skill an agent writes to its own sandbox home** (`~/.claude/skills` inside the sandbox) is loaded by its CLI and stays until the sandbox is recreated. HQ's re-sync covers the two workspace folders only. It reaches only that agent, as T-S6.10 does. ADR 0011 records it as a known limit, and the overview carries it to Security & Audit (M1.8).

## Global constraints

- Keep the existing stack (spec §7). No new packages.
- Anti-goal §4: existing capabilities must not regress. On Ubuntu and Windows these must pass:
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - `npx tsx scripts/session-backend-test.ts`
  - `scripts/smoke-test.mjs`
- Every enforcement test follows the threat model's rules (§3 preamble):
  - the refusal is checked;
  - its audit row is checked, with the caller as the actor;
  - the targeted state is read back unchanged;
  - the title is `SR-F-nn [T-S12.n] …`.
- Unit tests never reach the network. A skills repo in a test is a local bare repo made with `git init --bare`, and its URL is a file path. GitHub calls use the fake `GitHubApi` from M0-E.
- HQ never runs anything a skill contains, on the host or anywhere else. The only process the install path starts is `git`.
- Times come from the injected `Clock`.
- No product name in new code (M0-H).
- `.github/`, `CLAUDE.md` and `.claude/settings.json` of this repo are not touched.

## Values this plan fixes

| What | Value |
|---|---|
| Skills repo | `NdururiJr/canoeney-skills`, kept in the store (`skill_source.repo`, `owner/name` shape). Fetched from `https://github.com/<repo>.git` |
| Repo layout | `skills/<name>/SKILL.md` plus the skill's files. `<name>` matches `^[a-z0-9][a-z0-9-]{0,62}$`. A vendored skill also holds `UPSTREAM.json` `{ repo, commit, path, license }` and its upstream licence as `LICENSE.upstream` |
| Fetch | Every git call carries `-c credential.helper= -c protocol.allow=never -c protocol.https.allow=always` and `GIT_TERMINAL_PROMPT=0`; tests allow `file`. 1) `git ls-remote --symref <url> HEAD` names the default branch. 2) `git fetch --no-tags <url> +refs/heads/<branch>:refs/hq/default` into the bare repo `<company home>/skills/repo.git`, full history (the repo is small; no `--depth`). HQ never fetches a commit by its SHA. 3) `git merge-base --is-ancestor <sha> refs/hq/default`; a commit that is missing or not an ancestor is refused `not-on-default-branch`. Files are read with `git ls-tree -r -z <sha> -- skills/` and `git cat-file --batch`. Nothing is checked out |
| Pin | One 40-hex commit for the whole repo, on its default branch. Every skill in it is pinned at that commit. The default-branch check runs at preview and again at pin |
| Refused at pin (SR-F-06) | Mode `120000` (link), `160000` (submodule), or anything but `100644`/`100755`. A path (`safeSkillPath`) with a `..` or `.` segment, an empty segment, a leading `/`, a `\` or a NUL. A folder name outside the pattern. No `SKILL.md`. More than 256 files or 2 MiB in one skill. Any refusal refuses the whole pin |
| Scripts listed (SR-F-06) | Mode `100755`, or an extension in `.sh .bash .zsh .py .js .mjs .cjs .ts .mts .ps1 .rb .pl` |
| Skill hash | sha256 hex over the lines `"<mode> <path>\0<sha256 hex of the bytes>\n"`, one per file, sorted bytewise by path. The path is relative to the skill folder and uses `/` |
| Checking a folder on disk | `hashFolder(dir, files)` takes the locked file list. The folder must hold exactly those paths, all regular files (walked with `lstat`, no link followed). It hashes the bytes on disk and takes each mode from the lock, so the result equals the lock's hash only when every byte matches. On POSIX it also requires the executable bit to match the mode (`100755` ⇔ `0o100` set); `writeStore` and the copy set `0o755`/`0o644`. **On Windows the mode is not checked on disk**: NTFS keeps no executable bit |
| Lock hash | sha256 of the canonical JSON (`canonicalJson`) of `{ repo, commit, skills: [{ name, hash }] }`, sorted by name. The preview shows it; the confirm must send it back |
| Content store | `<company home>/skills/store/<skill hash>/`, written once at pin. Re-hashed before every copy into an agent's folder |
| Install folders | Claude Code: `.claude/skills/<name>`. Codex: `.agents/skills/<name>`. Both folders are HQ's; the one the agent's CLI does not read is kept empty |
| The agent's folder | The agent controls it. Every list, read, move, copy and delete in it goes through `server/lib/agentFs.ts` (`agentPath`, `agentMkdir`, `agentRemove`), and folders inside a skill are walked with `lstat`. A link at `.claude`, `.agents`, `.claude/skills` or `.agents/skills` refuses the start (`workspace.refused` `{ reason: "skills-link" }`, agentPath's "is a symlink; HQ won't write through it" wording), and nothing is moved or copied. A link at `<install folder>/<name>` is removed as a link; its target is untouched |
| Shadowing (PR #6 carry-forward) | HQ's clones set `sparse.expectFilesOutsideOfPatterns=true`. HQ writes its copy even where the repo tracks that path, git keeps it skip-worktree, and `git status` stays clean. HQ needs git ≥ 2.37 (was 2.35). Every folder HQ installs is also added to the git exclude (`excludeFromGit`, as today), so a skill the repo does not track is not untracked noise |
| Drift moves | `<project home>/skills-removed/<agent id>/<UTC stamp>/`. For a company-level agent the same under the company home. The newest 5 per agent are kept. A move is a `rename`; on `EXDEV` (another drive) it copies file by file with `lstat`, skipping links (named in the row), then removes the source. A changed or extra folder over 256 files or 2 MiB (regular files, links not followed) is not moved: it is removed, and the drift row lists it under `deleted` |
| Starting role sets (§2a) | `builder`: test-driven-development, systematic-debugging, verification-before-completion, executing-plans. `cto`: writing-plans, requesting-code-review, brainstorming. `ceo` and `cio`: verification-before-completion. Every other role: none. §2a's humanizer, charter-first planning and company-audit skills arrive in M1 |
| One family per concern | superpowers (MIT). jsm-skills-workflow is not vendored for agents. ADR 0011 records why |
| sbx | `sbx run … --skills off` whenever HQ creates a sandbox. An existing sandbox without HQ's record of that starts only if `sbx skills ls` lists nothing |
| SR-F-08 check | `GET /repos/{r}` (`private` false, or rules readable); `GET /repos/{r}/rules/branches/{default}` holds `deletion` and `non_fast_forward`; `GET /repos/{r}/collaborators` lists only the owner; `GET /repos/{r}/keys` holds no key with `read_only: false`; for each agent with an App, `GitHubApps.installation(agent, r)` is null. Read with the owner's `gh`, at pin and every 24 h from HQ's start. Third-party Apps cannot be listed with the owner's `gh`; the exit check covers them by hand |
| Authority | A pin or a role-set change is a `ConfigChange`; `relaxes()` is true for any real change. `pin` or `decision` pass; `session` and `hq` are refused (`pin-or-decision-required`, `hq-cannot-grant`) |
| Preview links | `https://github.com/<repo>/commit/<sha>`, and while a pin exists `https://github.com/<repo>/compare/<old>...<new>`, so the owner can read the content they approve |
| New audit actions | `skills.pinned` `{ repo, commit, lockHash, added, changed, removed }`, `skills.pin-refused` `{ reason }` (reasons include `not-on-default-branch`), `skills.role-set` `{ role, added, removed }`, `skill.refused` `{ skill, reason: "hash" \| "missing" }`, `skill.drift` `{ changed, extra, missing, movedTo, deleted, linksSkipped }`, `skills.repo-findings` `{ repo, findings }`. `workspace.refused` gains `shared-skills` and `skills-link` |

## Review focus

1. **A repo that tracks `.claude/skills/<name>` for a skill in the agent's set.** The agent gets HQ's pinned copy, `git status` stays clean, and `git add -A && git commit` in the agent's folder does not commit HQ's copy.
   - Test: Task 5, `SR-F-05 [T-S12.3] a skill the repo tracks gets HQ's copy, and git does not see it`.
2. **The store copy edited on the host after the pin.** That skill is refused at the next start with a `skill.refused` row. The agent starts without it, and the activity says so.
   - Test: Task 5, `SR-F-01 [T-S12.5] a store copy changed after the pin is refused at install`.
3. **A pin that drops a skill a role uses.** The preview names each role that loses it. After the pin, the agent starts without it and the start line names it.
   - Test: Task 3, `the pin preview names the roles that lose a skill`.
4. **An owner-chosen folder holding the owner's own untracked skill.** It is moved, not deleted, and the audit row names where.
   - Test: Task 5, `SR-F-04 [T-S12.3] an extra skill in a chosen folder is moved to HQ's home, not deleted`.
5. **An agent switched from Claude Code to Codex.** Its skills move to `.agents/skills`, and `.claude/skills` is emptied.
   - Test: Task 5, `a Codex agent gets its skills in .agents/skills and none in .claude/skills`.

---

### Task 1: The lock and the role sets in the company store (SR-F-03)

**Files:**
- Create:
  - `server/company/schema/008_skills.ts`
  - `server/company/companySkills.ts`
  - `server/company/companySkills.test.ts`
- Modify:
  - `server/company/migrations.ts`
  - `server/company/index.ts` (`Company.skills`)
  - `server/company/authority.ts` (two change kinds)

**Interfaces:**
- Migration 008:
  - `skill_source(id INTEGER PRIMARY KEY CHECK (id = 1), repo TEXT NOT NULL, commit_sha TEXT NOT NULL, lock_hash TEXT NOT NULL, pinned_at TEXT NOT NULL)`;
  - `skill_lock(name TEXT PRIMARY KEY, hash TEXT NOT NULL, files_json TEXT NOT NULL, scripts_json TEXT NOT NULL)`;
  - `role_skills(role TEXT NOT NULL, skill TEXT NOT NULL, PRIMARY KEY (role, skill))`, seeded with the values table's sets;
  - `agent_sandboxes(agent_id TEXT PRIMARY KEY REFERENCES agents(id), skills_off_at TEXT NOT NULL)`.
- `authority.ts`: `ConfigChange` gains
  - `{ kind: "skills-pin"; before: string | null; after: string; lockHash: string }`;
  - `{ kind: "role-skills"; role: RoleId; before: string[]; after: string[] }`.

  `relaxes()` returns true when `before` differs from `after`.
- `companySkills.ts`:
  - `interface LockedSkill { name: string; hash: string; files: { path: string; mode: string; sha256: string }[]; scripts: string[] }`;
  - `class CompanySkills`:
    - `source(): { repo: string; commit: string; lockHash: string } | null`;
    - `lock(): LockedSkill[]`;
    - `roleSet(role: RoleId): string[]`;
    - `setRoleSkills(role: RoleId, names: string[], by: Authority): { added: string[]; removed: string[] }`. It goes through `ProjectSettings.authorized(changes, by, "company", write)` and writes `skills.role-set`;
    - `writePin(p: { repo: string; commit: string; lockHash: string; skills: LockedSkill[] }, by: Authority): void`, for Task 3's use only. It replaces `skill_source` and `skill_lock` in one transaction.

- [ ] **Step 1: Write the failing tests**
  - `the starting role sets are §2a's`: `roleSet("builder")` and `roleSet("cto")` equal the values table, and `roleSet("qa")` is `[]`.
  - `SR-F-03 [T-S12.4] a role set changes only with the PIN or an approved decision`:
    - `via: "session"` gets `pin-or-decision-required`, and `via: "hq"` gets `hq-cannot-grant`;
    - each refusal writes `settings.refused`, and the set reads back unchanged;
    - `via: "pin"` by the owner succeeds and writes `skills.role-set` with the owner as the actor;
    - `via: "decision"` with an `approved` row succeeds; with a `pending` row it gets `decision-not-approved`.
  - `SR-F-03 [T-S12.4] no agent tool changes skills`: no name in `HQ_TOOLS` contains `skill`, and `TOOLS_BY_ROLE` grants none.
  - `the lock lives only in the company store`: after `writePin`, no file named `*lock*` exists under any project home or agent folder the test made.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test`. Expected: the new tests fail (no migration 008).
- [ ] **Step 3: Implement** to the interfaces above.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: the skill lock and per-role skill sets live in the company store`.

---

### Task 2: Fetch, check and hash a commit of the skills repo (SR-F-01, SR-F-06)

**Files:**
- Create: `server/skillVendor.ts`, `server/skillVendor.test.ts`, `server/testing/skillsRepo.ts` (a fixture that builds a bare repo from a file map, with modes and links; it can put a commit under `refs/pull/1/head` only, and can write a raw tree entry with `git mktree`, which accepts names such as `..` and `a\b` that the index refuses)

**Interfaces:**
- Consumes `LockedSkill` (Task 1).
- `skillVendor.ts`:
  - `fetchCommit(o: { url: string; sha: string; bare: string; allowFile?: boolean }): Promise<{ ok: true; branch: string } | { ok: false; reason: "bad-sha" | "fetch-failed" | "not-on-default-branch" }>`. The commit must be 40 hex. It follows the values table's Fetch row: the default branch only, never the SHA, then the ancestry check.
  - `safeSkillPath(path: string): boolean`, the path rule from the values table.
  - `readCommit(bare: string, sha: string): Promise<{ skills: LockedSkill[]; refused: { skill: string; reason: string }[] }>`. Reasons: `link`, `submodule`, `mode`, `path`, `name`, `no-skill-md`, `too-big`.
  - `skillHash(files: { path: string; mode: string; sha256: string }[]): string`;
  - `lockHash(repo: string, commit: string, skills: { name: string; hash: string }[]): string`;
  - `writeStore(bare: string, sha: string, skill: LockedSkill, storeDir: string): void`, which writes `<storeDir>/<hash>/` from the git objects and sets each file's mode (POSIX);
  - `hashFolder(dir: string, files: LockedSkill["files"]): { hash: string } | { refused: "link" | "not-file" | "paths" | "mode" }`, per the values table's "Checking a folder on disk" row. The caller compares `hash` with the lock's.

- [ ] **Step 1: Write the failing tests** (fixture repos only):
  - `SR-F-01 [T-S12.1] a commit that is not on the skills repo's default branch is refused`: the fixture holds a commit under `refs/pull/1/head` only. `fetchCommit` answers `not-on-default-branch`, and the bare repo holds no object of that commit (`git cat-file -e` fails).
  - `fetchCommit accepts an older commit of the default branch`, so pinning an earlier commit still works.
  - `SR-F-01 [T-S12.5] the hash covers every file, not only SKILL.md`: changing one byte in `scripts/run.sh` changes the skill hash, and changing a file's mode changes it too.
  - `SR-F-06 [T-S12.5] a skill holding a link is refused` (mode `120000`), and `… a submodule is refused`.
  - `SR-F-06 [T-S12.5] a skill with a path that leaves its folder is refused`, two ways:
    - `safeSkillPath` is false for `../x`, `a/../../x`, `/etc/x`, `a\b`, `a\0b`, `a//b` and `./x`, and true for `scripts/run.sh`;
    - a fixture commit whose skill tree holds a raw `..` entry (written with `git mktree`) gets `readCommit` reason `path`, and the other skills in the commit are still read.
  - `SR-F-06 [T-S12.6] bundled scripts are listed`: an executable file and a `.py` file appear in `scripts`.
  - `a skill without SKILL.md, with a bad name, or over 256 files is refused`.
  - `fetching uses no credential helper and no prompt`: a fixture `credential.helper` set in the global config is not called (point `GIT_CONFIG_GLOBAL` at a file whose helper writes a marker file; the marker is absent).
  - `hashFolder matches skillHash for the same files`: the skill holds one `100755` file and one `100644` file; `writeStore` writes it, and `hashFolder` on the store copy equals the lock hash. It runs on both CI systems.
  - `hashFolder refuses a folder with a path the lock does not list, or missing one it lists` (`paths`).
  - `on POSIX, a file whose executable bit differs from the lock is refused` (`mode`; skipped on Windows).
  - `hashFolder refuses a folder holding a link` (skipped on Windows without symlink rights, as other link tests are).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Read blobs through one `git cat-file --batch` process per commit. Never run `git checkout` or anything inside a skill.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`.
- [ ] **Step 5: Commit** `feat: read a pinned commit of the skills repo with git only, refusing links and escaping paths`.

---

### Task 3: Pin a commit with a preview and the PIN (SR-F-01, SR-F-03)

**Files:**
- Modify: `server/company/companySkills.ts` (`preview`, `pin`), `server/commands.ts` (`makeCompanyCommands`: `previewSkillsPin`, `pinSkills`, `setRoleSkills`)
- Test: `server/company/companySkills.test.ts`

**Interfaces:**
- Consumes Task 2's functions and Task 4's `checkSkillsRepo`. Until Task 4 lands, the preview takes it as an injected `check` function.
- `CompanySkills`:
  - `preview(repo: string, commit: string): Promise<PinPreview>`, where `PinPreview = { repo; commit; lockHash; skills: { name; hash; files: number; scripts: string[] }[]; added: string[]; changed: string[]; removed: string[]; rolesLosing: { role: RoleId; skills: string[] }[]; findings: Finding[]; links: { commit: string; compare: string | null } }`. A commit that is not on the default branch is refused here too, with a `skills.pin-refused` row;
  - `pin(repo: string, commit: string, lockHash: string, by: Authority): Promise<void>`. It fetches and reads again, and refuses with `skills.pin-refused`:
    - `not-on-default-branch` (and `fetch-failed`, `bad-sha`) from `fetchCommit`;
    - `lock-changed` when the recomputed lock hash differs from the confirmed one;
    - `repo-check` when the SR-F-08 check has findings;
    - `refused-skill` when any skill is refused.

    Otherwise it writes the store, then `writePin`, then `skills.pinned`.
- Commands, all role `owner`, all with `target: () => null`:
  - `previewSkillsPin(repo, commit)`, which returns the preview;
  - `pinSkills(repo, commit, lockHash)` and `setRoleSkills(role, names)`, both with `pin: true`.

- [ ] **Step 1: Write the failing tests**
  - `SR-F-01 [T-S12.1] the pin installs only what the owner previewed`: the fixture repo gets a new commit on the same branch between preview and confirm, but the confirm names the old commit, so it pins the old content. A confirm with a changed `lockHash` gets `lock-changed`, writes `skills.pin-refused`, and the lock reads back unchanged.
  - `SR-F-01 [T-S12.1] a commit that is not on the skills repo's default branch is refused`: the fixture repo holds the commit under `refs/pull/1/head` only. `preview` and `pin` (by the owner, with the PIN) both refuse with `not-on-default-branch`, each writes `skills.pin-refused` with the owner as the actor, and the lock reads back unchanged.
  - `SR-F-01 [T-S12.5] a pin with one refused skill pins nothing`.
  - `the preview links the commit and, once a pin exists, the comparison from the old pin`.
  - `SR-F-03 [T-S12.4] pinning needs the PIN or an approved decision`, with the same four authorities as Task 1.
  - `the pin preview names the roles that lose a skill` (Review focus 3).
  - `a pin is refused while the skills repo check has findings` (fake check returning one finding).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck`.
- [ ] **Step 5: Commit** `feat: the owner pins a commit of the skills repo from a preview, with the PIN`.

---

### Task 4: Check the skills repo at pin and daily (SR-F-08)

**Files:**
- Create: `server/skillsRepoCheck.ts`, `server/skillsRepoCheck.test.ts`
- Modify: `server/startHq.ts` (the daily timer, through the clock), `src/data/types.ts` (`snap.skillsGuard: { repo: string; checkedAt: string; findings: Finding[] } | null`)

**Interfaces:**
- `checkSkillsRepo(api: GitHubApi, repo: string, o: { owner: string; agents: { id: string; installed: boolean | "unknown" }[] }): Promise<Finding[]>`. Finding names:
  - `skills-private-unprotected`;
  - `skills-rules-missing:<rule>`;
  - `skills-collaborator:<login>`;
  - `skills-deploy-key:<id>` (a key with `read_only: false`);
  - `skills-app-installed:<agent>`;
  - `read-failed:<what>`.

  A new finding writes `skills.repo-findings` and an activity line, once per finding, as `RepoWatch` does.

- [ ] **Step 1: Write the failing tests** (fake `GitHubApi`):
  - `SR-F-08 [T-S12.8] an agent App installed on the skills repo is a finding`.
  - `SR-F-08 [T-S12.8] a second collaborator is a finding`.
  - `SR-F-08 [T-S12.8] a deploy key with write access is a finding`, and a read-only key is not.
  - `SR-F-08 [T-S12.8] a missing deletion or non-fast-forward rule is a finding`, and `a private repo whose rules GitHub will not read (403) is a finding`.
  - `a failed read is a read-failed finding, never a pass`.
  - `the check runs again 24 hours after HQ starts` (fake clock).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** `feat: HQ checks that only the owner can change the skills repo`.

---

### Task 5: Install the agent's set at every start, from HQ's store (SR-F-01, 02, 04, 05)

**Files:**
- Modify:
  - `server/skills.ts`: `ensureSkillCache`, `prepareSkills` and the npx call are removed; `installSkills` replaces them, using `server/lib/agentFs.ts` for every path in the agent's folder;
  - `server/sessions.ts` (start);
  - `server/commands.ts` (the stack change no longer pre-fetches);
  - `server/agentIsolation.ts` (`isolateClone` sets `sparse.expectFilesOutsideOfPatterns`; the git message says 2.37);
  - `src/data/stack.ts` (the `SkillSpec.source` comment: provenance for vendoring, never fetched).
- Test: `server/skills.test.ts`, `server/skillsNoNpx.test.ts`

**Interfaces:**
- Consumes `CompanySkills` (Task 1) and `hashFolder` (Task 2).
- `skills.ts`:
  - `effectiveSkills(o: { roleSet: string[]; grants: string[]; stack: string[]; companyLevel: boolean; lock: LockedSkill[] }): { install: LockedSkill[]; missing: string[] }`. A company-level agent gets no stack skills.
  - `installSkills(o: { workspace: string; cli: "claude" | "codex"; want: LockedSkill[]; storeDir: string; movedDir: string; rename?: typeof renameSync }): { installed: string[]; refused: { skill: string; reason: "hash" | "missing" }[]; drift: { changed: string[]; extra: string[]; missing: string[]; movedTo: string | null; deleted: string[]; linksSkipped: string[] } } | { blocked: string }`. `rename` is injectable so a test can throw `EXDEV`.
  - It runs no process. Every step in the agent's folder follows the values table's "The agent's folder" row. Order:
    0. Check `.claude`, `.agents` and both install folders with `agentMkdir`. A link there returns `{ blocked }` before anything is read, moved or copied.
    1. List each install folder through `agentPath`. Compare each entry against `want` with `hashFolder(dir, files)`; a link entry, a non-folder, or a refusal counts as changed.
    2. Remove a link entry with `agentRemove` (its target untouched). Move every other changed or extra folder to `movedDir` per the "Drift moves" row (rename, `EXDEV` fallback without following links, the 256-file / 2 MiB cap).
    3. Re-hash each wanted store folder and refuse a mismatch.
    4. Copy each into `agentPath(workspace, <folder>/<name>)`, setting modes (POSIX).
    5. Hash the copy and refuse a mismatch, removing the copy with `agentRemove`.
    6. `excludeFromGit` the installed folders.
- `sessions.ts` writes:
  - `skill.refused` per refusal;
  - one `skill.drift` row when anything drifted;
  - one activity line naming refused and missing skills;
  - on `{ blocked }`, `workspace.refused` `{ reason: "skills-link" }`, and the start is refused: the agent's CLI would read skills through the link.

  Otherwise the start goes on either way.

- [ ] **Step 1: Write the failing tests**
  - `SR-F-01 [T-S12.5] a store copy changed after the pin is refused at install` (Review focus 2): change one byte in a bundled file of the store copy. That skill is not in the agent's folder, a `skill.refused` row has `reason: "hash"`, and the other skills install.
  - `SR-F-02 [T-S12.2] a session start fetches nothing`: with the store filled, the bare repo deleted and `PATH` emptied for the call (so no `git`, `npx` or `npm` could run), `installSkills` installs the pinned skills.
  - `SR-F-02 [T-S12.2] server/ holds no npx call` (`skillsNoNpx.test.ts`): no file under `server/` other than tests contains `npx` outside a string shown to the user. The check matches `"npx"` and `'npx'` as an argument, and the three `main.ts` help texts are allowed by name.
  - `SR-F-04 [T-S12.3] an edited skill and an added one are both gone after the next start, with one drift row`: one `skill.drift` row lists both, and `movedTo` exists and holds them.
  - `SR-F-04 [T-S12.3] an extra skill in a chosen folder is moved to HQ's home, not deleted` (Review focus 4).
  - `SR-F-05 [T-S12.3] a skill the repo tracks gets HQ's copy, and git does not see it` (Review focus 1):
    - set up a real HQ clone (`isolateClone`) of a fixture repo that tracks `.claude/skills/test-driven-development/SKILL.md` with other text;
    - after install, the file holds the pinned bytes;
    - `git status --porcelain` is empty;
    - `git add -A && git commit` leaves that path unchanged in `HEAD`.
  - `SR-F-05 [T-S12.3] a skill the repo tracks that is not in the set is absent`.
  - `git status is clean with one tracked and one untracked skill installed`: in the same HQ clone, one wanted skill is tracked by the repo and one is not; `git status --porcelain` is empty after install.
  - `an agent's link at .claude/skills is refused and nothing is moved`: `.claude/skills` is a link to a folder outside holding one skill. `installSkills` returns `blocked`, the start writes `workspace.refused` `{ reason: "skills-link" }`, the outside folder is unchanged, and `movedDir` is empty. (Link tests are skipped on Windows without symlink rights.)
  - `a linked skill folder is removed as a link, and its target is unchanged`: `.claude/skills/test-driven-development` is a link to an outside folder. After install, that path is HQ's copy (a real folder), and the outside folder's files are unchanged.
  - `a move across drives copies without following links`: the injected `rename` throws `EXDEV`. An extra skill holding a link to an outside file lands in `movedTo` without the link (named in `linksSkipped`), its source is gone, and the outside file is unchanged.
  - `an extra skill over 256 files is removed, not moved, and the drift row says so` (`deleted` names it).
  - `a Codex agent gets its skills in .agents/skills and none in .claude/skills` (Review focus 5).
  - `a stack skill that is not pinned is named in the start line, and the agent starts`.
  - `the moves keep the newest 5 per agent`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Delete `ensureSkillCache`, `prepareSkills`, `hasHqSkills` and `skillSkippedText`, together with the tests that only covered them. Every agent's start calls `installSkills`, company-level agents included.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck && npx tsx scripts/session-backend-test.ts`.
- [ ] **Step 5: Commit** `feat: each start installs exactly the agent's pinned skills and records any drift`.

---

### Task 6: No skills from sbx's shared store

**Files:**
- Modify: `server/sessions.ts` (`sbxRunArgs`, start, `recreate`), `server/sbx.ts` (`sharedSkills(): Promise<"empty" | "some" | "unknown">`)
- Test: `server/sessions.test.ts` (or the file that holds the `sbxRunArgs` tests)

**Interfaces:**
- `sbxRunArgs` takes `skillsOff: boolean` and puts `--skills off` before the agent name when true. Start passes `true` when it creates the sandbox, and writes `agent_sandboxes`.
- For an existing sandbox with no `agent_sandboxes` row:
  - `sharedSkills()` must be `"empty"`;
  - `"some"` refuses with `workspace.refused` `{ reason: "shared-skills" }`: "Recreate sandbox: it was made before HQ turned sbx's shared skills off, and that store has skills in it.";
  - `"unknown"` refuses with `keys-unread`'s wording for skills.

- [ ] **Step 1: Write the failing tests**
  - `a new sandbox is created with sbx's shared skills off`.
  - `an old sandbox starts only while sbx's shared skills store is empty` (the three answers).
  - `recreating a sandbox records skills off`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Parse `sbx skills ls`: the text "No skills found" means empty.
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck && npx tsx scripts/session-backend-test.ts`.
- [ ] **Step 5: Commit** `fix: sandboxes HQ creates get no skills from sbx's shared store`.

---

### Task 7: The dashboard: Settings → Skills

**Files:**
- Create: `src/ui/settings/SkillsSettings.tsx`, `src/ui/settings/SkillsSettings.test.tsx`
- Modify:
  - `src/ui/settings/SettingsModal.tsx` (the company section gets "Skills");
  - `src/ui/settings/TeamSettings.tsx` (the per-agent skills field);
  - `src/ui/settings/StackSettings.tsx` (each stack skill shows pinned or not);
  - `src/data/types.ts` (`snap.skills: { source; lock: { name; hash; files; scripts }[]; roles: Record<RoleId, string[]> } | null`);
  - the server snapshot that fills it.

**Interfaces:**
- Consumes Task 3's commands (`PinPreview.links`) and Task 4's `snap.skillsGuard`.
- Skills panel:
  - shows the repo, the pinned commit (7 characters, linked to GitHub) and the repo check's findings;
  - lists each skill with its short hash, file count and scripts;
  - has a role grid with one checkbox per role and skill, saved with the PIN;
  - has a "Pin a commit" field leading to the preview (added, changed and removed skills, scripts, roles losing a skill, the lock hash, and links to the commit and to the comparison from the current pin), then Confirm with the PIN.
- Per-agent field: the free-text skills field becomes checkboxes of the pinned names.

- [ ] **Step 1: Write the failing tests** (`renderToStaticMarkup`, as `LocalModeNotice.test.tsx` does):
  - `the preview lists the scripts and the roles that lose a skill`;
  - `the preview links the commit and the comparison`;
  - `Confirm sends the previewed lock hash`;
  - `a stack skill that is not pinned says so`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Skill text from the repo (names, file paths) is shown as plain text, never as markup (SR-C escaping).
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck && pnpm build`.
- [ ] **Step 5: Commit** `feat: Settings → Skills: pin a commit from a preview and edit role sets`.

---

### Task 8: Vendor the starting sets into the skills repo (SR-F-07)

This task's code lives in `NdururiJr/canoeney-skills`, through a pull request there that the owner merges. This repo gets only the ADR.

**Files (skills repo):**
- `README.md`: the layout, how to vendor, and the edit rules below.
- `LICENSE`.
- `skills/<name>/…` for the seven role skills and the stack skills in use.

**Files (this repo):** `docs/adr/0011-vendored-skills.md`.

**Vendoring and edit rules** (the skills PR body checks each skill against each rule):
1. Copy the folder from upstream at one commit. Write `UPSTREAM.json` and `LICENSE.upstream`. For superpowers the source is `obra/superpowers`, MIT.
2. Replace "your human partner" and "the user" (where they mean the person directing the agent) with "your manager (message them with `send_message`)".
   - Where the skill stops and waits for a person, it says: "send your manager the question with `send_message` and wait for the reply".
3. Remove every reference to a skill outside the role's set and to work HQ owns. This covers:
   - using-git-worktrees, subagent-driven-development, dispatching-parallel-agents and finishing-a-development-branch;
   - dispatching subagents;
   - creating worktrees or branches outside the agent's own `<agent id>/…` names.
   
   Point to "your role file" instead.
4. No path that leaves the skill's folder (`../`), and no link. A script that reached another skill's folder is removed, or rewritten to stand alone.
5. **SR-F-07:** no company policy in a skill. That means no rule about authority, approvals, money, confidentiality, honesty toward the owner, or what needs the owner.
   - Such text is removed and, where it matters, written up for the owner to put into `Knowledge`.
   - The PR body lists each removal.
6. brainstorming is trimmed: the visual companion and its scripts are removed.
7. Stack skills: those of every stack set on a company project today, read from the store at the time of the PR. Edit rules 2–5 apply.

- [ ] **Step 1:** In a clone of the skills repo, on branch `vendor/starting-sets`, copy and edit each skill by the rules. Run Task 2's `readCommit` on the branch head through a small script in the scratchpad. Expected: no refusals, and the script list matches what the PR body names.
- [ ] **Step 2:** Open the PR on `NdururiJr/canoeney-skills`. Its body has a table with one row per skill: source and commit, rules 2–7 each ticked or explained, the scripts, and the SR-F-07 removals.
- [ ] **Step 3:** Write ADR 0011. It covers:
  - one company repo, not per-upstream forks, and why;
  - the hash definition, and that Windows does not check the mode on disk;
  - the preview-then-PIN pin, on default-branch commits only;
  - install from HQ's store, with no fetch at start;
  - moves rather than deletes;
  - superpowers as the one family, and jsm-skills-workflow left out;
  - sbx's shared store off;
  - the shadowing fix;
  - the known limit: a skill an agent writes to its sandbox home stays until "Recreate sandbox" (carried to M1.8);
  - the narrow readings above.
- [ ] **Step 4: Commit** (this repo) `docs: ADR 0011, vendored and pinned skills`.
- [ ] **Step 5: Stop and tell the owner** that the skills PR is ready for review and merge. The exit check pins its merge commit.

---

### Task 9: M0-E carry-forward

**Files:**
- Modify:
  - `server/github/tokens.ts`, `server/github/repoGuard.ts`, `server/github/apps.ts`, `server/projectRuntime.ts`, `server/commands.ts`, `server/agentFiles.ts`;
  - `src/data/ws/wsSource.ts`, the top bar's Settings button, `docs/how-it-works.md`.
- Tests: next to each file (`tokens.test.ts`, `repoGuard.test.ts`, `apps.test.ts`, …), one per item.

Items from the PR #12 review (non-blocking), then the M0-E final review's deferred minors:

1. **`revoke` with no token held** still calls `sbx.removeKey(agentId, "github")` and writes `github.token-revoked` `{ reason, held: false }`.
   - Test: `SR-E-07 [T-S3.9] revoking an agent that holds no token still clears its sandbox key`.
2. **The refresh delay has a floor of 60 s** (also for NaN and negatives). A failed refresh is retried once after 60 s. If that fails too, an activity line says "<agent>'s GitHub token could not be refreshed; it stops working at <hh:mm>".
   - Tests: `a refresh due in the past waits 60 s`, `a failed refresh retries once, then says so`.
3. **`hq-unclaimed` restricts deletion too**, and the M0-E exit check's step 4 gains the line "delete an unclaimed branch as an agent: refused".
   - Test: the ruleset body in `repoGuard.test.ts` lists `deletion`.
4. **A failed installation lookup** in `guardAgents` gives `installed: "unknown"` and a `read-failed:app:<agent>` finding, and `applyRepoGuard` writes no ruleset while one is present.
   - Test: `an App lookup that fails is a read-failed finding, and Apply writes no ruleset`.
5. **A mark on the top bar's Settings button** while the GitHub guard or the skills repo check has findings. M1's alert channel takes them later, as a new overview row.
   - Test: `the Settings button shows a mark while a guard has findings`.
6. **The owner's task text:** the dashboard has no command that sets task text. The owner can only assign, and `sendMessage` and `resolveActionItem` are already checked.
   - `docs/how-it-works.md` says so.
   - Test: `no owner command sets task text unchecked`. It fails if `makeCommands` gains a command whose name matches `/task/i` other than `assignTask`.
7. **The SR-E-07 test titled `[T-S3.11]`** is renamed `[T-S3.9]`.
8. **The GitHub return is sent once:** `wsSource.ts` clears it after the first send.
   - Test: `a reconnect does not send the GitHub return again`.
9. **`.*.hq-tmp-*` is git-excluded** in every agent folder, so a crash's leftover temp file is never committed.
   - Test: the exclude file holds the pattern after a start.
10. **`GitHubApps.pending` drops states older than 10 minutes** whenever `start` is called.
    - Test: `old manifest states are pruned`.
11. **`createGithubIdentity` refuses a company-level agent** (`COMPANY_ROLES`) with "Company-level agents don't reach GitHub (SR-D-06)."
    - Test: `SR-D-06 a company-level agent gets no GitHub identity`.
12. **The guard's `private` flag comes from GitHub's `private` field.** `checkRepo` returns `{ findings, private: boolean | null }`, and `RepoWatch` and the UI read it.
    - Test: `a public repo with a confirmed spending limit is not shown as private`.

- [ ] **Step 1: Write the twelve tests.**
- [ ] **Step 2: Run them and confirm each fails.**
- [ ] **Step 3: Implement each.**
- [ ] **Step 4: Run them and confirm they pass.** Run: `pnpm test && pnpm typecheck && pnpm build`.
- [ ] **Step 5: Commit** `fix: M0-E review leftovers (token revoke and refresh, guard reads, unclaimed deletion, drift mark)`.

---

### Task 10: Docs

**Files:** `docs/how-it-works.md`, `docs/getting-started.md`, `CONTRIBUTING.md` (release notes)

- [ ] **Step 1:** Write:
  - how-it-works: where skills come from, how to pin a commit, role sets, what happens to a changed or extra skill, and that a session start fetches nothing;
  - getting-started: "pin the company's skills" as a setup step, and git 2.37;
  - release notes: `npx skills add` is gone, stack skills need vendoring, and old sandboxes may need "Recreate sandbox".
- [ ] **Step 2: Commit** `docs: per-role skills from the company's skills repo`.

## Exit check for M0-F

Run by the builder with the owner, on the owner's desktop, against `NdururiJr/canoeney-skills` and the website project.
1. The owner merges Task 8's PR on the skills repo.
2. Settings → Skills shows no repo findings. Preview the merge commit: seven role skills, the stack skills, and the listed scripts. Confirm with the PIN, and check the `skills.pinned` row.
3. Start a builder in a sandbox. Its `.claude/skills` holds exactly the four builder skills, and each folder's hash equals the lock.
4. **SR-F-01:** change one byte of a bundled file in HQ's store copy and restart the builder. That skill is refused, and a `skill.refused` row has `reason: "hash"`. Then put the byte back.
5. **SR-F-04:** in the builder's sandbox, edit one installed skill and add an extra one, then restart. Both are back to the pinned set, and one `skill.drift` row names them and where they went.
6. **SR-F-05:** commit `.claude/skills/test-driven-development/SKILL.md` with other text to an agent branch, then start the builder there. Its copy is HQ's, and `git status` inside the sandbox is clean.
7. **SR-F-08:** install one agent App on the skills repo. The check reports `skills-app-installed`, and a pin is refused. Uninstall the App. Then the owner opens the skills repo's Settings → GitHub Apps page: it lists no App (third-party Apps such as CodeRabbit are not visible to HQ's check).
8. **sbx shared store:** `sbx skills add` a throwaway skill on the host, then create a fresh agent sandbox. `sbx exec <sandbox> ls ~/.claude/skills` does not list it, and neither do the workspace's `.claude/skills` and `.agents/skills`. Remove it with `sbx skills rm`.
9. **SR-F-02:** with the network off, start the builder. Its skills install from the store. The model call fails, which is expected.
10. **SR-F-01, a stranger's commit:** open a throwaway pull request on the skills repo from a branch, and preview its head SHA in Settings → Skills. It is refused `not-on-default-branch`. Close the pull request and delete the branch.

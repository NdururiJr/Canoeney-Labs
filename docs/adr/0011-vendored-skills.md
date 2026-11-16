# ADR 0011: Vendored and pinned skills

- **Status:** accepted (M0-F)
- **Spec:** M0.18 (skills vendored into company-owned copies, pinned by hash, installed per role; policy only in `Knowledge`; one skill family per concern), §2a "Skills", S12 in §2b
- **Requirements:** `docs/security/threat-model-m0.md` §3, SR-F-01 to SR-F-08 (T-S12.1 to T-S12.8)
- **Owner decisions:** the skills repo is `NdururiJr/canoeney-skills`, public (2026-11-15); D1, a skill committed to a managed repo is not loaded (2026-11-12)

## Context

Until M0-F, HQ installed each stack's skills with `npx skills add` straight from upstream GitHub repos (`server/skills.ts`), and agents could edit the copies in their own folders. Whoever controlled an upstream repo could change every agent's instructions overnight (T-S12.1, T-S12.2). An agent, or a repo it cloned, could change its own (T-S12.3). A skill could also carry a link or a path out of its folder (T-S12.5, T-S12.6), and policy written into a skill would sit outside the owner's `Knowledge` slot (T-S12.7).

## Decision

### One company repo, not per-upstream forks

Every vendored skill lives in one repo the owner controls, `NdururiJr/canoeney-skills`. Its layout is `skills/<name>/SKILL.md` plus the skill's files, with `<name>` matching `^[a-z0-9][a-z0-9-]{0,62}$`. Each skill also holds `UPSTREAM.json` (`{ repo, commit, path, license }`) and its upstream licence as `LICENSE.upstream`.

The spec says "company-owned forks". One repo is a narrow reading of that, and here is why:
- A GitHub fork carries the upstream repo's whole history, branches and settings. The SR-F-08 check (branch rules, collaborators, deploy keys, App installations) would then have to run on every fork.
- One repo gives one place for those rules and one commit to pin.
- One pull request can show every edit to every skill side by side.

The repo is public because GitHub Free gives a private repo no rulesets (GitHub answered 403). Public also means HQ fetches it with no stored credential. A ruleset on the default branch blocks deletion and non-fast-forward pushes. The owner is the only collaborator, and no agent App is installed on it. A required pull-request review is not demanded: the owner is the only writer, and GitHub does not let an author approve their own pull request.

Skills reach the repo through a pull request that the owner reviews (Task 8). The edit rules are written in the repo's README:
- "your human partner" becomes "your manager", reached with `send_message`;
- references to skills outside the role's set, to subagents, and to worktrees or branches HQ owns are removed, and the skill points to the role file instead;
- no `../` path and no link;
- no company policy (SR-F-07). Each removal is listed in the pull request, with a note the owner can put into `Knowledge`.

### The hash

A **skill hash** is sha256 hex over one line per file, `"<mode> <path>\0<sha256 hex of the file's bytes>\n"`, with the lines sorted bytewise by path. The path is relative to the skill folder and uses `/`.

The **lock hash** is sha256 over the canonical JSON of `{ repo, commit, skills: [{ name, hash }] }`, with the skills sorted by name.

`hashFolder` checks a folder on disk against the locked file list:
- the folder must hold exactly those paths, all regular files, walked with `lstat` (no link followed);
- it hashes the bytes on disk and takes each mode from the lock.

On POSIX it also requires the executable bit to match the mode (`100755` means `0o100` is set). **Windows does not check the mode on disk**, because NTFS keeps no executable bit. On Windows, the bytes and the file list are what is checked.

### Preview, then pin with the PIN, on default-branch commits only

The owner pins **one 40-hex commit for the whole repo** in Settings → Skills. Every skill in the repo is pinned at that commit.

1. **Preview.** HQ fetches the repo's default branch and checks that it holds the commit:
   - `git ls-remote --symref` names the branch;
   - `git fetch --no-tags <url> +refs/heads/<branch>:refs/hq/default` fetches it into a bare repo in HQ's home;
   - `git merge-base --is-ancestor <sha> refs/hq/default` checks the commit.

   HQ never fetches a commit by its SHA, because GitHub serves a stranger's pull-request commit by SHA. A commit that is missing or not on the branch is refused (`not-on-default-branch`).

   HQ then reads the commit with `git ls-tree` and `git cat-file --batch`; nothing is checked out. The whole pin is refused (SR-F-06) if any skill has:
   - a link, a submodule, or a mode other than `100644`/`100755`;
   - a path with a `.` or `..` segment, an empty segment, a leading `/`, a `\` or a NUL;
   - a name Windows cannot hold;
   - two paths that differ only in case;
   - no `SKILL.md`;
   - more than 256 files or 2 MiB.

   The preview shows each skill's hash, its scripts (mode `100755` or a script extension), the lock hash and links to the commit and the compare view.
2. **Pin.** The owner confirms with the PIN and sends back the lock hash they saw. HQ checks the default branch again, writes each skill's content to its store at `<company home>/skills/store/<skill hash>/`, and records the lock in the company store (`skills.pinned`).

A pin, like a role-set change, is a `ConfigChange` that only the PIN or (from M1) a category 2 decision may make. The same holds for an agent's own grants.

### Install from HQ's store, with no fetch at start

At every session start HQ works out the agent's set: the role's skills, the agent's grants and the project's stack skills. Only pinned skills install. Any other name is reported as `missing` (`skill.refused`), and the start goes on without it.

HQ copies each skill from its own store into the folder the agent's CLI reads: `.claude/skills/<name>` for Claude Code, `.agents/skills/<name>` for Codex. The other folder is kept empty. HQ re-hashes the store copy before the copy and the installed folder after it. A start fetches nothing and runs nothing a skill holds; the only process the install path ever starts is `git`, at pin.

Every step in the agent's folder goes through `server/lib/agentFs.ts` and walks with `lstat`. A link at `.claude`, `.agents`, `.claude/skills` or `.agents/skills` refuses the start (`skills-link`), and nothing is moved or copied. A link at `<install folder>/<name>` is removed as a link; its target is untouched.

Stack skills install only once they are vendored and pinned. The live `npx skills add` fetch is gone, because that fetch is the threat. At the time of the vendoring pull request, the owner's store had no project with a stack set, so no stack skill was vendored.

### Moves, not deletes

A skill folder in the agent's folder is **changed** if its hash differs from the lock, and **extra** if it is not in the set. HQ moves both out to `<project home>/_skills-removed/<agent id>/<UTC stamp>/`, or the same path under the company home for a company-level agent. It keeps the newest 5 moves per agent.

- **The folder is named `_skills-removed`, not `skills-removed`** (a ruling during the build). Its `_` is outside the agent-id alphabet, so no agent id or clone can collide with it, as with `_company`.
- **Moves, not deletes.** In an owner-chosen folder, an extra skill may be the owner's own files. SR-F-04 says the extras are "gone"; HQ reads that as gone from the agent's folder.
- **Another drive.** A move is a `rename`. On `EXDEV` (another drive), HQ copies file by file with `lstat`, then removes the source. Links **and other special files** are not copied; they are named in the row (`linksSkipped`).
- **Too big to move.** A changed or extra folder over 256 files or 2 MiB (regular files counted, links not followed) is never moved or deleted. The start is refused (`skills-too-big`) before anything is moved. The message names the absolute path, so the owner can move the folder out.
- **The drift row.** A `skill.drift` row (`{ changed, extra, missing, movedTo, linksSkipped }`) is written whenever `changed`, `extra` or `missing` is non-empty. So a first start records the newly installed skills as missing, and a skill the agent deleted is drift too.

HQ never deletes anything in the agent's folder except a link.

### superpowers as the one family; jsm-skills-workflow left out

Agents get one skill family per concern. That family is superpowers (`obra/superpowers`, MIT): the §2a starting sets are superpowers skills, and the vendored copies are from tag `v7.0.2`. The starting sets are:

| Role | Skills |
|---|---|
| builder | test-driven-development, systematic-debugging, verification-before-completion, executing-plans |
| cto | writing-plans, requesting-code-review, brainstorming |
| ceo and cio | verification-before-completion |

jsm-skills-workflow (the `debug`, `plan`, `review`, `honest` and other skills this repo carries under `.claude/skills` and `.agents/skills` for its own development) is **not vendored for agents**:
- It overlaps superpowers on debugging, planning and review, and an agent must never hold two procedures for the same job.
- superpowers alone also covers test-first work, verification and plan execution.
- Its `honest` skill is a rule about honesty, which SR-F-07 keeps out of skills; that belongs in `Knowledge`.

It stays in this repo for work on HQ itself.

### sbx's shared skills store off

sbx can give every sandbox the skills from its own shared store, which would add skills outside the pin. HQ creates every new sandbox with `sbx run … --skills off` and records that it did so.

An existing sandbox without that record starts only if `sbx skills ls` lists nothing. Otherwise the start is refused (`shared-skills`) and the owner is told to recreate the sandbox. HQ also refuses a start whenever it cannot read sbx's sandbox list, because then it cannot tell a new sandbox from an existing one.

### The shadowing fix

A repo that tracks `.claude/skills/<name>` would otherwise shadow HQ's copy, or show up as a change in `git status`. HQ's clones set `sparse.expectFilesOutsideOfPatterns=true`. HQ then writes its copy even where the repo tracks that path, git keeps the path skip-worktree, `git status` stays clean, and a commit leaves the repo's file unchanged. This needs git 2.37 or later (it was 2.35). Every folder HQ installs is also added to the clone's git exclude.

So D1 holds: a skill committed to a managed repo is not loaded (SR-F-05).

The D1 agent-config check refuses a start when a tracked agent-configuration path is on disk in the agent's folder. It exempts exactly `.claude/skills/` and `.agents/skills/` (exact case, at the clone's top level), and **only in HQ's own clones**: `installSkills` replaces those folders with the pinned copies before launch, so what is on disk there is HQ's copy, not the repo's file. A case variant (`.Claude/Skills/`) is still refused. An owner-chosen folder gets no exemption.

## Known limits

- **A skill an agent writes to its sandbox home stays until "Recreate sandbox".** An agent can write a skill to its own sandbox home (`~/.claude/skills` inside the sandbox). Its CLI loads it, and it stays until the sandbox is recreated. HQ's re-sync covers the two workspace folders only. The skill reaches only that agent, as T-S6.10 does. The overview carries it to Security & Audit (M1.8).
- **A sandbox removed or recreated outside HQ leaves HQ's skills-off record stale.** The record says HQ made that agent's sandbox with skills off. If the owner removes or recreates the sandbox with sbx directly, the record is not updated. HQ decides "new or existing" only from a readable `sbx ls`, and refuses the start whenever it cannot read the list. The remaining risk is a sandbox recreated outside HQ without `--skills off`, which the stale record would then let start.
- **Third-party Apps on the skills repo** cannot be listed with the owner's `gh`. The M0 exit check covers them by hand.

## Where this reads the spec narrowly

- **"Company-owned forks"** is read as one company repo (above).
- **"Branch protection" (SR-F-08)** is read as the default-branch rules, the owner as the only collaborator, and no agent App installed. No required review (above).
- **"Gone" (SR-F-04)** is read as moved out of the agent's folder into HQ's home (above).
- **SR-F-07 is a review item, not code.** The vendoring pull request carries the check skill by skill and lists each removal.
- **"A `../` path" (SR-F-06)** is a file path in the pinned commit that leaves its skill's folder, and the code refuses it. A `../` written inside a skill's text or script is not something HQ can judge; the review removes it (edit rule 4).
- **Category 2 decisions arrive in M1.** In M0 the owner's PIN is the only working authority. The `decision` path goes through the same `authorized()` check and is tested with an approved row written directly.
- **Three §2a skills wait for M1:** humanizer and the charter-first planning skill (CEO), and the company-audit skill (Security & Audit). No CEO or Security & Audit agent runs in M0, and two of the three are new work.

## Consequences

- An upstream change reaches agents only when the owner merges it into the skills repo and pins the merge commit with the PIN.
- Each start puts back exactly the pinned set. An agent's edit to an installed skill, or an extra skill, lasts only until its next start, and the audit trail records where it went.
- Vendoring a new skill is a pull request on the skills repo plus a pin. Updating one is the same, re-applying the edit rules to the new upstream copy.
- A project's stack skills are missing until they are vendored and pinned, and the start says so.

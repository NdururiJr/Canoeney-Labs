# ADR 0009: One HQ runs many projects

- **Status:** accepted (M0-D2)
- **Spec:** M0.12 (the company sits above projects; HQ's own source is off-limits), M0.14 (company-level workspaces), the §6 exit item "company configuration and `plan.json` live in the company store"
- **Requirements:** `docs/security/threat-model-m0.md` §3.3, SR-D-03, SR-D-05, SR-D-06 and SR-D-09
- **Owner decisions:** M0-D scope (2026-11-12); a reused folder name is the old project only when its GitHub repo matches too (2026-11-14)

## Context

Until M0-D2, one HQ process ran one project: the repo it was started in. `main.ts` built one `Hub`, `Sessions`, `Inbox`, `Planner`, `Sbx`, `SbxMcp`, `GitHubSync` and command table for it. The company needs several repos at once (the website first), each isolated from the others, and HQ's own source must never be one of them.

## Decisions

### One runtime per project, not one project-aware hub

`ProjectRuntime` holds everything HQ builds for one project. `Projects` holds one runtime per registered project whose folder is a git repo.

We did not make `Hub`, `Sessions` and the rest project-aware. Each of those classes already keys its state by the project slug: session names, folders, sandbox names, the plan. The store keys every project table by project id (M0-D1). So a second runtime is the same code run again with a different slug. That is the smallest change that keeps each project's state out of reach of the others.

What every project shares:
- the HTTP server and its one port;
- the company store, its audit trail and the owner's login;
- sbx's global settings. A sbx secret or policy set "for every sandbox" reaches the sandboxes of every project. HQ cannot scope it, so SR-D-06 refuses a company-level sandbox while a GitHub key is set globally.

### Routing

- `/mcp` and `/hook`: the caller's secret names its agent row, and the row names its project. The request goes to that project's runtime. A project with no open runtime answers like any other refusal (401, `auth.failed` with reason `other-project`).
- **The dashboard:** each WebSocket views one project. It starts on the project HQ was started in, or else on the first open one. `{ "type": "select", "projectId": "…" }` switches it. HQ answers with that project's snapshot, and later events come from that project only.
- **Commands:** a connection's commands act on the project it views. `addProject` acts on the company. Every `dashboard.command` row carries `data.project`.

### Registering projects

- **The repo HQ is started in** (or `--repo`) is registered as before, with no PIN: starting HQ on the host is already the owner's act.
- **The owner adds a project from the dashboard** with the PIN (`project-added` relaxes a control, SR-D-03).
- **Both refuse:**
  - HQ's own source (SR-D-05): any remote is one of HQ's repos, in any URL form or case; the repo carries HQ's package name; or it is, holds or sits inside the folder HQ runs from;
  - a folder that is, holds or sits inside HQ's home or the company store. Agents' managed clones are git repos there.
- **A refusal from the dashboard** writes `project.refused` with the caller and the reason.
- **HQ started inside its own source** (`pnpm dev:hq` without `--repo`) registers nothing. If the store has projects, HQ opens them; if not, it stops with "No project to open. Run HQ in your project's repo, or pass --repo <path>."
- **A stored project HQ cannot open** is listed, never opened:
  - `missing`: its folder is gone or is not a repo;
  - `hq-source`: an older HQ registered HQ's own source. Its agents' clones stay on disk, untouched.

### A moved repo

A new repo takes over a stored project only when both are true:
- the project's folder is gone;
- the project's stored GitHub repo equals the new repo's, compared in lower case and both set.

Otherwise it is a new project (`<slug>-2` and so on). A project id carries grants, Local mode and approved notes, so a different repo that reuses a deleted repo's folder name must not inherit them.

### Session names

Sessions and sandboxes are named `hq-<project>-<agent>`. Project `a` with agent `b-c` and project `a-b` with agent `c` would share a name, so registering an agent whose session name another agent already has is refused, in any project.

## Consequences

- One HQ process, one port, one login for every project.
- A fault in one project's runtime (a failed setup check, a missing folder) leaves the others running.
- `pnpm dev:hq` in HQ's own repo now needs `--repo <project folder>` the first time.
- sbx settings made "for every sandbox" apply to every project. This is documented, and SR-D-06 checks for a GitHub key.

# ADR 0008: The company store holds the configuration

- **Status:** accepted (M0-D1)
- **Spec:** M0.11, surface S7 (§2b, extended to agent configuration files by D1), §9 item 2, the §6 exit item "company configuration and `plan.json` live in the company store"
- **Requirements:** `docs/security/threat-model-m0.md` §3.3, SR-D-01, 02, 03, 04, 07, 08, 10 and 11
- **Owner decisions:** D1 (2026-11-12)

## Context

Until M0-D1, a project's team, workflow and sandbox rules lived in `.jsmhq/config.json`, and its task board in `.jsmhq/plan.json`. Both are files in the managed repo, so an agent could change them in a pull request. One merged PR could:
- make a builder the lead;
- allow any domain;
- switch an agent out of its sandbox;
- let the lead merge;
- mark every task done.

## Decisions

### What moved to the store

Migration 006 adds these tables:
- `project_settings`: the GitHub repo, workflow, stack, office name and plan export;
- `agent_settings`: display role, colour, model, mode, chosen folder, role text and sandbox size;
- `boards` and `tasks`;
- `project_notes`: the owner-approved copies of the project's `CLAUDE.md`, append-only.

The rest is held elsewhere in the store:
- An agent's network rules, MCP servers, skills, tools and secret names are rows in the `permissions` table (migration 001). Each row records who granted it.
- An agent's CLI stays in `agents.cli`.
- An agent's role (CTO or builder) stays in `agents.role_id`.

HQ builds the dashboard's `HqConfig` from these tables (`ProjectSettings.view`). The dashboard reads no file to build it.

### One writer, and every write names its authority

`ProjectSettings` is the only code that writes configuration. Each write takes an `Authority`:

| Authority | Meaning | May |
|---|---|---|
| `{ via: "pin", humanId }` | The owner, confirmed with the approval PIN | Any change |
| `{ via: "decision", decisionId }` | A decision whose status is `approved` | Any change. The audit row's `decision_id` names it |
| `{ via: "session", humanId }` | The logged-in owner, without the PIN | Only changes that do not relax a control |
| `{ via: "hq" }` | HQ itself, for example rolling back a rule sbx refused | Only revoking a grant that does not relax a control |

A human authority must name a human whose role is `owner` and who is not disabled. A supervisor changes nothing.

Each write runs in one immediate transaction: check the authority, write, then append the audit row (`settings.changed`, `permission.granted` or `permission.revoked`, with `data.authority`). A refusal rolls the write back, appends `settings.refused` with the reason, and throws `AuthorityError`.

### Which changes relax a control

`relaxes()` in `server/company/authority.ts` follows the direction rule of spec §9 item 2. These changes relax a control:
- granting `network-allow`, `mcp-server`, `secret-name`, `tool` or `skill`;
- revoking `network-deny`;
- turning review off, or any change to the review tool or command;
- setting `merge.by` to `lead`;
- any deploy change except turning deploy off;
- changing the project's GitHub repo or stack;
- setting an agent's mode to `local`, or any change of its CLI, role text or a non-empty chosen folder;
- adding an agent, importing a repo config, and approving project notes.

Everything else needs only the owner's session: the reverse of each item above, plus names, colours, display roles, models and sandbox size. The dashboard's PIN rules use the same function (M0-D1 Task 3), so the two cannot disagree.

A new agent gets a settings row and no grants. It never copies the lead's (SR-D-11).

### Why the repo files are never read back

HQ stops writing `.jsmhq/config.json` and `.jsmhq/plan.json`. The opt-in `docs/plan.md` export is written and never read.

HQ still reads the old files in exactly one place: a one-time import, built in M0-D1 Task 3. The owner previews the import and confirms it with the PIN, and the confirmation is bound to the hash of what the preview showed. After that the files have no effect, so a PR that edits them changes nothing (SR-D-01, SR-D-02).

## Consequences

- A merged PR can no longer change who an agent is or what it may do. Changing that takes the owner's PIN, or later an approved decision (M1.4).
- An approved decision currently authorises any relaxing change. M1.4 binds a decision to the change its stored parameters name, and lets it be used only once. That is in the overview's carry-forward table.
- Teammates no longer share a project's configuration through git. Each HQ has its own store, as M0-G's always-on host will.

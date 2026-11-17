# How JSM HQ works

What HQ does behind the office: where agents work, how they talk, what reaches GitHub, and what HQ saves. New here? Start with the [getting-started guide](getting-started.md).

- [The team](#the-team)
- [Workspaces and sessions](#workspaces-and-sessions)
- [Messages between agents](#messages-between-agents)
- [Agent identity](#agent-identity)
- [GitHub and reviews](#github-and-reviews)
- [Sandboxes and network access](#sandboxes-and-network-access)
- [Terminals, links and ports](#terminals-links-and-ports)
- [Action items](#action-items)
- [Your stack](#your-stack)
- [Skills](#skills)
- [MCP servers](#mcp-servers)
- [App variables and keys](#app-variables-and-keys)
- [Settings you can change any time](#settings-you-can-change-any-time)
- [What HQ saves, and where](#what-hq-saves-and-where)
- [Windows](#windows)
- [Keyboard shortcuts](#keyboard-shortcuts)

## The team

- **The lead** plans and assigns. It creates boards (for example one per phase), splits the work into tasks and gives each task to a free worker. It never writes app code.
- **Workers** build. One task means one branch and one pull request. A worker edits only the files its task lists and asks the lead if it needs more.
- Each agent runs **Claude Code** or **Codex**, in a **Sandbox** (the default) or in **Local** mode. Set this per agent in Settings → Team.

New teams get names from The Office: Michael leads, then Dwight, Jim, Pam and so on. Rename them any time.

## Several projects

One HQ runs every project you give it, each with its own team, boards and agents. Nothing is shared between two projects except HQ itself, its login and its company store.

- **The project switcher** in the top bar shows which project you're looking at. Pick another to switch: the office, boards, PRs and terminals are that project's.
- **Adding a project:** the owner presses **Add project**, types the full path of a git repo on this machine, and confirms with the PIN. The repo HQ is started in (or `--repo`) is added too, without the PIN.
- **What can't be a project:** HQ's own source code (its repo, a clone or fork of it, or the folder HQ runs from), and anything inside HQ's home folder (`~/.jsmhq`, where agents' copies live).
- **A project whose folder is gone** stays listed as "folder missing". None of its agents start until the folder is back.
- **A project whose folder now holds a different GitHub repo** is listed as such and not opened, so a new repo never inherits an old project's permissions. If you renamed or moved the repo on GitHub, press **Confirm <name>'s repo** in the top bar and give your PIN.
- **Agents with the same name in two projects** are separate agents: each project's messages, tasks and tools reach only its own.
- **Sandbox settings made for every sandbox** (an sbx key or policy set globally) reach every project's sandboxes. Set a key for one agent's sandbox when only that agent should have it.

## Workspaces and sessions

- **Its own copy of the repo.** Each agent gets a full clone at `~/.jsmhq/<project>/<agent>/`. Your own working folder is never touched.
- **Its instructions.** HQ writes `.jsmhq-role.md` into that folder: the agent's role (the ROLE.md text from Settings → Team), the team, the rules and its tools. HQ also adds its hooks and MCP config there, and keeps all of these out of git. The clone leaves out the repo's own agent settings (`CLAUDE.md`, `AGENTS.md`, `ROLE.md`, `.mcp.json`, `.claude/`, `.agents/`, `.codex/`), so a pull request can't change what every agent is told or may run.
- **Its session.** On macOS and Linux each agent runs in a tmux session called `hq-<project>-<agent>`, so agents keep working if you close HQ or the browser. You can watch one from any terminal with `tmux attach -t hq-<project>-<agent>`, or open its drawer in HQ. Two agents can never share a session name, even in different projects: HQ refuses an agent id that would.
- **A folder you chose yourself** (Settings → Team) is checked each time its agent starts: it must not be HQ's own source, and the repo (from its top folder, even if you chose a subfolder) must not have its own agent settings such as `CLAUDE.md`. In a monorepo this means any tracked agent-settings file counts, a sibling folder's included. A later `git pull` in that folder can bring such a file back; HQ notices at the agent's next start, not before.
- **Company-level agents** (the CEO, CIO and Security & Audit, from M1) get an empty folder in `~/.jsmhq/_workspaces/` instead of a copy of the repo. They run only in a sandbox, and HQ won't start one while a GitHub key or token could reach it.

## Project notes (`CLAUDE.md`)

Agents never load the repo's own agent settings. The clone leaves out `CLAUDE.md`, `AGENTS.md`, `ROLE.md`, `.mcp.json`, `.claude/`, `.agents/` and `.codex/` at any depth. A pull request that changes one of them changes no agent.

- **Agents read `CLAUDE.md` only as the copy you approved.** When the repo's `CLAUDE.md` is new or has changed, **Action items** shows its text (as text an agent may have written, not rendered) with **Approve with PIN**. Approved copies are numbered and kept. Agents get the latest one in their role at their next start, for Claude Code and Codex alike. Until you approve, they keep the previous version, or have no project notes.
- **What HQ offers:** only a regular file at the repo's root, of at most 20,000 characters. A link is not offered. If the file changes between your reading it and your PIN, the approval is refused: read it again.
- **Agents can't see or change these files.** They are outside the agent's checkout, and `git add` refuses them there. So a task such as "update CLAUDE.md" can't go to an agent: edit the file yourself, then approve the new version.
- **A skill the repo commits under `.claude/skills/` or `.agents/skills/`** isn't loaded. Agents get only the [skills you pinned](#skills). If the repo has a skill with the same name as one of theirs, the agent gets HQ's copy, and `git status` in its folder stays clean.

## Messages between agents

Agents talk to each other and to HQ through an MCP server called `hq`, which HQ runs for them.

- The lead uses it to create boards and tasks and to assign them. Any agent can send a message.
- **Task text is the lead's, not yours.** The dashboard has no command that sets task text: you can assign a task, send a message, and answer an action item, and HQ refuses a message or an answer that carries a key. A task's words are always the lead's, shown as text the lead wrote.
- A message is delivered right away if the agent is idle, or when it finishes its current step if it's busy.
- You can message any agent from the **Messages** tab in its drawer.

## Owner login

- **A real login, not a link.** The dashboard asks for your password and a 6-digit code from your authenticator app. There is no token in any address or in HQ's output. On the first start HQ writes a one-time setup code to a file on its machine; you enter it once to set up the owner.
- **What is stored.** Your password and PIN only as slow fingerprints (scrypt). The authenticator's secret is locked with a key kept in a separate file next to the company store, so a copy of the store alone opens nothing. A code works once.
- **Sessions.** A login lasts until 30 minutes without activity, or 12 hours at most, or until you log out. Restarting HQ logs everyone out. Clicking and typing in the dashboard count as activity; the office updating by itself does not.
- **The PIN.** Anything that grants or loosens something asks for your approval PIN again: adding or removing agents, storing a key, setting the proxy, adding an MCP server, allowing a site, changing an agent's mode or role file, or changing who merges. Denying, stopping and removing things never needs it.
- **From your phone.** A session that does not come straight from this machine (for example through `tailscale serve`) is remote: the terminal, the sandbox shell and the host shell are switched off, by the server and in the page.
- **Every dashboard action is recorded** in the audit trail under your name. Typing in a terminal is recorded once a minute as a count, never what you typed.
- **Text agents wrote** (task titles, messages, notes, action items, PR titles, blocked sites) is always shown as text, marked as written by that agent. It never runs as code and never appears as part of HQ's own sentences or approval items. Links in it show their real address and open only if they are web or email links.
- **Forgot something?** Stop HQ, run `jsm-hq reset-owner` on its machine, and set up the owner again.

## Agent identity

- **One secret per agent.** Each time HQ starts an agent's session, it gives that agent a new secret and the previous one stops working. HQ writes it only into the agent's own MCP config and hook settings, which only you can read and which git ignores. HQ itself keeps only a fingerprint (a SHA-256 hash), so its records hold nothing an agent could use.
- **Who is calling comes from the secret.** HQ decides which agent made a request from its secret alone. An agent name in a hook's address or an `X-HQ-Agent` header must match it, or the request is refused. Every refusal looks the same, whatever went wrong, and failed attempts are recorded.
- **Stopping, pausing or removing an agent** ends its secret at once. If HQ restarts while agents keep running in tmux, it reconnects to them and leaves their secrets and files as they are. An agent started by an HQ from before per-agent secrets is shown in the activity feed: restart it once so it gets its own.
- **Roles come from the company store.** The lead is the project's CTO and the others are builders. The welcome screen, or a one-time import of an older `.jsmhq/config.json`, sets who the CTO is. Nothing in the repository changes it afterwards.
- **Each role has its own tools.** The CTO plans and assigns (boards, tasks, the team's status). Builders work on their own task: `get_my_task`, `set_my_status`, `send_message`, `ask_user` and `request_access`. A tool outside the role is refused before it runs.
- **Every tool call is recorded** in the company store's audit trail, with the agent that made it. If HQ can't record a call, it doesn't carry it out. Free text (messages, notes, descriptions) is recorded as its length, not its content.
- **The project id comes from the company store.** A new repo gets its folder name; a second repo with the same folder name gets `-2`, `-3` and so on. A repo you moved is recognised as the same project only when its old folder is gone and its GitHub repo is the same; a different repo that reuses a deleted repo's folder name is a new project, with none of the old one's permissions. `project.id` in an old `.jsmhq/config.json` is ignored.

## GitHub and reviews

**Each agent works on GitHub as its own App** (Settings → Team → Create GitHub identity). You create it from a link HQ prepares and install it on the project's repo only, about a minute per agent, once.
- **Its token lasts an hour and works on one repo.** It can push the agent's own branches (`<agent>/…`) and open pull requests, nothing else.
- **HQ cancels it** when the agent stops, is paused or retired, or HQ stops.
- **If GitHub can't be reached when HQ renews a token,** HQ keeps the working one and tries once more after a minute. If that fails too, the agent's activity says when its token stops working.
- **No GitHub key is shared by every sandbox.** HQ starts no agent while one exists.

**GitHub itself enforces the limits.** Settings → Project → GitHub protection shows the repo's settings, checked when the project opens and daily, and **Apply protection** sets them with your PIN:
- only you can update and merge into `main`, after your code-owner review;
- each agent's branches can be written only by that agent's App;
- no other branch can be created;
- auto-merge is off;
- workflows get a read-only token, cannot approve pull requests, and may use only GitHub's own actions;
- the repo holds no repository secrets.

CODEOWNERS and workflow files are yours: HQ reads them, never writes them.

The **Settings** button shows a mark while the GitHub protection check, or the [skills repo check](#skills), has something to report.

HQ reads your PRs, checks and review comments with your `gh` login, about every 20 seconds.

- **A PR belongs to the App that opened it.** A branch name or a `[TASK-ID]` in the title is only a claim. One that points at another agent is flagged and moves no task.
- New review comments are sent to the PR's author to fix.
- When a PR passes review, you're told to merge it; the lead is told too.
- When a PR is merged, its task is marked done.
- If a PR has merge conflicts with `main`, the author is told to fix them.

**HQ never merges, and no agent can.** You merge on GitHub.

Pick the review tool in Settings → Workflow: CodeRabbit, Greptile, Copilot, you, or your own.

## Sandboxes and network access

Each agent in Sandbox mode runs in its own [Docker Sandbox](https://docs.docker.com/ai/sandboxes/), a small VM with its own copy of the repo. It can't reach the rest of your machine.

- **Network policy.** You choose one when you install Docker Sandboxes. **Balanced** is recommended: AI services, package registries and GitHub are allowed, everything else is blocked. HQ never changes it; it only adds the one rule that lets sandboxes reach HQ.
- **When an agent needs a website** (a tool's docs or an API), it asks with the `request_access` tool instead of working around the block. Its card turns red and its drawer shows **Allow for this agent / Allow for everyone / Deny**.
- **Blocked requests** the agent didn't ask about are listed too: the agent's card shows "N blocked", and its drawer lists them with **Allow / Dismiss**.
- **Allowing a website** adds a rule for that sandbox only. Your base policy is never touched, and HQ only removes rules it added.
- **CPU and memory** are set in Settings → Sandbox. A sandbox gets its size when it's created, so after changing it press **Recreate sandbox**. Stop and Start keeps the old size. Recreating keeps the agent's folder and code but clears anything installed inside the sandbox. A start about skills can ask for it too (see [Skills](#skills)).

## Terminals, links and ports

- **Resize any panel.** Drag a panel's left edge to make it wider (HQ remembers the width in this browser; double-click the edge to reset), or press the square button to fill the screen. Terminals resize with it, so full-screen tools that need more rows fit.
- **Shell tab.** A shell inside the agent's sandbox, beside the agent.
- **Terminal** (top bar). Your own shell on this machine, not in a sandbox: in your repo, an agent's folder, or any folder you type. Be careful in an agent's folder while it's working: it's the same copy of the repo the agent is editing.
- **Links** in any terminal open in a new tab when you click them, including long URLs that wrap onto the next line.
- **Opening the browser.** Tools in a sandbox that open a web page (for example a CLI sign-in) open it in your browser.
- **Ports.** When a program in the Shell tab prints a `localhost:<port>` address, HQ offers to **Forward port**: then `localhost:<port>` on your machine reaches the sandbox. CLI sign-ins that redirect your browser back to `localhost` need this. You can also forward any port, and stop forwarding, in the agent's **Sandbox** tab. The program inside the sandbox must listen on all addresses (`0.0.0.0`), not only `127.0.0.1`.

## Action items

**Action items** in the top bar is everything waiting on you:

- requests from agents (made with the `ask_user` tool): create a database, add a key, change a dashboard setting. Each one has exact steps and names the variable, never the secret value;
- agents waiting for an answer in their terminal;
- websites agents asked to reach, and ones their sandbox blocked;
- pull requests ready to merge.

Mark a request **Done** (with an optional note) or **Dismiss** it, and HQ tells the agent so it can continue. Action items stay on your machine and are never committed.

## Your stack

Optional. In Settings → Stack (or during the welcome), pick what the project uses: frameworks, plus tools for auth, payments, database, analytics and security. You can also add your own under "Other".

- Agents see the stack in their instructions.
- Each tool's agent skills are installed into the agents' folders, kept out of git, but only once you have pinned them in the company's skills repo (see [Skills](#skills)). Until then an agent's start says which ones are missing.
- One click allows every tool's docs and API websites for all sandboxes.

Skip it and nothing changes.

## Skills

A skill is a folder of instructions an agent can load, such as "write the test first" or "check before you say it's done". Skills change how agents behave, so HQ lets them come from one place only, and only the ones you have approved.

**Where they come from.** The company's skills repo, `NdururiJr/canoeney-skills` on GitHub. Each skill in it is a copy of a public skill that you reviewed, with its source and licence kept beside it. HQ installs nothing from anywhere else.

**Pinning a commit.** A commit is one saved version of the repo. You approve one version at a time, in **Settings → Skills**:
1. Paste the 40-character commit code and press **Preview**. HQ reads that version without running anything in it. It lists the skills added, changed and removed, the files that are scripts, and the roles that would lose a skill. It links to the commit and to the comparison with your current pin, so you can read what you are approving.
2. Press **Confirm with PIN**. HQ saves its own copy of every skill in that version, with a fingerprint of each.

Only a commit on the repo's main branch can be pinned. A commit someone proposed in a pull request is refused. So is a version holding a link, a file path that leaves its folder, a name Windows can't hold, or a skill over 256 files or 2 MiB. One refusal refuses the whole pin.

**The repo itself is checked.** When you preview or pin, and once a day once something is pinned, HQ reads the repo's settings. Its main branch can't be deleted or overwritten, you are the only person who can write to it, it has no write key, and none of your agents' GitHub Apps is installed on it. If something is off, the preview lists it and **Confirm with PIN** will not go through until it is fixed. Once something is pinned, the **Settings** button also shows a mark and Settings → Skills lists what. HQ can't see other people's GitHub Apps, so look yourself now and then: on the repo's page on GitHub, open **Settings → GitHub Apps**. The list should be empty.

**Role sets.** Each role starts with a set of skills, shown under **What each role gets**:

| Role | Skills |
| --- | --- |
| Builder | test-driven-development, systematic-debugging, verification-before-completion, executing-plans |
| CTO | writing-plans, requesting-code-review, brainstorming |
| CEO and CIO | verification-before-completion |

Other roles have none. You can change a role's set, or grant one agent an extra skill in **Settings → Team**. Both ask for your PIN and apply at the agent's next start. Only pinned skills are on offer.

**What happens at every start.** HQ puts the agent's skills into its folder (`.claude/skills` for Claude Code, `.agents/skills` for Codex) from its own saved copies, and checks each one against its fingerprint first. The skills are the agent's role set, anything you granted it, and the pinned skills of your stack. **A start fetches nothing from the internet and runs nothing a skill contains.** A stack skill that isn't pinned yet is named as missing, and the agent starts without it.

**A changed or extra skill.** An agent may edit an installed skill or add one of its own. At its next start HQ puts the pinned set back. It does not delete the other folder: it moves it to `~/.jsmhq/<project>/_skills-removed/<agent>/<date and time>/` (for a company-level agent, the same under the company home) and keeps the newest 5 moves per agent. The audit trail records what moved and where. It also records a first start, when the pinned skills are new to that agent.

**When a start is refused.** The message names the exact path and the one thing to do:
- `.claude`, `.agents` or a skills folder in the agent's folder is a link. Delete that link. HQ won't install through it.
- A skill folder the agent changed or added holds more than 256 files or 2 MiB. HQ won't move something that big, because it may be your own work. Move that folder out of the agent's folder.
- The skills folder itself (`.claude/skills` or `.agents/skills`) holds more than 256 entries. HQ won't sort it. Move the extra folders out of it.
- In one of HQ's own clones, an agent-settings file the repo tracks (such as `CLAUDE.md`) was written back into the agent's folder. Git can't see it, so HQ names it. Delete that file.

**In a sandbox.** Docker Sandboxes can give every sandbox skills from its own shared store. HQ creates new sandboxes with that store off. An older sandbox starts only while the store is empty. If it isn't, the start says so: press **Recreate sandbox**. Use the same button if you removed or recreated a sandbox outside HQ, because HQ's record of it may be out of date. HQ also refuses a start when it can't read sbx's sandbox list or its skills store.

**A known limit.** A skill an agent writes into its own sandbox home (`~/.claude/skills` inside the sandbox) stays until you press **Recreate sandbox**. It reaches that agent only. M1 closes this gap.

## MCP servers

Give agents extra tools (Supabase, Stripe, Figma, your own…) in **Settings → MCP**:

1. **Add server:** a URL and an optional API key, or a command for a local server. Tools from your stack fill in their URL for you.
2. **Sign in** if the server asks. Sign-ins and keys stay with Docker Sandboxes and never enter a sandbox.
3. **Tick the agents** that should get it. A running agent gets the tools right away, without a restart.

Unticking a server takes effect when that agent's sandbox is recreated, because Docker Sandboxes can't detach a server from one sandbox.

**Supabase tip:** add `?project_ref=<id>` to the URL (Supabase → Project Settings → General) so the agent can only reach that project. Use a development project, not production.

## App variables and keys

- **App variables are off for now.** No secret value goes into a sandbox in M0 and M1: an agent's app variables file is not passed to it. From M2 you'll approve each variable with your PIN, and only test credentials.
- **Service keys** (Settings → Sandbox) go to Docker Sandboxes' secret store. A sandbox's proxy adds the key to matching requests, so the key itself never enters the VM.

HQ never stores key values and never reads your env files.

## Settings you can change any time

| Setting | Where | Applies |
| --- | --- | --- |
| Office name (the sign on the wall) | Settings → Project | Right away, for everyone on the project |
| Font: Pixel, Clean or Mono | Settings → Project | Right away, in this browser only. The office itself stays pixel. |
| Review tool | Settings → Workflow | Right away |
| Agents, roles, CLI, mode | Settings → Team | Next time the agent starts |
| Pinned skills, role sets, an agent's extra skills | Settings → Skills, Settings → Team | Next time each agent starts (asks for your PIN) |
| CPU and memory | Settings → Sandbox | After **Recreate sandbox** |
| MCP servers per agent | Settings → MCP | Right away for new servers |

## What HQ saves, and where

| Where | What | Commit it? |
| --- | --- | --- |
| The company store (`~/.jsmhq/_company/company.db`) | The team, each agent's settings and permissions, the workflow, the stack, and the boards and tasks | No: it's outside your repo, on your machine only |
| `docs/plan.md` (in your repo) | A readable copy of the plan, if **Settings → Project → Export plan** is on. HQ writes it and never reads it | Yes |
| `~/.jsmhq/<project>/` | Agents' folders, app variables, action items and HQ's own records | No: it's outside your repo, on your machine only |

**Why not in the repo?** An agent can change any file in the repo through a pull request. If the team and its permissions lived there, one merged PR could make a builder the lead, open its sandbox to any site, or let the lead merge. So HQ reads none of it from the repo. Every change goes through the dashboard, and anything that loosens a control (a new site, an MCP server, review off, the lead merging, a new agent) asks for your PIN.

**Upgrading from an older HQ:** an older HQ kept the team in `.jsmhq/config.json` and the tasks in `.jsmhq/plan.json`. HQ no longer reads them by itself. The welcome screen offers **Review import from .jsmhq/config.json**: it lists everything the import would loosen, with the file's values shown as text an agent may have written. Import it with your PIN, or set up a new team instead. If the file changes after you review it, the import is refused, so review it again. The import runs once. Afterwards you can delete the two files.

**Skills after an upgrade:** HQ no longer installs skills with `npx skills add`. See [Skills](#skills) and the [release notes](../CONTRIBUTING.md#release-notes).

**Remove a project:** delete each agent in Settings → Team (this removes its sandbox and, if you choose, its folder), then delete `~/.jsmhq/<project>`.

## Company store

HQ keeps a company record, separate from the per-project folders above, in `~/.jsmhq/_company/company.db`. Set `HQ_COMPANY_HOME` to put it somewhere else. Next to it, `skills/` holds HQ's saved copy of every pinned skill.

It holds the company data model, a tamper-evident audit chain of what happened and who did it, agent and client memory, company knowledge, and the alert outbox the dashboard reads.

HQ never gives agents its path, and it refuses to start an agent whose folder is the store or inside it (agent ids must be lower-case letters, digits and `-`, so a managed folder can't point there either). The team, the agents' settings and permissions, and the tasks live in the store too (see above). HQ refuses to open the store inside a repository, so it can't be committed by accident. On macOS and Linux the folder is private to you (`0700`), and so is the file (`0600`).

HQ records when it starts and stops. If the store was written by a newer HQ, this HQ stops with a message asking you to update.

## Windows

Windows 11 support is experimental. Run HQ in PowerShell or Windows Terminal, not in WSL.

- There's no tmux, so HQ runs the agents itself. **Agents stop when HQ stops.** Their sandboxes and folders are kept; press **Start** to run them again.
- Use the terminal in the agent's drawer; there's no `tmux attach`.
- Every agent runs in a Docker Sandbox, on Windows too (install Docker Sandboxes: `winget install Docker.sbx`). There is no Local mode.

## Keyboard shortcuts

| Key | Does |
| --- | --- |
| `1`–`9` | Open that agent |
| `Esc` | Close panels |
| `+` / `-` | Zoom in / out |
| `D` | Toggle the debug panel |

Drag to move around the office; scroll to zoom.

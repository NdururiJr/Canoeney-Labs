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

## Workspaces and sessions

- **Its own copy of the repo.** Each agent gets a full clone at `~/.jsmhq/<project>/<agent>/`. Your own working folder is never touched.
- **Its instructions.** HQ writes `.jsmhq-role.md` into that folder: the agent's role (the ROLE.md text from Settings → Team), the team, the rules and its tools. HQ also adds its hooks and MCP config there, and keeps all of these out of git. If the folder has its own `ROLE.md`, HQ includes it and never overwrites it.
- **Its session.** On macOS and Linux each agent runs in a tmux session called `hq-<project>-<agent>`, so agents keep working if you close HQ or the browser. You can watch one from any terminal with `tmux attach -t hq-<project>-<agent>`, or open its drawer in HQ.

## Messages between agents

Agents talk to each other and to HQ through an MCP server called `hq`, which HQ runs for them.

- The lead uses it to create boards and tasks and to assign them. Any agent can send a message.
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
- **The project id comes from the company store.** A new repo gets its folder name; a second repo with the same folder name gets `-2`, `-3` and so on. A repo you moved is recognised as the same project. `project.id` in an old `.jsmhq/config.json` is ignored.

## GitHub and reviews

HQ reads your PRs, checks and review comments with your `gh` login, about every 20 seconds.

- It matches a PR to its task by the `[TASK-ID]` at the start of the title.
- New review comments are sent to the PR's author to fix.
- When a PR passes review, the lead is told it's ready to merge.
- When a PR is merged, its task is marked done.
- If a PR has merge conflicts with `main`, the author is told to fix them.

**HQ never merges.** You merge on GitHub.

Pick the review tool in Settings → Workflow: CodeRabbit, Greptile, Copilot, you, or your own.

## Sandboxes and network access

Each agent in Sandbox mode runs in its own [Docker Sandbox](https://docs.docker.com/ai/sandboxes/), a small VM with its own copy of the repo. It can't reach the rest of your machine.

- **Network policy.** You choose one when you install Docker Sandboxes. **Balanced** is recommended: AI services, package registries and GitHub are allowed, everything else is blocked. HQ never changes it; it only adds the one rule that lets sandboxes reach HQ.
- **When an agent needs a website** (a tool's docs or an API), it asks with the `request_access` tool instead of working around the block. Its card turns red and its drawer shows **Allow for this agent / Allow for everyone / Deny**.
- **Blocked requests** the agent didn't ask about are listed too: the agent's card shows "N blocked", and its drawer lists them with **Allow / Dismiss**.
- **Allowing a website** adds a rule for that sandbox only. Your base policy is never touched, and HQ only removes rules it added.
- **CPU and memory** are set in Settings → Sandbox. A sandbox gets its size when it's created, so after changing it press **Recreate sandbox**. Stop and Start keeps the old size. Recreating keeps the agent's folder and code but clears anything installed inside the sandbox.

## Terminals, links and ports

- **Resize any panel.** Drag a panel's left edge to make it wider (HQ remembers the width in this browser; double-click the edge to reset), or press the square button to fill the screen. Terminals resize with it, so full-screen tools that need more rows fit.
- **Shell tab.** A shell inside the agent's sandbox (or its folder in Local mode), beside the agent.
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
- Each tool's official agent skills are installed into the agents' folders (`.claude/skills`, `.agents/skills`), kept out of git.
- One click allows every tool's docs and API websites for all sandboxes.

Skip it and nothing changes.

## MCP servers

Give agents extra tools (Supabase, Stripe, Figma, your own…) in **Settings → MCP**:

1. **Add server:** a URL and an optional API key, or a command for a local server. Tools from your stack fill in their URL for you.
2. **Sign in** if the server asks. Sign-ins and keys stay with Docker Sandboxes and never enter a sandbox.
3. **Tick the agents** that should get it. A running agent gets the tools right away, without a restart.

Unticking a server takes effect when that agent's sandbox is recreated, because Docker Sandboxes can't detach a server from one sandbox.

**Supabase tip:** add `?project_ref=<id>` to the URL (Supabase → Project Settings → General) so the agent can only reach that project. Use a development project, not production.

## App variables and keys

- **App variables** (Settings → Sandbox → App variables) become environment variables in the agent's session and its Shell tab. They're not a `.env` file in the project. Agents are told the names, never the values. Restart the agent after changing them.
- **Service keys** (Settings → Sandbox) go to Docker Sandboxes' secret store. A sandbox's proxy adds the key to matching requests, so the key itself never enters the VM.

HQ never stores key values and never reads your env files.

## Settings you can change any time

| Setting | Where | Applies |
| --- | --- | --- |
| Office name (the sign on the wall) | Settings → Project | Right away, for everyone on the project |
| Font: Pixel, Clean or Mono | Settings → Project | Right away, in this browser only. The office itself stays pixel. |
| Review tool | Settings → Workflow | Right away |
| Agents, roles, CLI, mode | Settings → Team | Next time the agent starts |
| CPU and memory | Settings → Sandbox | After **Recreate sandbox** |
| MCP servers per agent | Settings → MCP | Right away for new servers |

## What HQ saves, and where

| Where | What | Commit it? |
| --- | --- | --- |
| The company store (`~/.jsmhq/_company/company.db`) | The team, each agent's settings and permissions, the workflow, the stack, and the boards and tasks | No: it's outside your repo, on your machine only |
| `docs/plan.md` (in your repo) | A readable copy of the plan, if **Settings → Project → Export plan** is on. HQ writes it and never reads it | Yes |
| `~/.jsmhq/<project>/` | Agents' folders, app variables, action items and HQ's own records | No: it's outside your repo, on your machine only |

**Why not in the repo?** An agent can change any file in the repo through a pull request. If the team and its permissions lived there, one merged PR could make a builder the lead, open its sandbox to any site, or let the lead merge. So HQ reads none of it from the repo. Every change goes through the dashboard, and anything that loosens a control (a new site, an MCP server, Local mode, review off, the lead merging, a new agent) asks for your PIN.

**Upgrading from an older HQ:** an older HQ kept the team in `.jsmhq/config.json` and the tasks in `.jsmhq/plan.json`. HQ no longer reads them by itself. The welcome screen offers **Review import from .jsmhq/config.json**: it lists everything the import would loosen, with the file's values shown as text an agent may have written. Import it with your PIN, or set up a new team instead. If the file changes after you review it, the import is refused, so review it again. The import runs once. Afterwards you can delete the two files.

**Remove a project:** delete each agent in Settings → Team (this removes its sandbox and, if you choose, its folder), then delete `~/.jsmhq/<project>`.

## Company store

HQ keeps a company record, separate from the per-project folders above, in `~/.jsmhq/_company/company.db`. Set `HQ_COMPANY_HOME` to put it somewhere else.

It holds the company data model, a tamper-evident audit chain of what happened and who did it, agent and client memory, company knowledge, and the alert outbox the dashboard reads.

HQ never gives agents its path, and it refuses to start an agent whose folder is the store or inside it (agent ids must be lower-case letters, digits and `-`, so a managed folder can't point there either). The team, the agents' settings and permissions, and the tasks live in the store too (see above). HQ refuses to open the store inside a repository, so it can't be committed by accident. On macOS and Linux the folder is private to you (`0700`), and so is the file (`0600`).

HQ records when it starts and stops. If the store was written by a newer HQ, this HQ stops with a message asking you to update.

## Windows

Windows 11 support is experimental. Run HQ in PowerShell or Windows Terminal, not in WSL.

- There's no tmux, so HQ runs the agents itself. **Agents stop when HQ stops.** Their sandboxes and folders are kept; press **Start** to run them again.
- Use the terminal in the agent's drawer; there's no `tmux attach`.
- In Local mode, the agent's env file isn't loaded. Use Sandbox mode for app variables.

## Keyboard shortcuts

| Key | Does |
| --- | --- |
| `1`–`9` | Open that agent |
| `Esc` | Close panels |
| `+` / `-` | Zoom in / out |
| `D` | Toggle the debug panel |

Drag to move around the office; scroll to zoom.

# Getting started with JSM HQ

This guide takes you from a fresh machine to a team of AI agents working on your repo. It takes about 15 minutes, most of it installing tools. You only do it once.

**You'll need:**

- A Mac (Apple silicon, macOS 14+), Linux (Ubuntu 24.04+), or a Windows 11 PC.
- A [Docker](https://app.docker.com/signup) account (free) for Docker Sandboxes.
- A [GitHub](https://github.com/signup) account and a repo for your project.
- A Claude (Pro, Max or API) or ChatGPT account for the agents themselves.

HQ checks everything below when it starts and shows a **setup checklist** with the exact command for anything missing, so you can also skip ahead to [step 6](#6-run-hq) and follow the checklist.

## 1. Install Node.js, git and the GitHub CLI

| | macOS | Linux (Ubuntu) | Windows 11 (PowerShell) |
|---|---|---|---|
| Node.js 22.13+ | `brew install node` | [nodesource](https://github.com/nodesource/distributions) or `nvm install 22` | `winget install OpenJS.NodeJS.LTS` |
| git | `xcode-select --install` | `sudo apt install git` | `winget install Git.Git` |
| GitHub CLI | `brew install gh` | `sudo apt install gh` | `winget install GitHub.cli` |
| tmux | `brew install tmux` | `sudo apt install tmux` | not needed |

HQ needs **git 2.37 or newer**. Check with `git --version`. If yours is older, update it (`winget upgrade Git.Git` on Windows, `brew upgrade git` on a Mac, `sudo apt upgrade git` on Ubuntu). An older git makes HQ stop at an agent's start and say so.

No Homebrew on your Mac? Install it from [brew.sh](https://brew.sh) first.

On Windows, close and reopen the terminal after installing so the new commands are found.

Then sign in to GitHub:

```bash
gh auth login
```

## 2. Install Docker Sandboxes

Every agent runs in its own Docker Sandbox: a small VM with its own copy of your repo. Agents can't touch the rest of your machine. Docker Sandboxes (`sbx`) is an add-on: having Docker installed is not enough.

| macOS | Linux (Ubuntu 24.04+, needs KVM) | Windows 11 |
|---|---|---|
| `brew trust docker/tap && brew install docker/tap/sbx` | `curl -fsSL https://get.docker.com \| sudo SBX=1 sh` | `winget install Docker.sbx` |

**Windows only:** turn on **Windows Hypervisor Platform** (Start → "Turn Windows features on or off"), then restart.

Check it worked:

```bash
sbx version
```

## 3. Sign in and choose a network policy

```bash
sbx login
```

This opens your browser to sign in with your Docker account.

Next, choose what sandboxes are allowed to reach on the internet. **This is required once on every new install**; sandboxes can't start until it's set:

```bash
sbx policy init balanced
```

| Policy | Sandboxes can reach |
|---|---|
| **balanced** (recommended) | Typical development traffic: AI services, package registries, GitHub. Everything else is blocked unless you allow it. |
| allow-all | Anything on the internet. |
| deny-all | Nothing, unless you allow it domain by domain. |

You can allow extra domains for one agent later in **Settings → Sandbox**. To start over with a different policy, run `sbx policy reset`. HQ never changes this policy; it only adds one rule so sandboxes can reach HQ itself.

## 4. GitHub access: one App per agent, never your own login

Agents push branches and open pull requests from inside their sandbox, each as its **own GitHub App**. HQ gives each agent a token that lasts an hour, works on one repo, can push and open pull requests, and can't merge or change settings. You set this up per agent later, in **Settings → Team → Create GitHub identity** (step 8).

**Don't store your own GitHub login for every sandbox.** Older instructions said to run `sbx secret set github --command "gh auth token"`. That gives every agent your full GitHub powers, so HQ refuses to start any agent while such a key exists. If you set one before, remove it:

```bash
sbx secret rm github --force
```

Using **Codex** agents? Also sign in with ChatGPT once:

```bash
sbx secret set openai --oauth
```

Claude Code agents ask you to sign in the first time they start. Do it in the agent's terminal inside HQ.

## 5. Prepare a GitHub repo

HQ works on a git repo that has a GitHub remote called `origin`. Each agent clones it, works on its own branch, and opens pull requests there. HQ follows those PRs and their reviews.

**An existing project** that's already on GitHub: nothing to do. Just open a terminal in its folder.

**A new project:**

```bash
mkdir my-app && cd my-app
git init -b main
echo "# My app" > README.md
git add . && git commit -m "Initial commit"
gh repo create my-app --private --source . --push
```

Tip: add a short `plan.md` (stack, features, phases) and push it before starting. The lead agent reads it to plan the work. Don't name it `docs/plan.md`; HQ can write that file itself (Settings → Project → Export plan).

## 6. Run HQ

From your project's folder:

```bash
npx @therealjsmastery/jsm-hq@latest
```

Or from anywhere, naming the project: `npx @therealjsmastery/jsm-hq@latest --repo <path to your project>`.

`@latest` makes sure npx doesn't reuse an old version it cached. HQ opens your browser. If it doesn't, open the `http://127.0.0.1:7420/` link printed in the terminal.

**Your first project:** if you're setting up the company, start with the company website repo. Add more projects later with **Add project** in the top bar (it asks for your PIN). HQ refuses its own source code as a project, so when you work on HQ itself (`pnpm dev:hq` in its repo), pass `--repo <project folder>` or set `HQ_REPO`.

- **Welcome:** name the project, pick a lead and workers (Claude Code or Codex for each) and a review tool. Optionally pick your stack (frameworks, auth, payments, database, analytics, security): agents then know what the project uses, and get those tools' skills once you have pinned them (step 7). Confirm it with your PIN. HQ saves it in its company store, outside your repo, so a pull request can't change it.
- **Setup checklist:** anything still missing shows here with a **Copy** button and, for safe commands, **Run in terminal**. Press **Check again** after fixing something.

Leave the terminal running while you work. On macOS and Linux, agents keep running even if you close HQ; on Windows they stop with it (see [Windows](how-it-works.md#windows)).

## 7. Pin the company's skills

Skills are instructions that shape how agents work, such as "write the test first". HQ installs only skills you have approved from the company's skills repo, `NdururiJr/canoeney-skills`. Until you pin them, agents start with no skills. You do this once, then again whenever the repo changes and you want agents to have the change.

1. Open **Settings → Skills**. Under **Skills repo**, HQ shows whether its checks of the repo found anything. If they list a problem, fix it on GitHub first. A pin can be refused while a problem is listed (an agent's GitHub App installed on the repo, for one).
2. On GitHub, open the repo's **Commits** page and copy the code (the 40-character SHA) of the newest commit on the main branch.
3. Paste it into **Pin a commit** and press **Preview**. HQ lists the skills, which files are scripts, and links to the commit. Read them.
4. Press **Confirm with PIN**.
5. Under **What each role gets**, check each role's set. A builder gets four skills at its next start.

You also need to look at the repo's **Settings → GitHub Apps** page yourself, now and then. It should list no App. HQ can't see apps other people installed.

If a start is refused because of skills, the message names the folder and what to do. See [Skills](how-it-works.md#skills).

## 8. Start the team

0. For each agent, open **Settings → Team** and press **Create GitHub identity**. Confirm with your PIN, click **Create GitHub App** on GitHub, then install it on **only** this project's repo. About a minute per agent, once.
1. Press **Start team** in the top bar. The first start takes a minute or two while each sandbox is created.
2. Click the lead (or press **1**) and open the **Messages** tab. Tell them what to build, for example:
   > Read plan.md. Create a board for Phase 1, plan its tasks with the files each one touches, and assign them.
3. Watch the office: tasks appear on the plan wall, agents work at their desks, and PRs roll through the review gate.
4. Review and merge PRs on GitHub yourself. HQ never merges. When you merge, the task is marked done.

An agent with a red **Needs input** badge is waiting for you. Click them and answer in their terminal.

To give agents MCP servers (Supabase, Stripe, your own…), use **Settings → MCP**: add the server, sign in if it asks, and tick the agents that should get it.

When an agent needs a website its sandbox blocks (a tool's docs, an API), it asks instead of guessing: its drawer shows the domain and why, with **Allow for this agent / Allow for everyone / Deny**. To allow your stack's docs up front, use **Settings → Stack → Network access**.

## Something not working?

| Problem | Fix |
|---|---|
| Start fails with "network policy has not been initialized" | Step 3: `sbx policy init balanced`. |
| Start fails with a Docker sign-in error | Your sign-in expired: `sbx login`, then **Check again**. |
| Agents can't push or open PRs | Give the agent its GitHub identity (Settings → Team → Create GitHub identity) and install it on the project's repo; check the repo has a GitHub `origin` (step 5). |
| A Codex agent waits on "Do you trust this folder?" | Answer it once in the agent's terminal. HQ never answers trust prompts for you. |
| A start says a skill is missing | The skill isn't pinned yet. Pin the commit that holds it (step 7). |
| A start says "Recreate sandbox" because of skills | That sandbox is older than HQ's skills rules, or was changed outside HQ. Recreate that agent's sandbox (the **Recreate sandbox** button). Its folder and code are kept. |
| A start says a skills folder or file is a link, or too big | Follow the message: delete the link, or move the named folder out of the agent's folder. |
| "Port 7420 is in use" | Another HQ is running. Stop it or use `--port 7421`. |
| Windows: `listen EACCES` | Windows reserved that port. Use `--port 8420`. |

More in the [README](../README.md#troubleshooting). To learn what HQ does behind the office, read [How it works](how-it-works.md).

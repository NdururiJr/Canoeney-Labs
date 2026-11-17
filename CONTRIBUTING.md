# Contributing to JSM HQ

## Run it from source

Needs Node.js 22.13+ and pnpm 10 or 11 (`corepack enable` gets you pnpm).

```bash
git clone https://github.com/jsmastery-pro/jsm-hq && cd jsm-hq
pnpm install
pnpm dev                                   # the UI with fake data, no agents
HQ_REPO=~/developer/hq-test pnpm dev:hq    # the real HQ server + UI, with hot reload
```

`pnpm dev` is a demo with fake data: nothing runs and nothing leaves the browser. To test a change for real, use `pnpm dev:hq` or `pnpm hq` against a throwaway repo.

| Command | Does |
| --- | --- |
| `pnpm dev` | Demo UI with fake data at http://localhost:5173 |
| `pnpm dev:hq` | Real HQ server + UI with hot reload (`HQ_REPO=<path>`) |
| `pnpm hq` | Builds the UI, then runs HQ like a release (`--repo <path> --port 7420`) |
| `pnpm build` | Type-checks, builds the UI to `dist/` and the server to `dist-server/` |
| `pnpm typecheck` | Type-check only |
| `npm pack` | Builds the npm tarball, to test it before publishing |

Start HQ with `HQ_DEBUG=1` to log why a queued message is waiting.

## Where things are

```
src/
  data/      Types, the OfficeDataSource interface, fake (data/mock) and real (data/ws) data
  store/     Zustand stores; the only code that talks to the data source
  office/    The PixiJS pixel office: layout, sprites, agents, belt
  ui/        Top bar, team panel, activity, drawers, settings, setup checklist, welcome
server/      Local HQ server: setup checks, workspaces, sessions (tmux, or HQ-run on Windows), sbx, hooks, Team MCP, GitHub
bin/         The jsm-hq command
docs/        User guides, and the product spec (jsmhq-context.md)
context/     Implementation plans
```

## Docker Sandboxes versions

HQ calls the `sbx` CLI and reads its output. sbx 0.48 changed several outputs (for example `sbx ls --json` and `sbx mcp ls --json` now return a bare array), so read sbx output in a way that accepts both the old and the new format. HQ is tested on sbx 0.47 and 0.50. M0-F's skills checks (`sbx run --skills off`, `sbx skills ls`) need sbx 0.53 or later and were verified on sbx 0.53.

## Release notes

### M0-F: per-role skills

Agents get skills only from the company's skills repo (`NdururiJr/canoeney-skills`), at a commit the owner pins in Settings → Skills. See [Skills](docs/how-it-works.md#skills) and [ADR 0011](docs/adr/0011-vendored-skills.md).

Upgrading:
- **`npx skills add` is gone.** HQ no longer fetches skills from upstream repos. A stack's skills install only once they are vendored into the skills repo and pinned. Until then an agent's start names them as missing, and the agent starts without them.
- **Pin the company's skills.** Until a commit is pinned, agents start with no skills. See [step 7 of the getting-started guide](docs/getting-started.md#7-pin-the-companys-skills).
- **git 2.37 or newer is required** (it was 2.35). HQ reads git's version at an agent's start and says so if it is older.
- **sbx 0.53 or newer is required** for `--skills off` and `sbx skills ls`. M0-F was verified on sbx 0.53.
- **Old sandboxes may need "Recreate sandbox".** New sandboxes are created with sbx's shared skills store off. An older sandbox starts only while that store is empty. If it is not, press **Recreate sandbox** in Settings → Sandbox. Its folder and code are kept.
- **A skill installed by the old `npx` path that is over 256 files or 2 MiB will stop that agent's first start** after the upgrade, with a "move that folder out" message naming the folder. Move it out of the agent's folder and start the agent again. Smaller ones are moved aside for you into `~/.jsmhq/<project>/_skills-removed/`.
- **Leftover `skills-cache` and `skills-owned` folders** in project homes (`~/.jsmhq/<project>/`) are no longer used. Delete them by hand if you want the space back.

Also in this release (M0-E follow-ups): a GitHub token refresh that can't reach GitHub keeps the working token and retries once after a minute, and the Settings button shows a mark while the GitHub protection check or the skills repo check has findings.

Known limits, carried to M1 (Security & Audit, M1.8): a skill an agent writes into its own sandbox home stays until **Recreate sandbox** (Settings → Sandbox), and a skill it writes into a nested folder of its own workspace (such as `src/.claude/skills/`) stays even then, because the workspace is kept.

## Releasing

1. Bump `version` in `package.json` and merge to `main`.
2. From a clean, up-to-date `main`, run `npm publish`. It builds first.

Only members of the `therealjsmastery` npm org can publish. The README on npm updates only when a new version is published.

# ADR 0010: One GitHub App per agent

- **Status:** accepted (M0-E)
- **Spec:** M0.10 (least-privilege credentials for every agent)
- **Requirements:** `docs/security/threat-model-m0.md` §3, SR-E-01 to SR-E-07 and SR-E-12
- **Owner decision:** one GitHub App per agent (2026-11-14)

## Context

Until M0-E, the README told the owner to store their full GitHub token as a sandbox key "for every sandbox". Every agent could then merge, delete branches and change repository settings, so "HQ never merges" was only a convention.

M0.10 asks for each agent's own scoped identity.

- **One App for all agents** would give short-lived tokens, but every agent would be the same GitHub actor. GitHub could not stop agent A from writing agent B's branches (SR-E-03), and a pull request could not be attributed by who opened it (SR-E-12).
- **One user account per agent** is limited by GitHub's terms to one free machine account per person.

## Decision

Each agent gets its own GitHub App, which appears on GitHub as `<app>[bot]`.

### Creating it

1. In Settings → Team, the owner presses **Create GitHub identity** for an agent and confirms with the PIN. The command is local only: GitHub sends the browser back to this machine.
2. HQ answers with a manifest and a one-time state, bound to the owner's session and valid for 10 minutes. The page posts the manifest to `https://github.com/settings/apps/new`. The page's Content Security Policy allows a form to post there and nowhere else.
3. GitHub creates the App and sends the browser back to `<dashboard origin>/github-app?code&state`.
   - The session cookie is `SameSite=Strict`, so that return trip carries no session.
   - The page therefore passes the code and the state to HQ over its own logged-in WebSocket, as the owner command `completeGithubIdentity`.
   - A state that is unknown, used, older than 10 minutes or another session's is refused, with `github.app-refused`.
4. HQ converts the code (`POST /app-manifests/{code}/conversions`). It then seals the App's private key with the owner key (AES-256-GCM, the same key and format as the TOTP seed; `server/company/sealed.ts`), and records the App's id, slug and bot user id.
5. The browser goes on to the App's install page. There the owner installs it on **the project's repository only**. An installation on all repositories is reported (`repository_selection` is not `selected`).

### What the App may do

The manifest's permissions are exactly:

| Permission | Level |
|---|---|
| `contents` | write |
| `pull_requests` | write |
| `metadata` | read |

It has no `workflows`, `administration`, `secrets`, `actions` or `members` permission, and no webhook: the manifest leaves `hook_attributes` out and subscribes to no events. The App is private to the owner's account.

### Tokens

- HQ signs a JWT for the App: RS256, issued a minute back for clock skew, valid 9 minutes.
- With it, HQ asks for an installation token for **one repository** with the same three permissions. A token lasts an hour.
- The token is given to the agent's own sandbox as its `github` key. HQ refreshes it while the agent runs, and revokes it explicitly when the agent stops, is paused or retired, or HQ stops (M0-E Task 2).
- Tokens are held in memory only. They are never written to the store, a log or the audit trail.

### What GitHub enforces

Branch protection and rulesets on each managed repo enforce the limits; the App's own permissions do not:
- only the repository admin updates `main` (`hq-main`);
- each `<agent>/**` branch is writable only by that agent's App (`hq-agent-<id>`);
- no other branch may be created (`hq-unclaimed`).

HQ checks these daily (M0-E Task 4).

## Consequences

- The owner clicks **Create** and **Install** once per agent, about a minute each. It costs nothing.
- Each commit and pull request shows the agent's own App as its author. HQ attributes a pull request by the author's type (`Bot`) and the App's bot user id, never by login text, a branch name or a title (SR-E-12).
- A stolen copy of `company.db` holds no usable key without `owner.key`.

## To confirm on GitHub (M0-E Task 1, Step 6)

- **Does GitHub accept a manifest with `hook_attributes.active: false` and no webhook URL?** No. GitHub's documentation makes `hook_attributes.url` required whenever `hook_attributes` is present, and GitHub showed its blank form instead of the manifest page (2026-11-14). The manifest now leaves `hook_attributes` out.
- **Can an App be a ruleset bypass actor on a repository owned by a personal account?** Yes, once the App is installed on that repository. Before the install, GitHub refuses with "Actor … integration must be part of the ruleset source or owner organization" (HTTP 422). A test ruleset on `NdururiJr/CanoeneyLabsWebste` with the test App (id 5758545) as its only bypass actor was accepted, read back active, and deleted (2026-11-14). So HQ applies each agent's `hq-agent-<id>` ruleset only after that agent's App is installed.
- **Does GitHub return the browser to a loopback `redirect_url`?** Yes: GitHub sent the browser to `http://127.0.0.1:7420/github-app?code=…` (2026-11-14). No fallback is needed.
- **When does the App exist?** Only once the code is converted (`POST /app-manifests/{code}/conversions`), within an hour of the owner clicking Create; before that, its install page is a 404. HQ converts the code as soon as the browser returns. The converted test App had exactly `contents: write`, `pull_requests: write`, `metadata: read` and no events, and its bot user (`<slug>[bot]`) existed straight away, so HQ records the bot user id at creation.

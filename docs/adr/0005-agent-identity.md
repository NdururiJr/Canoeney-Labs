# ADR 0005: Agent identity

## Status

Accepted

## Context

Until M0-B every agent of a project sent the same token, and HQ took the
agent's identity from the `X-HQ-Agent` header (on `/mcp`) or from the URL (on
`/hook/<agentId>/…`). Any agent could therefore act as any other, including as
the lead (threat model T-S1.1, T-S2.1). What an agent could do came from
`isLead` in `.jsmhq/config.json`, a file in the repository that agents can
edit (T-S1.7, T-S7.1). Spec M0.2 asks for one secret per agent, with identity
taken only from that secret, and M0.14 asks for roles mapped to tool sets.

## Decision

**Secret format.** `hqa_` followed by the base64url encoding of 32 bytes from
`crypto.randomBytes`: 43 characters, 256 bits (`AGENT_SECRET_PATTERN` in
`server/company/agentSecrets.ts`). The prefix makes a leaked secret easy to
recognise, and the audit guard refuses any string that holds one (ADR 0003).

**Only a hash is stored (owner decision D8).** Table `agent_secrets`
(migration 004) holds the SHA-256 hex of each secret, never the value. A salt
or a slow hash protects guessable inputs such as passwords; a 256-bit random
value cannot be guessed, so a plain SHA-256 is enough, and it lets HQ find the
secret's row by a unique index on the hash. A copy of the store therefore
holds nothing an attacker can present to HQ.

**Lifecycle.**

- A new secret is issued just before an agent session is launched. Issuing
  revokes the agent's live secret (reason `rotated`) in the same transaction,
  so at most one secret per agent is live (`one_live_secret` index).
- Stopping a session in HQ, or HQ finding the session's process dead and
  closing it, revokes the secret (reason `stopped`). A start that fails after
  issuing revokes the secret it issued.
- Pausing or retiring an agent revokes its secret in the same transaction as
  the status change (reasons `paused`, `retired`).
- Rows are never deleted, and a revoked row is never brought back (triggers).
  A retired agent row cannot change its status or `retired_at` again.

**No rewrite on reattach.** Because only the hash is kept, HQ cannot write the
same secret again. When HQ restarts and finds an agent session still running
(tmux keeps sessions alive across restarts), it reattaches and writes no file;
the running agent keeps the secret it was started with. An agent still
running with the pre-M0-B shared token is told once, in the activity feed, to
be restarted.

**One carrier.** The secret travels only in `Authorization: Bearer <secret>`
on `/mcp` and `/hook`. The agent id in a hook URL or an `X-HQ-Agent` header is
a claim that must match the secret's agent, never a source of identity. The
secret is written only to the agent's own MCP and hook configuration files,
mode 0600 and excluded from git. Agent secrets open nothing else (no WebSocket,
no dashboard; owner decision D6, SR-B-24).

**Roles decide tools.** The agent's role comes from the company store
(`agents.role_id`), read on every request. `isLead` in the repo config seeds
the role once, on a project's first import, and grants nothing afterwards. The
tool sets (`TOOLS_BY_ROLE` in `server/company/roleTools.ts`) follow spec §2a
for the tools that exist today:

| Role | Tools |
|---|---|
| `cto` | `list_workers`, `get_status`, `list_tasks`, `create_board`, `create_task`, `update_task`, `assign_task`, `send_message`, `set_my_status`, and, transitionally, `ask_user`, `request_access` |
| `builder` | `get_my_task`, `set_my_status`, `send_message`, `request_access`, `ask_user` |
| any other role | none |

Every tool call, allowed or refused, writes one audit row whose actor is the
authenticated agent. A call whose row cannot be written is not carried out.

## Limits accepted

- **The CTO keeps `ask_user` and `request_access` until `raise_decision`
  exists (M1).** §2a's M1 row replaces them, but removing them now would leave
  the CTO no way to reach the owner from M0-B until M1, a regression anti-goal
  §4 forbids. The overview carries their removal to the M1 plan that adds
  `raise_decision`.
- **SR-B-12 holds for the audit row, not for task state.** Tasks still live in
  memory and in `plan.json`. The audit row is written first, inside the
  transaction, and the tool runs after it; if the store's COMMIT then fails,
  the tool's change stays without its row. That needs a failed COMMIT on a
  local file. It closes when `plan.json` moves to the store (M0-D).
- **A session that ends outside HQ keeps a live secret** until the agent is
  next started, paused or retired. HQ's poll does not revoke when a session
  merely looks gone: a tmux check fails on a timeout, and a start can overlap
  the poll, so revoking there would lock out running agents. The secret is
  only in the agent's own 0600 files. Revoking after the session has been
  absent on two polls in a row can be revisited in M0-G, when HQ runs
  unattended.
- **Use before rotation.** An agent that copies another agent's secret can use
  it until that agent's next session start (T-S1.2, spec M0.2). Binding a
  secret to its sandbox's network origin (SR-B-09) is recorded in ADR 0006 and
  moved to M0-G.
- **The hook command carries the secret on its command line**
  (`curl -H 'Authorization: Bearer …'`), where the process list can show it.
  The overview carries reading it from a 0600 file to M0-E.

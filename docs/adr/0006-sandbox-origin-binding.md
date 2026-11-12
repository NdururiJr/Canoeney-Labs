# ADR 0006: Sandbox origin binding is not verified in M0-B

## Status

Accepted, with the check moved to M0-G

## Context

Threat model SR-B-09 asks that, where the sandbox proxy allows it, HQ refuse
an agent's secret when it arrives from any sandbox but that agent's own. That
would stop a secret copied into another sandbox from working there (T-S1.5).

Agents in Docker Sandboxes reach HQ at `host.docker.internal:<port>` through
the `sbx` proxy, and HQ listens on 127.0.0.1 only. So every request HQ sees
comes from the same local address. Whether the proxy passes on anything that
identifies the sandbox (a header, a source port range, a distinct address) can
only be checked with `sbx` running. `sbx` is not installed on the machine
M0-B was built on.

## Decision

M0-B does not bind secrets to an origin. It records the gap here and in the
overview's carry-forward table, and M0-G checks it on the Linux host that runs
Docker Sandboxes:

1. Find what the proxy shows HQ for two sandboxes calling at the same time.
2. If it tells them apart, refuse a secret from any origin but its agent's, with
   the uniform 401 and an `auth.failed` row (reason `wrong-origin`).
3. If it does not, record that SR-B-09 cannot be met with `sbx` as it is.

## Residual risk

A secret copied into another sandbox works there until the owning agent's
next session start, which rotates it (ADR 0005). Copying needs an agent that
can read another agent's files: each secret is only in its own agent's
workspace, in files of mode 0600 that git ignores. The spec accepts use before
rotation as a residual (M0.2: "an agent can read its own secret").

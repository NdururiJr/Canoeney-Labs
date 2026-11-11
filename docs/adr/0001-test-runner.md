# ADR 0001: Test runner

## Status

Accepted

## Context

The repo had no tests. The company core (SQLite store, audit chain) needs a
test runner before it needs anything else, and it must work on Windows, macOS
and Linux CI without growing the dependency tree. The server is TypeScript and
already runs through `tsx`. The company store uses `node:sqlite`, which is
unflagged from Node 22.13, so that is the engine floor.

## Decision

Use `node:test` with `node:assert/strict`, run through `tsx`:
`node --disable-warning=ExperimentalWarning --import tsx --test "server/**/*.test.ts"`.
No new dependency. The glob is quoted so Node expands it on every OS. Test
files live beside the code as `*.test.ts` and are type-checked by
`server/tsconfig.json`.

Rejected: Vitest. It adds a large dependency tree and resolves `node:sqlite`
through Vite, which does not treat it as a built-in reliably.

## Consequences

- `pnpm test` runs every `server/**/*.test.ts`; CI runs it after `pnpm build`.
- `engines.node` is `>=22.13`, the `build` CI job moves to Node 24, and the
  server bundle targets `node22`.
- Time-dependent code takes a `Clock` (`server/company/clock.ts`); tests use
  `FakeClock` and never use real time.

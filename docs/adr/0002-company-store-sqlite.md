# ADR 0002: Company store on built-in SQLite

## Status

Accepted

## Context

The company core needs a durable store with real transactions and an
append-only audit log (M0.4). It must add no native build step and no new
supply-chain dependency (S12).

## Decision

Use the built-in `node:sqlite` module (SQLite 3.50 in Node 24). Only
`server/company/db.ts` imports it; everything else uses the `CompanyDb` and
`Statement` interfaces, so no driver types leak.

## Why

- Transactions and an append-only audit log come with SQLite.
- Nothing to compile, nothing to install, nothing new to audit.

## Cost

The API is marked experimental, and Node prints one warning at HQ startup.
Tests silence it with `--disable-warning=ExperimentalWarning`.

## Fallback

`better-sqlite3`, swapped in inside `db.ts` only. The interfaces stay the same.

## Migrations

Migrations are TypeScript modules (`server/company/migrations.ts`), so the
server bundle carries them. Each runs in its own `BEGIN IMMEDIATE` transaction
with its `schema_migrations` row. A migration is never edited after it merges;
a change is a new migration. A store whose version is higher than the highest
known migration is refused with `SchemaTooNewError`, which covers checking out
an older branch.

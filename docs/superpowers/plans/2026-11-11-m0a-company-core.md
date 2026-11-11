# M0-A Company core: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give HQ a durable, tested company store: a test harness, an injectable clock, an SQLite database with migrations, the company data model, a tamper-evident audit chain, and local implementations of the five slots, opened by HQ at startup.

**Architecture:** All new code lives in `server/company/`. Only `server/company/db.ts` imports the SQLite driver (`node:sqlite`). Everything else uses the small `CompanyDb` interface, so the driver can be swapped in one file. The schema is applied by numbered migrations written as TypeScript modules, so the esbuild server bundle carries them with no extra files. The audit log is a SHA-256 hash chain in an append-only table. The store lives at `~/.jsmhq/_company/`, outside every repo and every agent folder.

**Tech stack:** Node ≥ 22.13 (`node:sqlite`, `node:test`, `node:crypto`), TypeScript 5.8, `tsx` (already a dev dependency). No new packages.

**Spec:** `docs/superpowers/specs/2026-11-09-agentic-company-m0-m1-design.md`. This plan covers M0.3, M0.4, M0.5 and M0.13, part of M0.9 (ADRs), and the audit foundation used by M1.9 and M0.16. The plan order is in `docs/superpowers/plans/2026-11-11-m0-foundations-overview.md`.

## Global constraints

- Keep the existing stack: Vite, React, TypeScript, PixiJS, zustand, Tailwind, Node server, MCP SDK (spec §7).
- "A secret value enters a sandbox, a log, an alert or the audit trail" is an anti-goal (§4). The audit sink rejects secret-shaped keys (Task 4).
- Company state lives "outside any repo or folder an agent can write to or open a PR against" (M1.1, M0.11): `~/.jsmhq/_company/`, never under the managed repo.
- "Store client personal data in the trail by reference, never by value" (§9.5): no contact fields on `clients`; audit `data` carries ids.
- "Existing HQ capabilities … regress" is an anti-goal (§4): `pnpm typecheck`, `pnpm build`, `scripts/session-backend-test.ts` and `scripts/smoke-test.mjs` keep passing on Ubuntu, macOS and Windows.
- Times are stored as ISO-8601 UTC strings from the injected `Clock`. East Africa Time applies to scheduling in M1, not to storage.
- The fork's name is **Canoeney Labs** (M0.1, owner, may still change), but renaming is M0-H's job. M0-A introduces no product name in code. The `.jsmhq` folder name goes behind one constant, `HQ_DIRNAME`, so M0-H changes it in one place.
- Money is an integer in minor units plus an upper-case ISO 4217 currency (`KES`, `USD`).
- Existing `.jsmhq/config.json` and `plan.json` stay as they are. Moving them is M0-D.

## Review focus

1. **Two HQ processes on one store** (the owner starts HQ twice, or a backup job reads during a write): every audit append must still extend one valid chain. Test: Task 4 `two connections appending interleaved keep one valid chain`.
2. **Non-ASCII and nested data in audit events** (Kenyan names with diacritics, emoji, key order that differs between callers): the hash must not depend on key order or encoding. Test: Task 4 `hash is independent of key order and survives unicode`.
3. **Paths with spaces** (this repo lives under `Antigravity Projects/Canoeney Labs`; Windows home folders often contain spaces): the store must open, migrate and reopen. Test: Task 2 `opens and reopens a store in a folder with spaces`.
4. **A caller passes a secret in audit data** (`{ token: "…" }`): the append is refused and nothing is written. Test: Task 4 `refuses secret-shaped keys anywhere in data`.
5. **The clock goes backwards** (NTP correction, a fake clock in tests): ordering and verification use `seq`, never time. Test: Task 4 `clock going backwards does not break order or verification`.

---

### Task 1: Test harness and injectable clock

**Files:**
- Modify: `package.json` (`scripts.test`, `engines.node`)
- Modify: `.github/workflows/ci.yml` (`build` job: `node-version: 24`; add a `pnpm test` step after `pnpm build`)
- Modify: `scripts/build-server.mjs` (`target: "node22"`)
- Create: `server/company/clock.ts`
- Test: `server/company/clock.test.ts`
- Create: `docs/adr/0001-test-runner.md`

**Interfaces:**
- Produces:
  - `interface Clock { now(): Date }`
  - `const systemClock: Clock`
  - `class FakeClock implements Clock { constructor(start: Date | string); now(): Date; advance(ms: number): void; set(t: Date | string): void }`. `now()` returns a new `Date` each call, so a caller mutating it can't move the clock.
  - `pnpm test` runs every `server/**/*.test.ts`

- [ ] **Step 1: Add the test script and Node floor**

In `package.json`: `"test": "node --disable-warning=ExperimentalWarning --import tsx --test \"server/**/*.test.ts\""`, and `"engines": { "node": ">=22.13" }` (the first unflagged `node:sqlite`). The glob is quoted so Node expands it on every OS.

- [ ] **Step 2: Write the failing test** in `server/company/clock.test.ts`, using `node:test` and `node:assert/strict`:

```ts
test("FakeClock starts where told and advances", () => {
  const c = new FakeClock("2026-11-11T06:00:00.000Z");
  assert.equal(c.now().toISOString(), "2026-11-11T06:00:00.000Z");
  c.advance(90_000);
  assert.equal(c.now().toISOString(), "2026-11-11T06:01:30.000Z");
});
test("FakeClock.set can move backwards", () => {
  const c = new FakeClock("2026-11-11T06:00:00.000Z");
  c.set("2026-11-10T00:00:00.000Z");
  assert.equal(c.now().toISOString(), "2026-11-10T00:00:00.000Z");
});
test("mutating a returned Date does not move the clock", () => {
  const c = new FakeClock("2026-11-11T06:00:00.000Z");
  c.now().setUTCFullYear(1999);
  assert.equal(c.now().toISOString(), "2026-11-11T06:00:00.000Z");
});
test("systemClock is close to Date.now()", () => {
  assert.ok(Math.abs(systemClock.now().getTime() - Date.now()) < 1000);
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm test`
Expected: FAIL, cannot find module `./clock`.

- [ ] **Step 4: Implement `server/company/clock.ts`** with the interfaces above.

- [ ] **Step 5: Run it and confirm it passes**

Run: `pnpm test` → 4 pass, 0 fail. Run `pnpm typecheck` → exit 0. Tests are type-checked because `server/tsconfig.json` includes `./**/*.ts`.

- [ ] **Step 6: Update CI and the bundle target**

In `ci.yml`, change the `build` job to `node-version: 24` and add `- run: pnpm test` right after `- run: pnpm build`. Leave `linux-bare` on `node:22-bookworm-slim`, since current 22.x is above 22.13. In `build-server.mjs`, set `target: "node22"`.

- [ ] **Step 7: Write `docs/adr/0001-test-runner.md`**

Use the ADR format for every ADR: Status, Context, Decision, Consequences, at most one page. Content:
- **Decision:** `node:test` through `tsx`, with no new dependency.
- **Rejected:** Vitest, which adds a dependency tree and resolves `node:sqlite` through Vite.
- **Consequence:** time-dependent code takes a `Clock`; tests never use real time.

- [ ] **Step 8: Commit**

```bash
git add package.json .github/workflows/ci.yml scripts/build-server.mjs server/company/clock.ts server/company/clock.test.ts docs/adr/0001-test-runner.md
git commit -m "test: add node:test harness, injectable clock, CI test step"
```

---

### Task 2: Company database and migrations

**Files:**
- Create: `server/company/db.ts` (the only file that imports `node:sqlite`)
- Create: `server/company/migrations.ts`
- Test: `server/company/db.test.ts`
- Create: `docs/adr/0002-company-store-sqlite.md`

**Interfaces:**
- Consumes: none.
- Produces:
  - `type SqlValue = string | number | bigint | null | Uint8Array`
  - `interface Statement { run(...p: SqlValue[]): { changes: number; lastInsertRowid: number | bigint }; get<T>(...p: SqlValue[]): T | undefined; all<T>(...p: SqlValue[]): T[] }`
  - `interface CompanyDb { readonly file: string; exec(sql: string): void; prepare(sql: string): Statement; transaction<T>(fn: () => T, mode?: "deferred" | "immediate"): T; close(): void }`
  - `function openCompanyDb(file: string, migrations?: readonly Migration[]): CompanyDb`. It runs the PRAGMAs and then `migrate`. `migrations` defaults to `MIGRATIONS`, and tests pass fixtures.
  - `class SchemaTooNewError extends Error`
  - In `migrations.ts`:
    - `interface Migration { version: number; name: string; up: string }`
    - `const MIGRATIONS: readonly Migration[]`, which starts as `[]` in this task
    - `function migrate(db: CompanyDb, migrations: readonly Migration[]): { applied: number[] }`
    - `function schemaVersion(db: CompanyDb): number`

**Behaviour the tests pin:**
- **PRAGMAs on open:** `foreign_keys = ON`, `busy_timeout = 5000`, and `journal_mode = WAL` for files (`:memory:` reports `memory`).
- **On POSIX,** the parent directory is created with mode `0700` and the file is `chmod 0600` after opening.
- **Bookkeeping table:** `schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`.
- **Each migration** runs in its own `BEGIN IMMEDIATE` transaction together with its bookkeeping row.
- **If the stored version is higher** than the highest known migration, opening throws `SchemaTooNewError`. The message names both versions. This covers the owner checking out an older branch.
- **`transaction`** commits on return and rolls back on throw. A nested call throws `Error("nested transaction")`. Track depth in the wrapper rather than relying on driver flags.

- [ ] **Step 1: Write the failing tests** in `server/company/db.test.ts`. Use a `tmpStore()` helper that returns `{ dir, file }` from `mkdtempSync(join(tmpdir(), "hq company "))`, a prefix with spaces on purpose. Close every database before `rmSync`, because Windows keeps WAL files locked. The fixtures are `m1 = { version: 1, name: "a", up: "CREATE TABLE a(x INTEGER);" }` and `m2 = { version: 2, name: "b", up: "CREATE TABLE b(y INTEGER);" }`.
  - `opens a file store with WAL and foreign keys on`: `journal_mode` is `"wal"` and `foreign_keys` is `1`.
  - `migrate applies pending migrations in order and records them`: `openCompanyDb(file, [m1, m2])`, then the `schema_migrations` versions are `[1, 2]` and tables `a` and `b` exist.
  - `reopening applies nothing`: reopen with `[m1, m2]`, then `migrate(db, [m1, m2]).applied` deep-equals `[]`.
  - `a failing migration rolls back and leaves the version unchanged`: `bad = { version: 2, name: "bad", up: "CREATE TABLE b(y INTEGER); NOT SQL;" }`. Opening with `[m1, bad]` throws, then a reopen with `[m1]` shows `schemaVersion` is `1` and table `b` doesn't exist.
  - `refuses a store newer than the code`: open with `[m1, m2]`, close, then reopen with `[m1]`. It throws `SchemaTooNewError` and the message matches `/2.*1|1.*2/`.
  - `transaction rolls back on throw` and `nested transaction throws`.
  - `opens and reopens a store in a folder with spaces` (Review focus 3): the `tmpStore` path contains a space; open, migrate, close, reopen and check that `schemaVersion` is `2`.
  - `store file is private on POSIX`, skipped when `process.platform === "win32"`: `statSync(file).mode & 0o777` is `0o600`.

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm test`; it fails because `./db` can't be found.

- [ ] **Step 3: Implement `db.ts` and `migrations.ts`** with the interfaces and behaviour above. `Statement.get` and `all` cast the driver's row objects to `T`.

- [ ] **Step 4: Run them and confirm they pass.** `pnpm test` shows every test passing, and `pnpm typecheck` exits 0.

- [ ] **Step 5: Write `docs/adr/0002-company-store-sqlite.md`**
  - **Decision:** built-in `node:sqlite` (SQLite 3.50 in Node 24).
  - **Why:** transactions plus an append-only audit log (M0.4), no native build and no supply-chain addition (S12).
  - **Cost:** the API is marked experimental and prints one warning at HQ startup.
  - **Fallback:** `better-sqlite3`, swapped inside `db.ts` only.
  - **Migrations:** written as TypeScript modules so the server bundle carries them. A migration is never edited after it merges.

- [ ] **Step 6: Commit**

```bash
git add server/company/db.ts server/company/migrations.ts server/company/db.test.ts docs/adr/0002-company-store-sqlite.md
git commit -m "feat(company): SQLite company store with migrations"
```

---

### Task 3: Company data model (migration 001)

**Files:**
- Create: `server/company/schema/001_company.ts` (exports `m001: Migration`)
- Create: `server/company/types.ts`
- Modify: `server/company/migrations.ts` (`MIGRATIONS = [m001]`)
- Test: `server/company/schema.test.ts`

**Interfaces:**
- Consumes: `openCompanyDb`, `Migration` (Task 2).
- Produces, in `types.ts`. These string unions must equal the SQL `CHECK` lists and seeds below.
  - `RoleId = "ceo" | "cio" | "security-audit" | "cto" | "solutions" | "builder" | "qa" | "security-reviewer" | "customer-service" | "accountant" | "sales" | "marketing" | "research"`
  - `DepartmentId = "executive" | "internal-it" | "delivery" | "clients" | "finance" | "growth" | "strategy" | "security-audit"`
  - `HumanRole = "owner" | "supervisor"`
  - `AgentStatus = "active" | "paused" | "retired"`
  - `DecisionCategory = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8` (spec M1.2; `null` = voluntary escalation)
  - `Urgency = "critical" | "high" | "normal" | "fyi"`
  - `DecisionStatus = "pending" | "approved" | "denied" | "expired"`
  - `ExecutionStatus = "not-started" | "started" | "done" | "failed"` (review 2: "started")
  - `Verification = "pin" | "channel-reply"`
  - `PermissionKind = "network-allow" | "network-deny" | "mcp-server" | "secret-name" | "tool" | "skill"`
  - `SpendSource = "api-metered" | "subscription" | "invoice" | "estimate"`
  - `ActorKind = "agent" | "human" | "hq"`

**Schema (`m001`, version 1, name `"company"`).**
- Every `*_at` column is `TEXT` (ISO UTC).
- Every `currency` column is `TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency))`.
- `CHECK IN (X)` is shorthand for `CHECK (column IN (…))` with the values of the `X` union from `types.ts`.
- Tables may reference tables created later in the same migration; SQLite checks foreign keys on insert.
- Files under `schema/` import `Migration` with `import type`, to avoid a runtime import cycle with `migrations.ts`.
- Authentication columns for humans are added by M0-C. Message and task tables by M0-D/M1.

| Table | Columns and constraints |
|---|---|
| `roles` | `id TEXT PK`, `label TEXT NOT NULL`. Seeded with the 13 `RoleId`s. |
| `departments` | `id TEXT PK`, `name TEXT NOT NULL`, `head_agent_id TEXT NULL REFERENCES agents(id)`. Seeded with the 8 `DepartmentId`s, heads null (spec M1.13: each department has a head who reports to the CEO). |
| `humans` | `id TEXT PK`, `display_name TEXT NOT NULL`, `role TEXT NOT NULL CHECK IN (HumanRole)`, `created_at`, `disabled_at NULL`. `UNIQUE INDEX one_owner ON humans(role) WHERE role = 'owner'`. |
| `clients` | `id TEXT PK`, `display_name TEXT NOT NULL`, `created_at`. No contact fields (§9.5); M3 adds them after the Data Protection Act review. |
| `projects` | `id TEXT PK`, `name TEXT NOT NULL`, `repo TEXT NOT NULL`, `kind TEXT NOT NULL CHECK IN ('company','client')`, `client_id TEXT NULL REFERENCES clients(id)`, `created_at`. `CHECK ((kind = 'client') = (client_id IS NOT NULL))`. |
| `agents` | `id TEXT PK`, `name TEXT NOT NULL`, `role_id TEXT NOT NULL REFERENCES roles(id)`, `department_id TEXT NOT NULL REFERENCES departments(id)`, `manager_id TEXT NULL REFERENCES agents(id)`, `human_owner_id TEXT NULL REFERENCES humans(id)`, `project_id TEXT NULL REFERENCES projects(id)` (null for company-level agents), `cli TEXT NOT NULL CHECK IN ('claude','codex')`, `status TEXT NOT NULL DEFAULT 'active' CHECK IN (AgentStatus)`, `autonomy_json TEXT NOT NULL DEFAULT '{}'` (empty means the charter's defaults, which are the most conservative), `created_at`, `retired_at NULL`. `CHECK (manager_id IS NULL OR manager_id <> id)`. |
| `charter_versions` | `version INTEGER PK`, `content_json TEXT NOT NULL`, `changed_by_human_id TEXT NOT NULL REFERENCES humans(id)`, `changed_at`, `note TEXT`. Append-only. |
| `permissions` | `id INTEGER PK`, `agent_id TEXT NOT NULL REFERENCES agents(id)`, `kind TEXT NOT NULL CHECK IN (PermissionKind)`, `value TEXT NOT NULL`, `granted_by_decision_id TEXT NULL REFERENCES decisions(id)`, `granted_by_human_id TEXT NULL REFERENCES humans(id)`, `granted_at`, `revoked_at NULL`. `UNIQUE INDEX one_active_grant ON permissions(agent_id, kind, value) WHERE revoked_at IS NULL`. |
| `decisions` | `id TEXT PK`, `category INTEGER NULL CHECK (category BETWEEN 1 AND 8)`, `requester_kind TEXT NOT NULL CHECK IN ('agent','hq')`, `requester_id TEXT NOT NULL`, `summary TEXT NOT NULL`, `details TEXT NOT NULL DEFAULT ''`, `options_json TEXT NOT NULL DEFAULT '[]'`, `recommendation TEXT`, `cost_minor INTEGER NULL CHECK (cost_minor >= 0)`, `cost_currency TEXT NULL`, `urgency TEXT NOT NULL CHECK IN (Urgency)`, `deadline_at NULL`, `status TEXT NOT NULL DEFAULT 'pending' CHECK IN (DecisionStatus)`, `decided_by_human_id TEXT NULL REFERENCES humans(id)`, `decided_at NULL`, `channel TEXT NULL`, `verification TEXT NULL CHECK IN (Verification)`, `reply_code TEXT NOT NULL UNIQUE`, `dedupe_key TEXT NOT NULL`, `execution_status TEXT NOT NULL DEFAULT 'not-started' CHECK IN (ExecutionStatus)`, `idempotency_key TEXT NOT NULL UNIQUE`, `created_at`. `INDEX decisions_dedupe ON decisions(dedupe_key, status)`. |
| `budgets` | `id INTEGER PK`, `area TEXT NOT NULL`, `period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')`, `limit_minor INTEGER NOT NULL CHECK (limit_minor >= 0)`, `currency`. `UNIQUE(area, period)`. |
| `spend` | `id INTEGER PK`, `occurred_at`, `vendor TEXT NOT NULL`, `area TEXT NOT NULL`, `amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0)`, `currency`, `source TEXT NOT NULL CHECK IN (SpendSource)`, `agent_id TEXT NULL REFERENCES agents(id)`, `decision_id TEXT NULL REFERENCES decisions(id)`. |
| `audit_events` | `seq INTEGER PK`, `at TEXT NOT NULL`, `actor_kind TEXT NOT NULL CHECK IN (ActorKind)`, `actor_id TEXT NOT NULL`, `action TEXT NOT NULL`, `target TEXT NULL`, `decision_id TEXT NULL` (by reference, no foreign key, so the trail can record anything), `data_json TEXT NOT NULL`, `prev_hash TEXT NOT NULL`, `hash TEXT NOT NULL UNIQUE`. Append-only. |

Append-only means two triggers per table, named `<table>_no_update` and `<table>_no_delete`: `BEFORE UPDATE` / `BEFORE DELETE … BEGIN SELECT RAISE(ABORT, 'append-only'); END`.

- [ ] **Step 1: Write the failing tests** in `server/company/schema.test.ts`, each on `openCompanyDb(":memory:")`:
  - `seeds the 13 roles and 8 departments`: sorted ids deep-equal the sorted `RoleId` and `DepartmentId` lists.
  - `only one owner`: a second `humans` row with `role = 'owner'` throws `/UNIQUE/`, and a `supervisor` row inserts.
  - `an agent's role and department must exist`: `role_id = 'ninja'` throws `/FOREIGN KEY/`.
  - `an agent cannot manage itself`: throws `/CHECK/`.
  - `a client project needs a client and a company project must not have one`: both wrong combinations throw `/CHECK/`.
  - `decision category is 1–8 or null`: `9` throws `/CHECK/`, while `null` and `2` insert.
  - `execution status accepts started`.
  - `reply codes and idempotency keys are unique`.
  - `charter versions are append-only` and `audit events are append-only`: `UPDATE` and `DELETE` each throw `/append-only/`.
  - `one active grant per agent, kind and value; a revoked grant can be granted again`.
  - `currency must be three upper-case letters`: `'KES'` inserts; `'kes'` and `'KE'` throw `/CHECK/`.

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm test`; they fail with `no such table`.

- [ ] **Step 3: Implement `001_company.ts` and `types.ts`,** then register `m001` in `MIGRATIONS`.

- [ ] **Step 4: Run them and confirm they pass.** `pnpm test` passes, including Task 2's tests, and `pnpm typecheck` exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/company/schema server/company/types.ts server/company/migrations.ts server/company/schema.test.ts
git commit -m "feat(company): company data model (migration 001)"
```

---

### Task 4: Tamper-evident audit chain (the `AuditSink` slot)

**Files:**
- Create: `server/company/canonicalJson.ts`
- Create: `server/company/slots/types.ts` (the `AuditSink` part)
- Create: `server/company/audit.ts`
- Test: `server/company/canonicalJson.test.ts`, `server/company/audit.test.ts`

**Interfaces:**
- Consumes: `CompanyDb.transaction(fn, "immediate")` (Task 2); `audit_events` (Task 3); `Clock` (Task 1); `ActorKind` (Task 3).
- Produces:
  - `canonicalJson(value: unknown): string`
  - In `slots/types.ts`:
    - `interface AuditEventInput { actorKind: ActorKind; actorId: string; action: string; target?: string | null; decisionId?: string | null; data?: Record<string, unknown> }`
    - `interface AuditEvent { seq: number; at: string; actorKind: ActorKind; actorId: string; action: string; target: string | null; decisionId: string | null; data: Record<string, unknown>; prevHash: string; hash: string }`
    - `interface AuditQuery { actorId?: string; action?: string; decisionId?: string; afterSeq?: number; limit?: number }`. `limit` defaults to 100 and is capped at 1000; results are ordered by `seq` ascending.
    - `type AuditVerify = { ok: true; count: number; head: string | null } | { ok: false; brokenAtSeq: number }`
    - `interface AuditSink { append(e: AuditEventInput): AuditEvent; head(): { seq: number; hash: string } | null; verify(): AuditVerify; query(q?: AuditQuery): AuditEvent[] }`
  - In `audit.ts`:
    - `class SqliteAuditSink implements AuditSink { constructor(db: CompanyDb, clock: Clock) }`
    - `class AuditSecretError extends Error`
    - `const GENESIS_HASH = "0".repeat(64)`

**Rules:**
- **`canonicalJson`:**
  - Object keys are sorted with the default `Array.prototype.sort`, recursively, with no whitespace, and keys whose value is `undefined` are omitted.
  - Arrays keep their order.
  - Strings and finite numbers serialise as `JSON.stringify` does, along with booleans and `null`.
  - It throws `TypeError` for non-finite numbers, `bigint`, functions, symbols, and any object whose prototype isn't `Object.prototype` or `null` (for example `Date` or `Map`). Callers pass ISO strings.
- **Hash:** the SHA-256 hex digest of `prevHash + "\n" + canonicalJson({ seq, at, actorKind, actorId, action, target, decisionId, data })`, where `target` and `decisionId` are normalised to `null` and `data` to `{}`.
- **`append`:**
  - Runs inside `transaction(…, "immediate")`, reading the last row inside that transaction.
  - Sets `seq` to the last seq + 1 (or 1) and `prevHash` to the last hash (or `GENESIS_HASH`).
  - Takes `at` from `clock.now().toISOString()`.
- **Secret guard:** before anything is written, `append` throws `AuditSecretError` if any key at any depth of `data` matches `/^(secret|token|password|passphrase|pin|api[-_]?key|authorization|cookie|private[-_]?key)$/i`. Key *names* such as `secretName` are allowed, because secret names are fine and values are not (spec §4).
- **`verify`:**
  - Walks every row by `seq` ascending.
  - Reports the first row where `seq` isn't the previous seq + 1, `prev_hash` isn't the previous hash, or the recomputed hash differs.

- [ ] **Step 1: Write the failing tests**

`canonicalJson.test.ts`:
- `sorts keys recursively and omits undefined`: `canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })` returns `'{"a":{"d":[3,{"y":2,"z":1}]},"b":1}'`.
- `rejects non-plain values`: `NaN`, `Infinity`, `10n`, `new Date()`, `new Map()` and `() => 1` each throw `TypeError`.

`audit.test.ts`, each test on a fresh migrated `":memory:"` store with `new FakeClock("2026-11-11T06:00:00.000Z")` unless it says otherwise:
- `first event links to the genesis hash`: `seq` is 1, `prevHash` is `GENESIS_HASH`, `hash` matches `/^[0-9a-f]{64}$/`, and `at` is the fake clock's time.
- `each event links to the previous one`: after 3 appends, `e3.prevHash === e2.hash` and `head()` deep-equals `{ seq: 3, hash: e3.hash }`.
- `verify passes on an untouched chain`: `{ ok: true, count: 3, head: e3.hash }`.
- `verify finds an edited row`: after `db.exec("DROP TRIGGER audit_events_no_update")` and `UPDATE audit_events SET data_json = '{"x":2}' WHERE seq = 2`, the result is `{ ok: false, brokenAtSeq: 2 }`.
- `verify finds a deleted row`: drop `audit_events_no_delete`, delete seq 2; the result is `{ ok: false, brokenAtSeq: 3 }`.
- `hash is independent of key order and survives unicode` (Review focus 2): append `{ name: "Wanjirũ Ndũrũrĩ 🚀", z: 1, a: { y: 2, x: 1 } }` to one store and the same data with keys in a different order to a second store with the same clock. The two `hash` values are equal, and in the first store `query()[0].data.name` round-trips exactly.
- `refuses secret-shaped keys anywhere in data` (Review focus 4): `{ token: "x" }`, `{ nested: { API_KEY: "x" } }` and `{ list: [{ Password: "x" }] }` each throw `AuditSecretError`, and afterwards `head()` is `null`. `{ secretName: "github" }` is accepted.
- `clock going backwards does not break order or verification` (Review focus 5): append, `clock.set("2020-01-01T00:00:00.000Z")`, append. `query().map(e => e.seq)` deep-equals `[1, 2]` and `verify().ok` is `true`.
- `query filters`: 5 events with two `actorId`s. Filtering by `actorId` returns only that actor's events, ascending, and `{ afterSeq: 3 }` returns seqs `[4, 5]`.
- `query defaults to 100 and caps at 1000`: after 1,001 appends, `query().length` is `100` and `query({ limit: 5000 }).length` is `1000`.
- `two connections appending interleaved keep one valid chain` (Review focus 1): two `openCompanyDb(file)` handles on the same temporary file, each with its own `SqliteAuditSink`, alternate 20 appends. Then `verify()` from either handle is `{ ok: true, count: 20, … }` and the seqs are 1 to 20.

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm test`; it fails because `./canonicalJson` and `./audit` can't be found.

- [ ] **Step 3: Implement `canonicalJson.ts`, `slots/types.ts` (the audit part) and `audit.ts`** to the rules above.

- [ ] **Step 4: Run them and confirm they pass.** `pnpm test` passes in full and `pnpm typecheck` exits 0.

- [ ] **Step 5: Write `docs/adr/0003-audit-hash-chain.md`.** It covers:
  - the hash input;
  - the genesis value;
  - why `seq` and not time;
  - the secret-key guard;
  - what tampering it detects (edits, deletions and reordering, *if* the head is anchored off-host);
  - that anchoring and backups are M0-G and read `head()`.

- [ ] **Step 6: Commit**

```bash
git add server/company/canonicalJson.ts server/company/canonicalJson.test.ts server/company/slots/types.ts server/company/audit.ts server/company/audit.test.ts docs/adr/0003-audit-hash-chain.md
git commit -m "feat(company): tamper-evident audit chain"
```

---

### Task 5: `Memory` and `Knowledge` slots (migration 002)

**Files:**
- Create: `server/company/schema/002_memory_knowledge.ts` (`m002`, version 2, name `"memory-knowledge"`)
- Modify: `server/company/migrations.ts` (`MIGRATIONS = [m001, m002]`)
- Modify: `server/company/slots/types.ts` (add the interfaces below)
- Create: `server/company/slots/memory.ts`, `server/company/slots/knowledge.ts`
- Test: `server/company/slots/memory.test.ts`, `server/company/slots/knowledge.test.ts`

**Schema:**
- `memory_items(scope_kind TEXT NOT NULL CHECK IN ('agent','client'), scope_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (scope_kind, scope_id, key))`
- `knowledge_docs(id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL, updated_by_human_id TEXT NOT NULL REFERENCES humans(id))`

**Interfaces:**
- Consumes: `CompanyDb`, `Clock`, `AuditSink`.
- Produces (in `slots/types.ts`):
  - `type MemoryScope = { kind: "agent" | "client"; id: string }`
  - `interface MemoryEntry { key: string; value: string; updatedAt: string }`
  - `interface Memory { get(s: MemoryScope, key: string): string | null; set(s: MemoryScope, key: string, value: string): void; delete(s: MemoryScope, key: string): boolean; list(s: MemoryScope): MemoryEntry[] }`. `list` is sorted by key.
  - `const MEMORY_VALUE_MAX_BYTES = 65_536`. `set` throws `RangeError` when the value's UTF-8 length is larger.
  - `interface KnowledgeDoc { id: string; title: string; body: string; version: number; updatedAt: string }`
  - `interface Knowledge { get(id: string): KnowledgeDoc | null; list(): Omit<KnowledgeDoc, "body">[] }`. This is the **agent-facing, read-only** view (spec M0.5: "read-only to agents").
- Produces (implementations):
  - `class SqliteMemory implements Memory { constructor(db: CompanyDb, clock: Clock) }`
  - `class SqliteKnowledgeStore { constructor(db: CompanyDb, clock: Clock, audit: AuditSink); put(doc: { id: string; title: string; body: string }, byHumanId: string): KnowledgeDoc; reader(): Knowledge }`
    - `put` is the owner path. It increments `version`, starting at 1, and appends the audit event `{ actorKind: "human", actorId: byHumanId, action: "knowledge.put", target: id, data: { version } }` (never the body).
    - `reader()` returns `Object.freeze({ get, list })` and nothing else.

- [ ] **Step 1: Write the failing tests**
  - `memory.test.ts`:
    - `scopes are isolated`: a value set for agent `a` is `null` for agent `b` and for client `a`.
    - `set overwrites and stamps the clock time`.
    - `list is sorted by key`.
    - `delete reports whether a row existed`.
    - `rejects values over 64 KiB`: `"é".repeat(32_769)` is 65,538 bytes and throws `RangeError`.
  - `knowledge.test.ts`:
    - `put creates version 1 then 2`. Insert a `humans` owner row first.
    - `put audits the id and version, never the body`: the last audit event has `action` `"knowledge.put"`, its `data` deep-equals `{ version: 2 }`, and the serialised event doesn't contain the body text.
    - `reader exposes only get and list`: `Object.keys(reader).sort()` deep-equals `["get", "list"]`, `Object.isFrozen(reader)` is `true`, and `"put" in reader` is `false`.
    - `list omits bodies`.
    - `get of an unknown id is null`.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement the migration, the interfaces, `memory.ts` and `knowledge.ts`.**

- [ ] **Step 4: Run them and confirm they pass.** Run `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add server/company/schema/002_memory_knowledge.ts server/company/migrations.ts server/company/slots
git commit -m "feat(company): Memory and Knowledge slots"
```

---

### Task 6: `Router` and `Channel` slots, reply codes (migration 003)

**Files:**
- Create: `server/company/replyCode.ts`
- Create: `server/company/schema/003_channel_outbox.ts` (`m003`, version 3, name `"channel-outbox"`)
- Modify: `server/company/migrations.ts` (`MIGRATIONS = [m001, m002, m003]`)
- Modify: `server/company/slots/types.ts`
- Create: `server/company/slots/router.ts`, `server/company/slots/dashboardChannel.ts`
- Test: `server/company/replyCode.test.ts`, `server/company/slots/router.test.ts`, `server/company/slots/dashboardChannel.test.ts`

**Reply codes.** Spec M1.4: "one request and a short per-request code". This plan fixes the format so M1 can rely on it.
- A code is 5 characters from `REPLY_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"`, which has no `0 O 1 I L`.
- It's stored without a prefix and written to the owner as `#K7Q2M`.
- Each character comes from `crypto.randomInt(alphabet.length)`.

**Schema:** `channel_outbox(id INTEGER PRIMARY KEY, channel TEXT NOT NULL, recipient_human_id TEXT NOT NULL REFERENCES humans(id), decision_id TEXT NULL REFERENCES decisions(id), urgency TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, link TEXT NULL, status TEXT NOT NULL CHECK (status IN ('queued','sent','failed')), created_at TEXT NOT NULL, sent_at TEXT NULL)`.

**Interfaces:**
- Consumes: `CompanyDb`, `Clock`, `Urgency`.
- Produces:
  - `REPLY_CODE_ALPHABET`, `REPLY_CODE_LENGTH = 5`, `newReplyCode(): string`, `REPLY_CODE_PATTERN: RegExp`. The pattern matches `#` followed by exactly 5 alphabet characters, case-insensitive, not followed by `[0-9A-Za-z]`.
  - In `slots/types.ts`:
    - `interface InboundMessage { channel: string; senderRef: string; text: string; receivedAt: string }`
    - `type Route = { kind: "decision-reply"; code: string } | { kind: "unrouted"; reason: "no-code" | "ambiguous" }`
    - `interface Router { route(m: InboundMessage): Route }`
    - `interface OutboundAlert { recipientHumanId: string; decisionId: string | null; urgency: Urgency; title: string; body: string; link: string | null }`
    - `type SendResult = { ok: true; providerRef: string } | { ok: false; error: string; retryable: boolean }`. M1 needs `retryable` so a provider rejection falls straight to the next channel (review 2, item 9).
    - `interface Channel { readonly name: string; send(a: OutboundAlert): Promise<SendResult> }`
  - `class LocalRouter implements Router`:
    - It returns the upper-cased code when the text contains exactly one distinct code.
    - It returns `"ambiguous"` for two or more distinct codes and `"no-code"` for none.
    - It never interprets "yes" or "no"; that is M1's job, and inbound text is untrusted (spec M1.5).
  - `class DashboardChannel implements Channel { constructor(db: CompanyDb, clock: Clock) }`. Its `name` is `"dashboard"`. `send` inserts an outbox row with status `'sent'` and returns `{ ok: true, providerRef: String(rowid) }`.

- [ ] **Step 1: Write the failing tests**
  - `replyCode.test.ts`:
    - `1000 new codes all match the pattern and use only the alphabet`: every `` `#${c}` `` matches `REPLY_CODE_PATTERN`.
    - `excludes look-alike characters`: no code contains any of `0O1IL`.
  - `router.test.ts`, as a table of `text` → expected route:
    - `"yes #k7q2m"` → `{ kind: "decision-reply", code: "K7Q2M" }`
    - `"#K7Q2M #K7Q2M approve"` → the same (one distinct code)
    - `"#K7Q2M and #ABCDE"` → `ambiguous`
    - `"approve"`, `"#K7Q2"`, `"#K7Q2MX"` and `"#O0I1L"` → `no-code`
    - `"REJECT"` (six letters, no `#`) → `no-code`
  - `dashboardChannel.test.ts`:
    - `send writes one outbox row and returns its id`: insert an owner first. The row's channel is `"dashboard"`, its status `"sent"`, its `created_at` and `sent_at` the fake clock's time, and `providerRef` equals the row id.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement** `replyCode.ts`, the migration, the interfaces, `router.ts` and `dashboardChannel.ts`.

- [ ] **Step 4: Run them and confirm they pass.** Run `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add server/company/replyCode.ts server/company/replyCode.test.ts server/company/schema/003_channel_outbox.ts server/company/migrations.ts server/company/slots
git commit -m "feat(company): Router and Channel slots with reply codes"
```

---

### Task 7: Open the company at HQ startup

**Files:**
- Create: `server/company/home.ts`
- Modify: `server/paths.ts` (`projectHome` uses `HQ_DIRNAME`)
- Create: `server/company/index.ts`
- Modify: `server/main.ts` (open after `loadConfig`; audit start and stop; close on quit)
- Test: `server/company/company.test.ts`
- Modify: `docs/how-it-works.md` (a short "Company store" section: where it lives, what it holds, that agents never get a path to it)

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces:
  - `const HQ_DIRNAME = ".jsmhq"`; M0-H renames it.
  - `const COMPANY_DIRNAME = "_company"`. `slugify` only emits `[a-z0-9-]`, so no project slug can collide with it.
  - `function companyHome(): string`. It returns `process.env.HQ_COMPANY_HOME` if that is set, otherwise `join(homedir(), HQ_DIRNAME, COMPANY_DIRNAME)`, and creates the folder with mode `0700`.
  - `interface Company { db: CompanyDb; clock: Clock; audit: AuditSink; memory: Memory; knowledge: SqliteKnowledgeStore; router: Router; channels: Record<string, Channel>; close(): void }`
  - `function openCompany(opts: { home: string; repoRoot: string | null; clock?: Clock }): Company`:
    - It opens `join(home, "company.db")`.
    - `clock` defaults to `systemClock`.
    - `channels` holds `{ dashboard }`.
    - It throws `Error` containing `"inside the repository"` when `home` resolves to `repoRoot` or a folder under it. Comparing real paths case-insensitively on Windows is sufficient.

- [ ] **Step 1: Write the failing tests** in `company.test.ts`, using temporary folders with spaces:
  - `reopening keeps the audit chain` (store survival across restart, spec §6): `openCompany` and append `hq.started`, then close. Reopen on the same home: `query({ action: "hq.started" })` has length 1 and `verify().ok` is `true`.
  - `refuses a company home inside the repository`: with `home = join(repo, ".jsmhq", "_company")`, it throws `/inside the repository/`.
  - `the company folder can never be a project folder`: for `["_company", "company", "_Company!", " _company "]`, `slugify(x) !== COMPANY_DIRNAME`.
  - `companyHome honours HQ_COMPANY_HOME`. Save the environment value and restore it in `t.after`.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement `home.ts` and `index.ts`.** Change `paths.ts` `projectHome` to `join(homedir(), HQ_DIRNAME, projectSlug)`, which behaves the same.

- [ ] **Step 4: Wire `main.ts`**
  - **Open:** right after `loadConfig`, call `const company = openCompany({ home: companyHome(), repoRoot: repo.root })`.
  - **Start event:** append `{ actorKind: "hq", actorId: "hq", action: "hq.started", data: { project: slug } }`.
  - **Quit:** in `quit()`, append `hq.stopped`, then call `company.close()`, all before `process.exit(0)`.
  - **Errors:** if opening fails, the existing `main().catch` reports the message. `SchemaTooNewError` should read as an instruction ("this store was written by a newer HQ; update HQ").
  - **Scope:** nothing else in HQ uses `company` yet; M0-B onward does.

- [ ] **Step 5: Run the full checks**
  - Run: `pnpm typecheck && pnpm test && pnpm build`. Expected: every step exits 0, and the build prints `built dist-server/main.mjs`.
  - Run: `npx tsx scripts/session-backend-test.ts`. Expected: it passes as before.
  - Run in bash (Git Bash on Windows):

    ```bash
    mkdir -p pack && npm pack --ignore-scripts --pack-destination pack
    HQ_COMPANY_HOME="$(mktemp -d)" node scripts/smoke-test.mjs pack/*.tgz 7431
    ```

    Expected: the smoke test passes as it does in CI, and the temporary folder contains `company.db`.

- [ ] **Step 6: Update `docs/how-it-works.md`, then commit**

```bash
git add server/company/home.ts server/company/index.ts server/company/company.test.ts server/paths.ts server/main.ts docs/how-it-works.md
git commit -m "feat(company): open the company store at HQ startup"
```

---

## Done when

- **Checks:** `pnpm test`, `pnpm typecheck` and `pnpm build` pass locally, and CI is green on Ubuntu, macOS, Windows and `linux-bare`.
- **Store:** HQ starts, creates `~/.jsmhq/_company/company.db` (private on POSIX), records `hq.started` and `hq.stopped`, and a restart shows a valid chain.
- **ADRs:** 0001–0003 are written.
- **Next:** the owner runs the M0.8 threat model before M0-B is planned (see the overview).

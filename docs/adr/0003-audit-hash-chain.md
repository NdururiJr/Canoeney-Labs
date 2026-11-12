# ADR 0003: Audit hash chain

## Status

Accepted

## Context

The audit trail is the company's record of everything HQ mediates. The owner
and the Security & Audit agent read it, so it has to show when it has been
changed. The `audit_events` table refuses `UPDATE` and `DELETE` through
triggers, and a third trigger (`audit_events_chain`) refuses any `INSERT` that
does not extend the chain: its `seq` must be the current maximum + 1 (1 on an
empty table) and its `prev_hash` the hash of the current last row (64 zeros on
an empty table). But anyone with write access to the database file can drop a
trigger.

## Decision

Every event carries the hash of the event before it (`SqliteAuditSink` in
`server/company/audit.ts`).

**Hash input.** `hash = sha256_hex(prevHash + "\n" + canonicalJson({ seq, at,
actorKind, actorId, action, target, decisionId, data }))`, with `target` and
`decisionId` normalised to `null` and `data` to `{}`. `canonicalJson`
(`server/company/canonicalJson.ts`) sorts object keys, writes no whitespace,
omits `undefined` keys and refuses values that do not round-trip through JSON
(`NaN`, `Infinity`, `bigint`, functions, symbols, `Date`, `Map`, anything that
is not a plain object, and `undefined` array elements, holes included). The same string is stored in `data_json`, so what is
hashed is what is stored, and key order or Unicode cannot change a hash.

**Genesis.** The first event's `prevHash` is `GENESIS_HASH`, 64 zeros.

**Why `seq`, not time.** Order comes from `seq`, assigned as last seq + 1 inside
a `BEGIN IMMEDIATE` transaction, so two connections cannot fork the chain. The
clock can step backwards (NTP, a restored VM, a test), so `at` is recorded and
hashed but never used for ordering or verification.

**Secret-key guard.** Before anything is written, `append` throws
`AuditSecretError` if any key at any depth of `data`, through objects and
arrays, looks like a secret value, or if a value holds a known credential
shape (M0-B, PR #1 finding 1).

- *Key names.* A key is normalised (lower-cased, with `-`, `_` and whitespace
  removed). A key ending with `name`, `names`, `id` or `ids` names a secret
  without holding one and is allowed (`secretName`, `tokenId`). Otherwise it is
  refused if it **contains** `secret`, `password`, `passphrase`, `apikey`,
  `accesskey`, `privatekey`, `privkey`, `authorization`, `authheader`,
  `bearer`, `credential`, `cookie` or `jwt`; or contains `token` not followed
  by `s` or `count` (so usage keys such as `inputTokens` and `tokenCount` stay
  allowed); or **ends with** one of the short words `pin`, `pinhash`,
  `pincode`, `otp`, `totp`, `recoverycode`, `recoverycodes`, `pat`, `auth`,
  `signature`, which would match too much anywhere (`pinned`, `author`).
- *Values.* Every string in `data`, every key, the `target` and the `action`
  are scanned for `CREDENTIAL_SHAPES`: GitHub tokens, `sk-` keys, Slack
  `xox` tokens, AWS `AKIA` keys, PEM headers, JWTs, `Bearer` values and HQ
  agent secrets (`hqa_`).
- The error names the field (`data.headers.auth`, `target`) and never the
  matched text.

This catches accidents. It cannot stop a caller that reshapes a secret on
purpose, so callers still must not log values.

**Snapshot.** The hash is computed from `JSON.parse(data_json)`, the stored
form, not from the caller's object, so a getter or a later mutation cannot
make the stored row fail verification. The time `at` is read inside the write
transaction, so another writer cannot store a later `seq` with an earlier time.

**Well-formed text.** `actorId`, `action`, `target` and `decisionId` are hashed
as JS strings but stored as SQLite TEXT, which turns a lone surrogate into
U+FFFD, so the hash could never be reproduced and `verify()` would break at
that row for good, hiding later tampering. `append` therefore throws
`TypeError` for such strings before writing. `data` is safe: `JSON.stringify`
escapes lone surrogates. For the same reason `append` checks types at run time:
`actorKind` must be `agent`, `human` or `hq`, `actorId` and `action` strings,
and `target` and `decisionId` strings, `null` or absent; anything else is a
`TypeError` and nothing is written.

**Transactions.** `append` joins the caller's transaction when one is open
(`db.inTransaction`), so a business write and its audit event commit or roll
back together; callers should open it with mode `"immediate"`. Otherwise
`append` opens its own `BEGIN IMMEDIATE` transaction.

**Verification.** `verify()` first fails if any row has `seq` below 1, with
`brokenAtSeq` set to the lowest such `seq`: those rows are outside the chain
and the walk would never see them. It then walks rows by `seq` ascending from 1
and reports the first row where `seq` is not the previous seq + 1, `prev_hash`
is not the previous hash, or the hash recomputed from the stored columns
differs (the stored hash is never trusted; a non-canonical `data_json` also
fails). So every row in the table is either walked or reported.

## What it detects

- An edited row: its recomputed hash differs.
- A deleted row in the middle: the next row's `seq` and `prev_hash` no longer
  follow on.
- Reordered rows: `seq` or `prev_hash` breaks.
- Inserted rows. With the triggers in place, an insert that does not extend
  the chain is refused (`audit chain`): a row in the middle, a row with `seq`
  0 or below, or one with the wrong `prev_hash`. With the chain trigger
  dropped, a row inserted in the middle breaks `seq` or `prev_hash`, and a row
  with `seq` below 1 fails the first check of `verify()`. A row appended at the
  head with the right `seq` and `prev_hash` and a correctly computed hash is
  indistinguishable from a real event: see below.
- A row replaced with `INSERT OR REPLACE`. SQLite does not fire the delete
  trigger for the implicit delete of `REPLACE` unless `recursive_triggers` is
  on, but the chain trigger refuses it because the `seq` is not new. With that
  trigger dropped, the chain still catches the replacement; tests prove both.
  `append` uses a plain `INSERT`.

## What it does not detect on its own

Someone who can rewrite the file can recompute every hash after the point they
edit, append forged events at the head, or truncate the end of the chain. The chain is therefore tamper-evident
only if the head hash (`head()`) is anchored somewhere the attacker cannot
write. Anchoring the head off-host daily, and backups, belong to M0-G, which
reads `head()`. Until then the chain detects accidents and unsophisticated
edits, not a determined attacker with file access.

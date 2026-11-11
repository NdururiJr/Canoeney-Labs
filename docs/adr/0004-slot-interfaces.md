# ADR 0004: Slot interfaces, async and sync

## Status

Accepted

## Context

The company core has swappable slots (spec M0.5) so an external memory or
context product can be tried later "without rewrites". The defaults run on the
local SQLite store and could all be synchronous, but a product reached over the
network cannot implement a synchronous method. Some parts, though, must stay
local and synchronous because their correctness depends on a local transaction.

## Decision

**Async slots** (`server/company/slots/types.ts`):

- `Memory`: `get`, `set`, `delete` and `list` return promises.
- `Knowledge`, the read-only view agents get: `get` and `list` return
  promises. `SqliteKnowledgeStore.reader()` still returns a frozen object with
  only those two methods.
- `Router.route` returns `Promise<Route>`.
- `Channel.send` was already async.

**Kept synchronous and local:**

- `AuditSink`. A business write and its audit event must commit or roll back
  together, so `append` joins the caller's open SQLite transaction. An await
  inside a transaction would let other work interleave and could commit half
  of it, so `CompanyDb.transaction` refuses an async function outright.
- `SqliteKnowledgeStore.put`, the owner's write path. The document and its
  `knowledge.put` audit event commit in one transaction (it joins a caller's
  transaction when one is open).
- `CompanyDb` itself.

## Consequences

- Callers `await` memory, knowledge reads and routing. The SQLite defaults
  resolve at once, so the cost is a microtask.
- An external memory or knowledge product can be dropped in behind the same
  interface. Writes to company knowledge still go through the local owner path.
- An external audit product does not replace `AuditSink`; it mirrors it. A
  mirror reads new events in order with `query({ afterSeq, limit })`, starting
  from the last `seq` it holds, and can check each event's `prevHash` against
  the previous event's `hash` to confirm it received an unbroken chain. The
  local chain stays the record; `head()` is what M0-G anchors off-host.

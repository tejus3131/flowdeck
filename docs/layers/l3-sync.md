# L3 — Sync

The write path: the outbox engine plus the fold. Semantics locked by
ADR-6; only payload shapes move to entity keys (ADR-1).

## Owns

- The outbox: instant local apply → guards → server ACK → echo retirement
- Provisional remote ops (relayed by peers, TTL revert, silent drop)
- The fold (pure): planning and applying event batches to store drafts
- Guard keys: entity-scoped (`card:${id}`, `tag:${id}`), not
  snapshot-scoped
- The durable poll (realtime's silent-death fallback) and the sweep

## May not

- Know the UI: no components, no routes, no rendering concepts.
- Fetch join rows (that was the old `card-touch` pattern — L1 ships rows
  now).
- Trust a broadcast: relays are display hints; the database echo is the
  only retirement (the existing rule, kept).

## Rules

1. **The four rules of the engine stay**: local apply is
   never blocked; guards hold until echo; ACK is the server call's
   resolution; ops are independent.
2. **Solid 2 discipline stays** (the engine's own hard lessons): reads lag
   writes — retirement decisions read data from before any write; the
   store is written only from reactive effect contexts; async
   continuations request merges through signals; draft setters only.
3. **The fold stays pure** — every ordering edge unit-tested, not
   discovered in production.
4. **Ops are registered, not inlined**: the op registry (one per scope)
   is the vocabulary; a mutation outside it is a bug
   (performance-rules 8).
5. **Kept ops stay kept**: retiring an op kind orphans old clients that
   may still relay it in flight, and history replays it. Do not "clean
   up" op kinds.
6. **Guards are entity keys now**: an in-flight `update-card` guards
   `card:${id}` — incoming events for that entity wait; everything else
   applies. Finer-grained than the old snapshot guard, same semantics.

## Worked example — a card move, after

`move-card` op: apply to store draft (card entity + position), guard
`card:${id}`, send, ACK, echo retires. Peers get the relayed op as
provisional. The fold applies the durable echo. Nothing here knows a
board page exists.

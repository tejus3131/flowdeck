# L1 — Transport

Moves typed row events between the server and the store. Knows connections;
knows nothing about what the entities mean.

## Owns

- Scoped topics: **one board topic, one workspace topic per viewer**
  (ADR-3, Phase 4). New topics require an ADR — the connection budget is
  the constraint (Supabase free: 200 concurrent connections).
- Subscriptions, reconnection, the reconnect contract (first value
  current, never behind)
- Event decode: realtime payloads → typed `ChangeEvent`s
- The session-before-subscribe rule (the boardStream lesson: the session
  must be resident before the channel connects, or RLS silently filters
  everything to nothing)
- Loud failure: rejected bindings arrive as `system` errors after the join
  reply — log them (the hard-won lesson, kept)

## May not

- Know entity semantics: no "what a rename means", no view assembly, no
  fetching of join rows. It ships rows and deltas; L2/L3 interpret them.
- Create a topic per surface or per entity — that multiplies connections.

## Rules

1. **Ship rows, not triggers.** A `card_tags` change ships the join row; a
   `tags` change ships the row + patch. `card-touch` (a refetch) is the
   exception, not the mechanism.
2. **`resync` is a fallback** — visibility-shaping changes and the drift
   bound only. A one-row change that emits `resync` is a bug (the canonical
   test).
3. **Scope every subscription.** Unfiltered table subscriptions (the old
   `tags` handler) are review blockers.
4. **One connection per scope, reused** (performance-rules 4). Opening a
   panel subscribes to cached data; it never creates a channel.
5. **Every topic carries the revision** so clients can ask "what changed
   since N".
6. **The escape hatch is here** (ADR-10): when the connection ceiling
   bites, a Durable Objects hub replaces this layer's internals — nothing
   above L1 changes.

## Worked example — the tag rename, after

`tags` change (workspace-filtered) → decode →
`{entity:'tag', id, op:'update', patch:{name}}` → one broadcast on the
workspace topic. Every viewer's store applies it in the same frame. No
snapshot, no refetch, no resync.

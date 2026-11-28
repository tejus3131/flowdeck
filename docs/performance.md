# Performance architecture

Why Orbit feels slow, what we're building to fix it, and the order we're
building it in. Companion doc: [`performance-rules.md`](./performance-rules.md) —
the checklist every change must pass so we never drift back into the bad state.

Origin: board card **#45 — "application is slow, needs to be profiled and
optimised."**

## The diagnosis

Orbit already has the hard half of a fast architecture. The **write path**
(`src/lib/sync.ts`) is the same outbox design Linear uses: a user action
applies to the local view instantly, the server call's resolution is the ACK,
live-stream echoes retire the op, failures surface with the exact error. No
spinner on any mutation, edits feel instant, other viewers see provisional
predictions within milliseconds.

The **read path** undoes it. Every _opening_ in the app is a cold fetch:

- **Card timeline** — `getCardEvents` runs on every Settings-tab open
  (a server-function round trip: Worker → Supabase over HTTPS → back), then
  polls every 10 s. This is the "3+ seconds to open a card's timeline" on the
  card.
- **Board chat / card comments** — each panel open spins up a fresh
  `live()` producer: auth check → realtime channel subscribe → initial
  snapshot fetch. The subscribe alone costs hundreds of milliseconds before
  the first byte of data.
- **Board open** — `boardStream` runs `snapshot()`: six parallel Supabase
  queries (board, lists, cards + tags, activity head, access, stats) and
  re-runs them **for every connected viewer** on **every** change on the
  board (coalesced, but still a full re-snapshot, not a delta).
- **Notifications warm nothing.** A notification arrives pointing at card
  #45 — clicking it starts every fetch from zero.

There is **no client-side cache at all**. `localStorage` holds trivia (panel
width, seen stamps). Nothing about the data survives a navigation, a reload,
or a second open. The network is in the critical path of every open, and the
network is the slowest thing we own.

## The target (validated, not invented)

The same design keeps showing up in every fast collaboration product:

- **Linear** — the UI's database is IndexedDB in the browser. Queries go to a
  local store; the server is a sync target, not a source of truth. Writes
  mutate locally and sync in the background; the server pushes small deltas
  and each delta re-renders one cell.
- **Notion** — added a client-side SQLite cache (WASM, SharedWorker + OPFS)
  in front of the existing API. Page navigation got ~20% faster overall and
  28–33% faster for users far from their servers. They did _not_ rewrite the
  app — they added the cache layer.
- **Slack / Superhuman** — persistent push connection plus local stores; the
  client almost never fetches on open.

Orbit's plan is the same shape, built **around the sync engine we already
have** rather than adopting an off-the-shelf sync engine (Zero, PowerSync,
ElectricSQL, Triplit). Buying one would mean throwing away the custom write
path (outbox, guards, `client_op` temp ids) that already works, and bending
SolidStart to their client model. Extend, don't replace.

### The four layers

1. **Client cache (the 80% win).** Every read path gets an IndexedDB-backed
   cache: board snapshots, board chats, card comments, card timelines,
   workspace rosters. On open: paint from cache **instantly**, then
   revalidate in the background (stale-while-revalidate). A second open of
   anything costs ~0 ms. First open still fetches cold — the cache only
   helps after the data has been seen once, which is exactly the "3-second
   timeline" case: every open after the first is instant. Assets get the
   same posture: the service worker keeps a TTL/LRU-bounded
   stale-while-revalidate image cache (board card #51), so an avatar
   rendered in a dozen places loads once and a re-upload's new URL
   invalidates the old entry.
2. **Delta sync.** Live producers stop re-sending full snapshots. A client
   that holds revision N asks for "rows since N," and change notifications
   ship the changed rows, not a re-fetch of the world. This fixes both
   user-perceived latency (echoes land sooner) and server cost (which
   scales per-viewer today).

   **The revision is trustworthy now** (Phase 2a, migration `0032`):
   `board_revisions` is bumped by a database trigger, in the same
   transaction as every board-scoped change — deletions included, and
   regardless of which path wrote (server functions, MCP, direct SQL).
   The app-side `activity` log stays as the human-readable audit trail;
   it no longer powers the revision. Phase 2b folds realtime change
   events into a per-connection in-memory snapshot — no database work on
   the hot path — keeping the wire shape (and the sync engine's echo,
   guard and revert semantics) untouched. Wire-level delta payloads can
   follow later if profiling shows the wire matters; the expensive part
   (six queries × viewers × changes) is gone.

3. **Prefetch by journey.** Warm the cache where the user is _about_ to go:
   a notification arrives → its card, board and chats stream into the cache
   on `requestIdleCallback`; a board-grant arrives → the board snapshot
   loads in the background; the dashboard → the most recently used boards.
   Prefetch is always idle-time, always cancellable, never blocking.
4. **Bounded stores.** The cache is not "cache everything forever." It keeps
   what's open, what notifications point at, and the most recently used
   boards; everything else ages out (LRU + per-entity TTL). Heavy streams
   cache only their latest page (chats: 100, comments: 30 — extend on
   demand), the same "data-level code splitting" Linear uses for its heavy
   tables. `navigator.storage.persist()` is requested so the browser doesn't
   evict us under pressure.

The write path stays exactly as it is. The sync engine already gives
optimistic mutations; the cache completes the picture on the read side.

## Phases

Each phase lands as its own PR, each leaves the app fully working.

| Phase | What                                                                                                                                                                                                     | Status       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 0     | **Profiling** — perf marks on every slow open path (board, chats, timeline, comments), a `?perf=1` debug panel with p50/p95 per label, server-side slow-path logs                                        | in flight    |
| 1     | **Cache layer** — IndexedDB store + stale-while-revalidate hydration for board snapshots, chats, comments, timelines                                                                                     | in flight    |
| 2     | **Delta sync** — 2a: trustworthy revision (`board_revisions`, migration 0032) ✓ · 2b: realtime events fold into the per-connection snapshot instead of full re-queries (engine and wire shape unchanged) | 2b in flight |
| 3     | **Prefetch by journey** — notification-driven and grant-driven cache warming                                                                                                                             | in flight    |
| 4     | **Idle refresh + eviction** — TTL/LRU background refresh so cached data stays fresh without user action                                                                                                  | planned      |

## Budgets

"Fast" needs numbers, and the perf marks (Phase 0) measure them. Targets:

| Path                                              | Budget       |
| ------------------------------------------------- | ------------ |
| Warm open of any cached view (paint from cache)   | ≤ 100 ms     |
| Warm open to interactive (composer usable)        | ≤ 200 ms     |
| Cold open of a panel (first visit, cache empty)   | ≤ 1.5 s p95  |
| Local mutation → visible to another viewer (echo) | ≤ 500 ms p95 |
| Delta apply (revalidate) on an open view          | ≤ 300 ms p95 |

Cold opens are bounded by physics (browser → Worker → Supabase and back);
the budget above is honest about that. Everything the user does a second
time must be instant — that is the rule, and the cache is how we keep it.

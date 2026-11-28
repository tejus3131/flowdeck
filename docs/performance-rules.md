# Performance rules

The checklist that keeps Orbit fast. The architecture landed once
([`performance.md`](./performance.md)); these rules are how it _stays_
landed. They apply to every change that touches data or UI — bug fixes,
features, revamps. A PR that breaks one of these is why we're slow again.

> The layer contracts in [`architecture.md`](./architecture.md) +
> [`layers/`](./layers/) are the structural rules; this file is the speed
> rules. A PR must pass both.

## Adding a new data stream or view

A "data stream" is anything the UI opens and shows: a panel, a tab, a list,
a drawer, a page backed by rows. Five rules, in order of how you'll hit them:

1. **No cold fetch on open.** The view reads from the local cache first and
   paints immediately; the network only _revalidates_. A new entity type
   ships with its cache schema entry in the same PR — there is no such thing
   as "cache it later." The only permitted cold state is the genuine
   first-ever open.

2. **Every stream carries a revision.** If the stream is live, it must be
   resumable: a monotonic cursor the client can present to ask "what changed
   since N." The cursor must be **transactional with the change it
   describes** — recorded in the same commit, so a resume from N can never
   miss a committed change. (The board's revision —
   `BoardSnapshot.revision`, backed by `board_revisions` — is the working
   example: a database trigger bumps it in the same transaction as every
   board-scoped change, deletions included. The lesson: cursors live in the
   database beside the data, not in best-effort app writes.) Streams
   without a cursor can only ever be served as full re-fetches, and full
   re-fetches are the thing we're removing.

3. **Push deltas, not snapshots.** A change notification ships the changed
   rows. Re-fetching an entire board because one card moved is a bug — it
   multiplies by viewers. The full snapshot is a cold-start and
   reconciliation fallback, never the steady-state update path.

4. **One live connection per scope, reused.** Don't spin a new producer per
   open. Producers bind to the board (or workspace) session and write
   through to the cache; opening a panel means subscribing to cached data,
   not creating a channel.

5. **Add a perf mark with a budget.** Every open path gets a `perfStart`/
   `perfEnd` mark and a line in the budgets table. If the debug panel
   (`?perf=1`) can't show your path, your path isn't measured, and unmeasured
   paths rot.

## UI work and revamps

6. **A spinner on a warm open is a bug.** Skeletons are allowed only on the
   genuine cold path (cache empty). If a view that has been opened before
   shows a loading state, the PR is wrong — even if it "looks fine."

7. **Measure before and after.** A PR that touches how a view loads includes
   before/after numbers from the perf panel (p50/p95 for its label) in the
   description. "Feels faster" is not a number.

8. **Mutations go through the sync engine.** Optimistic apply, guards, echo
   retirement — the sync engine, never a direct fetch-then-setState
   mutation; that re-adds the spinner the engine removed.

9. **Code-split panels, don't append to the route.** A route is a wiring
   file; new UI becomes its own module (and its own lazy chunk when it's
   heavy). Bundle size is a first-load budget, and first load is the one
   thing the cache can't help.

10. **Unbounded lists virtualize.** Anything that can grow without limit
    (chat histories, timelines, card lists) renders a window, not the world.
    Pagination cursors exist on the server side already — keep using them.

## Cache hygiene

11. **The cache is bounded.** New entities get: an LRU rank (what's evicted
    first), a TTL (when a background refresh is due), and a decision about
    which page of the stream they cache (latest page by default). "Cache
    everything forever" is how browsers evict us entirely under storage
    pressure.

12. **Cache what the user is about to see.** Prefetch lives in the journey
    map: notifications warm their target, grants warm the granted board, the
    dashboard warms recent boards. New notification kinds and new grant types
    register their prefetch in the same PR.

13. **Never block user work for cache work.** All warming/refresh happens
    idle-time (`requestIdleCallback`), is cancellable, and never competes
    with a user-triggered fetch for the same data.

## The one-sentence version

**Nothing the user opens should wait on the network unless it's the very
first time they've ever opened it — and if you add a new way to open data,
it follows the same rule, with a mark proving it.**

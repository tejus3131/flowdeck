# L2 — Store

The client's database: one reference per entity, views derived from it.

## Owns

- The normalized entity store: `entities[type][id]` — cards, lists, tags,
  members, teams, boards, join rows (`card_tags`, `card_assignees`),
  counters
- Selectors: memoized reads (`tagById`, `cardsOfBoard`, `membersOf`) — the
  only way views see data
- The IndexedDB cache, re-keyed per entity (ADR-2): same LRU/TTL posture as
  `cache.ts` today, same "never blocks the open" rules
- Hydration: stale-while-revalidate at the entity level — paint from
  cache, revalidate in the background
- Revision cursors per scope (what the store has applied)

## May not

- Fetch. Network is L1/L4's job; the store receives values, it never
  requests them.
- Touch the DOM or know about components.
- Hold view-shaped blobs (the old `ws-detail:${id}` keys) — that's the
  double-caching this layer exists to remove.

## Rules

1. **One reference.** An entity is written once; every surface reads the
   same entry by id. If two stores can hold the same card, the design is
   wrong.
2. **Writes come from exactly two places**: L1 event decode and L3 merge
   paths. Nothing else writes the store.
3. **Selectors are cheap.** Memoized, keyed by id; a selector that walks
   the whole store per read is a bug.
4. **Join rows are entities.** `card_tags` lives in the store as its own
   entry; a card's chips are derived (card → joins → tags), never embedded
   (the denormalization that caused the rename storm).
5. **Cache keys are `type:id`** with an LRU rank and TTL decided in the
   same PR as the entity (performance-rules 11). Stream pages stay
   bounded (chat: 100, comments: 30).
6. **Cache is user-scoped** (the `cacheSetUser` rule: another account's
   entries are unreachable).
7. **Never block user work for cache work** (performance-rules 13).

## Worked example — the tag rename, after

L1 delivers the event → store writes `tags[id].name = 'new'` → every
selector reading that tag re-evaluates → every chip, feed row, and timeline
line re-renders in the same frame. The `<For>`-rebuild memo hack (the old
`timelineRows`) is deleted — selectors make it unnecessary.

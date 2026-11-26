# UI data wiring — how a view reads the store and stays live

The how-to between the contracts: [`layers/l2-store.md`](./layers/l2-store.md)
(what the store owns) and [`layers/l5-views.md`](./layers/l5-views.md) (what a
view may do). Read both first. Every snippet here is illustrative and
self-contained — nothing in this doc points at a source file, because source
files change; the rules don't.

The failure mode this doc prevents is easy to recognize in a running app:
**one surface shows a change instantly while another surface shows it seconds
later, or only after a reload.** That split is never a rendering problem — it
means two surfaces read two copies of the same entity, and only one copy got
the update. Everything below exists to make that impossible.

The rule underneath it all:

> **A name lives in exactly one place — the store.** A view resolves it by
> id through a selector, at render time. If a component's data arrives as a
> copy, a change to the entity never reaches it, and the canonical test
> fails ("a one-row change updates every surface in one frame").

## Rule 1 — components read the store by id, never a props-threaded slice

The store's selectors are the only data API a component has (an entity's
`byId` selector, a scope's list selector — see L2). A workspace or board
detail slice passed down as a prop is a snapshot of the moment its stream
emitted — an entity change elsewhere lands in the store instantly but never
in that prop until a full re-snapshot, seconds or never.

**Banned shapes** (each is a real staleness bug waiting to ship):

```tsx
// a slice threaded as a prop — frozen at the re-snapshot that delivered it
const tag = props.tags.find((t) => t.id === id);
const member = props.members.find((m) => m.userId === id);
const name = detail()?.tags.find((t) => t.name === label);
// a markdown context built from a prop slice
{
  tags: props.tags;
} // every chip inside re-renders only on re-snapshot
```

**Right shape** — resolve by id at render time:

```tsx
const entities = useEntities(); // the store, via context
const name = () => entities.tagById(props.tagId)?.name ?? props.fallbackName ?? 'tag';
```

A prop may carry **ids and fallback text** (see rule 4). It may never carry
the vocabulary itself as the source of truth for names.

## Rule 2 — markdown contexts are built from selectors

Rich text (descriptions, comments, chat) renders through a context of
resolvable entities (members, tags, boards, cards). Build that context from
store reads so a rename re-renders the HTML with zero refetch (L5 rule 2).
The id list may come from a snapshot; the names must not:

```tsx
const markdownContext = () => ({
  // …
  tags: props.tagIds.map((id) => ({ id, name: entities.tagById(id)?.name })),
});
```

Reading the name inside the context is what tracks the store write. If
chips in rendered rich text stop updating live, a snapshot copy crept back
in.

## Rule 3 — name lookups go in tracked scopes, not plain helpers in flow callbacks

`<For>`/`<Show>`/`<Match>` children are owners, not tracking scopes. A plain
helper function called inside a list row's JSX can render once per row and
never again — its store reads never re-run, so renamed entities keep their
old names in that row forever. Two proven patterns:

1. **A component with an internal memo** — the chip resolves
   `entities.tagById(props.tagId)?.name` in a memo inside the component; the
   component re-renders when the store write lands. Prefer this for anything
   rendered per-row (timeline lines, chat chips, search hits).
2. **A re-slice memo derived from store reads** — the list's rows are
   rebuilt when a tracked name changes:

```tsx
const rows = createMemo(() => {
  void props.tagIds.map((id) => entities.tagById(id)?.name).join('|');
  return events().slice();
});
```

Never key a re-slice on `array.length` — a rename does not change the
length; it changes the names. A length-keyed rebuild silently never fires
for the exact case it exists for.

## Rule 4 — the presentational fallback (when a row carries an old name)

Event rows and serialized chips carry `{id, name}` snapshots written when
the event happened. Resolution is always: **store name first, snapshot name
as fallback** — never the reverse. The snapshot fallback covers rows that
arrived before the entity was ingested; once the store has the row, the
store wins forever.

```tsx
const label = entities.tagById(item.id)?.name ?? item.name ?? 'tag';
```

## Adding an entity to the store

New UI must never read a snapshot slice — so if the entity it needs is not
in the store yet, the store change lands FIRST, as its own data-layer PR,
before the UI that reads it. Per entity:

1. **Type + state entry** in the store, keyed by id.
2. **Identity-stable write path**: a merge that keeps unchanged rows'
   object identity and writes only changed rows. This is load-bearing —
   poll re-ingests and re-snapshots must not churn references, or every
   selector downstream re-runs for nothing.
3. **Ingest sites**: every durable emission that carries the entity feeds
   the write path (durable snapshots and typed row events). Two write
   sources max — L1 decode and L3 merge (L2 rule 2).
4. **Selectors**: `byId` and the scoped list (`membersOfWorkspace`,
   `teamsOfBoard`…), memoized, keyed by id (L2 rule 3).
5. **Cache key** `type:id` with LRU rank + TTL decided in the same PR
   (L2 rule 5, performance-rules 11).
6. **Convert the surfaces** that read the old slices, citing this doc, and
   delete the now-dead prop threading.
7. **Proof**: rename the entity in one tab and watch every surface update
   in one frame — the canonical test, run by hand before the PR.

## Self-check before every UI PR

```bash
# snapshot-copy reads — review every hit; only event handlers and
# rule-4 fallbacks are acceptable
rg -n "props\.(tags|members|teams|crossCards)\.(find|filter|some|map)" src/components src/routes
rg -n "detail\(\)?\.(tags|members|teams)\.(find|filter|some)" src/routes src/components
```

Then run the canonical test by hand: change one row (rename a tag, a member,
a team), and confirm every surface that shows it updates in the same frame —
no spinner, no refetch, no stale chip.

This checklist is also step 4 of the PR prep skill
(`.agents/skills/pr-prep/SKILL.md`) — a UI PR that skips it comes back.

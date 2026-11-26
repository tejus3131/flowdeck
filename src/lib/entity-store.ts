// The L2 entity store — Phase 1 of docs/architecture.md (ADR-1, ADR-2).
// One reference per thing: a tag's name lives in exactly one place,
// `tags[id]`, and every surface reads it through a selector. A rename is
// one store write; every chip, the tag hub, and the per-tag page
// re-render in the same frame — the canonical test.
//
// Writes come from exactly two places (L2 rule 2): the sync engine's
// merge pass (the `ingest` option normalizes a durable snapshot into
// entities — the L1 decode of Phase 1's snapshot deliveries) and, later,
// typed row events. Nothing else writes the store. Views never write it.
//
// Scope of Phase 1: tags and the `card_tags` join rows. Other entities
// (cards, members, boards…) join the same store in later phases; the
// shape below is the pattern they follow.
//
// Per-entity cache (ADR-2): every tag row write-throughs to the cache as
// `tag:${id}` — the vocabulary is tiny, stable, and shared by every
// surface, so it earns the cache's global LRU/TTL posture. Join-row links
// stay memory-only for now: no Phase 1 surface reads them before a
// snapshot lands, and caching without a reader is speculation.
import { createContext, createStore, useContext } from 'solid-js';

import { cachePut } from './cache';
import type { BoardSnapshot } from './boards';
import type { WorkspaceDetail } from './workspaces';

/** A tag row — the workspace's shared vocabulary. Names are the mutable
 * part (a rename keeps every `tag:<uuid>` chip link alive); tags are
 * never deleted (serialized chips would dangle). */
export type TagEntity = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
};

/** A `card_tags` join row — an entity in its own right (L2 rule 4): a
 * card's chips derive card → links → tags, never embedded names. */
export type CardTagLink = { card_id: string; tag_id: string };

/** What a snapshot can tell us about a tag. The vocabulary snapshot
 * carries the full row; a card's chips carry id + name only. */
export type TagRow = { id: string; name: string; description?: string | null };

type State = {
  /** tag id → row. The one place a tag's name lives. */
  tags: Record<string, TagEntity>;
  /** card id → tag id → join row. */
  cardTags: Record<string, Record<string, CardTagLink>>;
  /** workspace id → tag id → true. An id index, not a copy of the rows;
   * `tagsOfWorkspace` resolves and sorts at read time, so a rename
   * re-sorts without touching the index. */
  workspaceTagIds: Record<string, Record<string, true>>;
};

/** Cache key for a tag row (ADR-2's `type:id` keys). */
const tagKey = (id: string) => `tag:${id}`;

export type EntityStore = {
  // ── writes (L1 decode / L3 merge paths only — never a view) ─────────
  /** Upsert tag rows for one workspace. Partial rows (id + name) fill
   * gaps in what richer snapshots delivered and never clobber it.
   * `rebuild: true` (a full vocabulary snapshot) re-indexes the
   * workspace's id set — entries that vanished from the snapshot drop
   * out of `tagsOfWorkspace` (the rows stay: another board's cards may
   * still link them). */
  writeTags: (workspaceId: string, rows: TagRow[], options?: { rebuild?: boolean }) => void;
  /** Replace one card's link set (the join rows are keyed by card — a
   * snapshot is authoritative for the cards it carries). */
  writeCardTagLinks: (cardId: string, tagIds: string[]) => void;
  /** Drop every entity — the sign-out / account-switch path; the store
   * is user-scoped exactly like the cache (L2 rule 6). */
  clear: () => void;

  // ── selectors (the only way views see data) ─────────────────────────
  tagById: (id: string) => TagEntity | undefined;
  /** The card's tags, name-sorted. Derived card → links → tags. */
  tagsOfCard: (cardId: string) => TagEntity[];
  /** The workspace's vocabulary, name-sorted. */
  tagsOfWorkspace: (workspaceId: string) => TagEntity[];

  // ── snapshot normalizers (the engine's `ingest` glue) ───────────────
  /** A durable board snapshot: the cards' chips carry the tags they
   * link, and the chips ARE the join rows — ingest entities + links. */
  ingestBoardSnapshot: (snapshot: BoardSnapshot) => void;
  /** A durable workspace detail: the full tag vocabulary, re-indexed. */
  ingestWorkspaceDetail: (detail: WorkspaceDetail) => void;
};

export function createEntityStore(): EntityStore {
  const [state, setState] = createStore<State>({ tags: {}, cardTags: {}, workspaceTagIds: {} });

  const writeTags: EntityStore['writeTags'] = (workspaceId, rows, options) => {
    // Merge first (reads before writes): decide the entities that land,
    // keeping unchanged rows' identity stable — a re-ingested snapshot
    // must not churn references for every selector watching it. `changed`
    // carries only the rows that differ: the cache write-through skips
    // unchanged rows, so a poll's re-ingest rewrites nothing.
    const merged: TagEntity[] = [];
    const changed: TagEntity[] = [];
    for (const row of rows) {
      const existing = state.tags[row.id];
      const description = row.description ?? null;
      if (existing) {
        const nextName = row.name;
        const nextDescription = description !== null ? description : existing.description;
        const nextWorkspace = workspaceId || existing.workspace_id;
        if (
          existing.name === nextName &&
          existing.description === nextDescription &&
          existing.workspace_id === nextWorkspace
        ) {
          merged.push(existing);
          continue;
        }
        const next: TagEntity = {
          id: row.id,
          workspace_id: nextWorkspace,
          name: nextName,
          description: nextDescription,
        };
        merged.push(next);
        changed.push(next);
      } else {
        const next: TagEntity = {
          id: row.id,
          workspace_id: workspaceId,
          name: row.name,
          description: description ?? '',
        };
        merged.push(next);
        changed.push(next);
      }
    }
    setState((draft) => {
      for (const entity of merged) draft.tags[entity.id] = entity;
      // The id index is per-workspace; boards without a workspace still
      // deliver tag entities (chips resolve by id) but don't index one.
      if (!workspaceId) return;
      const ids: Record<string, true> = options?.rebuild
        ? {}
        : { ...draft.workspaceTagIds[workspaceId] };
      for (const entity of merged) ids[entity.id] = true;
      draft.workspaceTagIds[workspaceId] = ids;
    });
    // Cache write-through, fire-and-forget (never blocks the write) —
    // and only for rows that actually changed: the poll re-ingests the
    // whole vocabulary every cycle, and rewriting identical rows would
    // churn IndexedDB (and refresh LRU clocks) for nothing.
    for (const entity of changed) cachePut(tagKey(entity.id), entity);
  };

  const writeCardTagLinks: EntityStore['writeCardTagLinks'] = (cardId, tagIds) => {
    setState((draft) => {
      const current = draft.cardTags[cardId];
      const same =
        current !== undefined &&
        Object.keys(current).length === tagIds.length &&
        tagIds.every((tagId) => current[tagId] !== undefined);
      if (same) return; // identity-stable: no write, no churn
      const next: Record<string, CardTagLink> = {};
      for (const tagId of tagIds) next[tagId] = { card_id: cardId, tag_id: tagId };
      draft.cardTags[cardId] = next;
    });
  };

  const clear: EntityStore['clear'] = () => {
    setState((draft) => {
      draft.tags = {};
      draft.cardTags = {};
      draft.workspaceTagIds = {};
    });
  };

  const tagById: EntityStore['tagById'] = (id) => state.tags[id];

  const tagsOfCard: EntityStore['tagsOfCard'] = (cardId) => {
    const links = state.cardTags[cardId];
    if (!links) return [];
    const out: TagEntity[] = [];
    for (const tagId of Object.keys(links)) {
      const tag = state.tags[tagId];
      if (tag) out.push(tag);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };

  const tagsOfWorkspace: EntityStore['tagsOfWorkspace'] = (workspaceId) => {
    const ids = state.workspaceTagIds[workspaceId];
    if (!ids) return [];
    const out: TagEntity[] = [];
    for (const id of Object.keys(ids)) {
      const tag = state.tags[id];
      if (tag) out.push(tag);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };

  const ingestBoardSnapshot: EntityStore['ingestBoardSnapshot'] = (snapshot) => {
    const workspaceId = snapshot.board.workspace_id ?? '';
    const tagRows = new Map<string, TagRow>();
    for (const card of snapshot.cards) {
      for (const tag of card.tags) tagRows.set(tag.id, tag);
      writeCardTagLinks(
        card.id,
        card.tags.map((tag) => tag.id),
      );
    }
    if (tagRows.size > 0) writeTags(workspaceId, [...tagRows.values()]);
  };

  const ingestWorkspaceDetail: EntityStore['ingestWorkspaceDetail'] = (detail) => {
    if (!detail.workspace.id) return;
    writeTags(detail.workspace.id, detail.tags, { rebuild: true });
  };

  return {
    writeTags,
    writeCardTagLinks,
    clear,
    tagById,
    tagsOfCard,
    tagsOfWorkspace,
    ingestBoardSnapshot,
    ingestWorkspaceDetail,
  };
}

// ── the app-wide instance ──────────────────────────────────────────────

/**
 * The entity store rides Solid context: created once per app on the
 * client, once per request on the server (module state would leak
 * across requests — the store is user-scoped, L2 rule 6). App wraps its
 * tree in `<EntityContext value={…}>`; components read it with
 * `useEntities()`.
 */
export const EntityContext = createContext<EntityStore>();

/** The store for the current tree. Throws when the provider is missing —
 * a view reading selectors outside the app's store is a wiring bug, and
 * a silent empty store would render chips without names. */
export function useEntities(): EntityStore {
  const store = useContext(EntityContext);
  if (!store) throw new Error('EntityContext is missing — wrap the app in <EntityContext value>');
  return store;
}

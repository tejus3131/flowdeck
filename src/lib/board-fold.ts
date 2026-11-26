// The board fold — Phase 2b of docs/performance.md.
//
// Realtime events used to trigger a full 6-query re-snapshot of the
// board, per viewer, per change (the snapshot storm). The fold instead
// keeps the per-connection snapshot in memory and applies each debounced
// batch of change events directly: no database work on the hot path,
// echoes land in the debounce window instead of after a re-query.
//
// This module is PURE — it plans a batch and folds it into a snapshot
// draft; the fetching of fresh CardViews for touched cards (their join
// rows — tags, assignees, comment stats — ride the view, not the event
// payload) lives in the stream. Kept pure so every ordering edge here is
// unit-tested, not discovered in production.
//
// Convergence (the four safety nets): resync events fold to a full
// re-snapshot; the stream periodically re-syncs (see boardStream); the
// client engine's durable poll re-fetches every 20s regardless; and every
// reconnect starts from a fresh full snapshot.
import type { BoardSummary, BoardSnapshot, CardView, ListRow } from './boards';

/** One realtime event, narrowed to what the fold needs. The stream's
 *  channel handlers translate postgres_changes payloads into these. */
export type TagRow = { id: string; name: string; description?: string | null };

export type FoldEvent =
  /** boards UPDATE — the flat row is complete, apply directly. */
  | { kind: 'board-row'; row: BoardSummary }
  /** lists INSERT/UPDATE — flat rows are complete, apply directly. */
  | { kind: 'list-upsert'; row: ListRow }
  /** lists DELETE — by old id. */
  | { kind: 'list-delete'; id: string }
  /** cards INSERT/UPDATE, or a card-side row change (tags, assignees,
   *  comment stats): the card needs a fresh CardView fetch. */
  | { kind: 'card-touch'; id: string }
  /** cards DELETE — by old id. */
  | { kind: 'card-delete'; id: string }
  /** tags INSERT/UPDATE (workspace-scoped; tags are never deleted — the
   *  0067 trigger): the vocabulary row itself. A rename folds into the
   *  cards' embedded chips in memory — no re-snapshot (ADR-3: the old
   *  `resync` on any tags change is gone). */
  | { kind: 'tag-upsert'; row: TagRow }
  /** board_revisions UPDATE — the exact server cursor (migration 0032). */
  | { kind: 'revision'; value: number }
  /** A visibility-shaping change (board_access, board_team_access, team
   *  members, the tag vocabulary): only a full re-snapshot is correct. */
  | { kind: 'resync' };

/** A debounced burst, planned: what the fold does with it. */
export type FoldPlan = {
  boardRow: BoardSummary | null;
  listUpserts: ListRow[];
  listDeletes: Set<string>;
  /** Cards needing a fresh CardView (fetch, then fold). */
  cardTouches: Set<string>;
  cardDeletes: Set<string>;
  /** The vocabulary rows the burst carried, id → last event wins. */
  tagUpserts: Map<string, TagRow>;
  /** The exact server revision when ≥ 0; -1 = no revision event arrived. */
  revision: number;
  /** True when only a full re-snapshot answers the burst. */
  resync: boolean;
};

/** Plan a batch: dedupe touches against deletes, keep the max revision.
 *  Order within the batch does not matter — upserts key by id, deletes
 *  win over touches. */
export function planFold(events: FoldEvent[]): FoldPlan {
  const plan: FoldPlan = {
    boardRow: null,
    listUpserts: [],
    listDeletes: new Set(),
    cardTouches: new Set(),
    cardDeletes: new Set(),
    tagUpserts: new Map(),
    revision: -1,
    resync: false,
  };
  for (const event of events) {
    switch (event.kind) {
      case 'board-row':
        plan.boardRow = event.row;
        break;
      case 'list-upsert':
        plan.listUpserts.push(event.row);
        break;
      case 'list-delete':
        plan.listDeletes.add(event.id);
        break;
      case 'card-touch':
        plan.cardTouches.add(event.id);
        break;
      case 'card-delete':
        plan.cardDeletes.add(event.id);
        break;
      case 'tag-upsert':
        plan.tagUpserts.set(event.row.id, event.row);
        break;
      case 'revision':
        plan.revision = Math.max(plan.revision, event.value);
        break;
      case 'resync':
        plan.resync = true;
        break;
    }
  }
  // A card deleted in the same burst as its change: the delete wins —
  // nothing is fetched or kept for it.
  for (const id of plan.cardDeletes) plan.cardTouches.delete(id);
  return plan;
}

/** The cards' sort order: the board's list order, then position — the
 *  same order mergeBoardSnapshot keeps the view in. */
function sortCards(draft: BoardSnapshot): void {
  const listIndex = new Map(draft.lists.map((list, index) => [list.id, index]));
  draft.cards.sort(
    (a, b) =>
      (listIndex.get(a.list_id) ?? 0) - (listIndex.get(b.list_id) ?? 0) || a.position - b.position,
  );
}

/**
 * Fold a plan into the snapshot draft, in place, together with the fresh
 * CardViews fetched for the plan's touches. Returns true when the caller
 * must full-resync (a visibility-shaping event came in — the draft is
 * left untouched in that case).
 *
 * `views` legitimately misses touched ids (an event for another board's
 * card on the unfiltered card-side channels, or a card created and deleted
 * within the same debounce window): those are skipped — the periodic
 * re-sync and the client's durable poll bound any drift from missed
 * events.
 */
export function applyFold(draft: BoardSnapshot, plan: FoldPlan, views: CardView[]): boolean {
  if (plan.resync) return true;

  if (plan.boardRow) {
    // Content-stable like the engine's merge: an unchanged board row
    // keeps its identity; a changed one lands as a copy.
    if (JSON.stringify(draft.board) !== JSON.stringify(plan.boardRow)) {
      draft.board = { ...plan.boardRow };
    }
  }

  if (plan.listDeletes.size > 0 || plan.listUpserts.length > 0) {
    const byId = new Map(
      draft.lists.filter((list) => !plan.listDeletes.has(list.id)).map((list) => [list.id, list]),
    );
    for (const row of plan.listUpserts) byId.set(row.id, row);
    draft.lists = [...byId.values()].sort((a, b) => a.position - b.position);
  }

  // A deleted list takes its cards with it (the cascade's card-delete
  // events may or may not ride the same burst — either way they're gone).
  if (plan.listDeletes.size > 0) {
    draft.cards = draft.cards.filter((card) => !plan.listDeletes.has(card.list_id));
  }

  if (plan.cardDeletes.size > 0 || views.length > 0) {
    const cards = draft.cards.filter((card) => !plan.cardDeletes.has(card.id));
    const byId = new Map(cards.map((card) => [card.id, card]));
    for (const view of views) byId.set(view.id, view);
    draft.cards = [...byId.values()];
  }

  // The vocabulary rows: rewrite the embedded chip names in place — a
  // rename is memory work only, the burst costs zero queries (ADR-3).
  // Chips stay name-sorted; a rename can reorder them.
  if (plan.tagUpserts.size > 0) {
    for (const card of draft.cards) {
      let renamed = false;
      for (const tag of card.tags) {
        const upsert = plan.tagUpserts.get(tag.id);
        if (upsert && tag.name !== upsert.name) {
          tag.name = upsert.name;
          renamed = true;
        }
      }
      if (renamed) card.tags.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  if (
    plan.listDeletes.size > 0 ||
    plan.listUpserts.length > 0 ||
    plan.cardDeletes.size > 0 ||
    views.length > 0
  ) {
    sortCards(draft);
  }

  if (plan.revision >= 0 && plan.revision !== draft.revision) {
    draft.revision = plan.revision;
  }
  return false;
}

// Board fold tests — Phase 2b's hot path: realtime events folded into the
// per-connection snapshot without a database round trip. Every ordering
// and dedup edge that used to be "whatever the re-query said" is now a
// decision made HERE, so each one is pinned: deletes win over touches,
// list deletes take their cards, cards resort into list order, resync
// events hand back to a full snapshot.
import { describe, expect, it } from 'vitest';

import { applyFold, planFold, type FoldEvent } from './board-fold';
import type { BoardSnapshot, CardView, ListRow } from './boards';

// ── fixtures ─────────────────────────────────────────────────────────────

const list = (id: string, position: number): ListRow => ({
  id,
  board_id: 'b1',
  name: `list ${id}`,
  position,
  created_at: '',
  client_op: null,
  description: '',
});

const card = (id: string, listId: string, position: number, title = id): CardView => ({
  id,
  board_id: 'b1',
  list_id: listId,
  title,
  description: '',
  position,
  number: 1,
  priority: null,
  created_by: 'u1',
  created_at: '',
  updated_at: '',
  client_op: null,
  comment_count: 0,
  last_comment_at: null,
  assignees: [],
  tags: [],
});

const snapshot = (lists: ListRow[], cards: CardView[]): BoardSnapshot => ({
  board: {
    id: 'b1',
    name: 'Board',
    description: '',
    owner_id: 'u1',
    workspace_id: null,
    created_at: '',
    updated_at: '',
    client_op: null,
    access_delegation: false,
  },
  lists,
  cards,
  revision: 10,
  myAccess: 'edit',
  denied: false,
});

const fold = (draft: BoardSnapshot, events: FoldEvent[], views: CardView[] = []): boolean =>
  applyFold(draft, planFold(events), views);

// ── planFold ────────────────────────────────────────────────────────────

describe('planFold', () => {
  it('routes each event kind into its bucket', () => {
    const plan = planFold([
      { kind: 'board-row', row: {} as never },
      { kind: 'list-upsert', row: list('l9', 9) },
      { kind: 'list-delete', id: 'l1' },
      { kind: 'card-touch', id: 'c1' },
      { kind: 'card-delete', id: 'c2' },
      { kind: 'revision', value: 42 },
      { kind: 'resync' },
    ]);
    expect(plan.boardRow).toEqual({} as never);
    expect(plan.listUpserts.map((row) => row.id)).toEqual(['l9']);
    expect(plan.listDeletes).toEqual(new Set(['l1']));
    expect(plan.cardTouches).toEqual(new Set(['c1']));
    expect(plan.cardDeletes).toEqual(new Set(['c2']));
    expect(plan.revision).toBe(42);
    expect(plan.resync).toBe(true);
  });

  it('keeps the MAX revision of a burst', () => {
    const plan = planFold([
      { kind: 'revision', value: 12 },
      { kind: 'revision', value: 15 },
      { kind: 'revision', value: 13 },
    ]);
    expect(plan.revision).toBe(15);
  });

  it('lets a delete win over a touch in the same burst (no fetch for it)', () => {
    const plan = planFold([
      { kind: 'card-touch', id: 'c1' },
      { kind: 'card-delete', id: 'c1' },
      { kind: 'card-touch', id: 'c2' },
    ]);
    expect(plan.cardTouches).toEqual(new Set(['c2']));
    expect(plan.cardDeletes).toEqual(new Set(['c1']));
  });

  it('defaults revision to -1 when the burst carries none', () => {
    expect(planFold([{ kind: 'card-touch', id: 'c1' }]).revision).toBe(-1);
  });
});

// ── applyFold ────────────────────────────────────────────────────────────

describe('applyFold', () => {
  it('upserts lists (new and replaced) and sorts by position', () => {
    const draft = snapshot([list('l1', 1), list('l2', 2)], []);
    fold(draft, [
      { kind: 'list-upsert', row: { ...list('l1', 1), name: 'renamed' } },
      { kind: 'list-upsert', row: list('l0', 0) },
    ]);
    expect(draft.lists.map((row) => row.id)).toEqual(['l0', 'l1', 'l2']);
    expect(draft.lists[1]!.name).toBe('renamed');
  });

  it('a list delete removes the list AND its cards', () => {
    const draft = snapshot(
      [list('l1', 1), list('l2', 2)],
      [card('c1', 'l1', 1), card('c2', 'l2', 1)],
    );
    fold(draft, [{ kind: 'list-delete', id: 'l1' }]);
    expect(draft.lists.map((row) => row.id)).toEqual(['l2']);
    expect(draft.cards.map((row) => row.id)).toEqual(['c2']);
  });

  it('upserts card views (replacing by id, inserting new) into list order', () => {
    const draft = snapshot(
      [list('l1', 1), list('l2', 2)],
      [card('c1', 'l1', 1), card('c2', 'l2', 1)],
    );
    fold(
      draft,
      [{ kind: 'card-touch', id: 'c1' }, { kind: 'card-touch', id: 'c3' }],
      [card('c1', 'l2', 2, 'moved'), card('c3', 'l1', 0, 'new')],
    );
    // List order first (l1 before l2), position within the list: c3 (l1),
    // then l2's cards by position — c2 (pos 1) before the moved c1 (pos 2).
    expect(draft.cards.map((row) => row.id)).toEqual(['c3', 'c2', 'c1']);
    expect(draft.cards[2]!.list_id).toBe('l2');
  });

  it('deletes cards by id', () => {
    const draft = snapshot([list('l1', 1)], [card('c1', 'l1', 1), card('c2', 'l1', 2)]);
    fold(draft, [{ kind: 'card-delete', id: 'c1' }]);
    expect(draft.cards.map((row) => row.id)).toEqual(['c2']);
  });

  it('swaps the board row only when its content changed (identity-stable)', () => {
    const draft = snapshot([list('l1', 1)], []);
    const before = draft.board;
    fold(draft, [{ kind: 'board-row', row: { ...draft.board } }]);
    expect(draft.board).toBe(before); // identical — same object
    fold(draft, [{ kind: 'board-row', row: { ...draft.board, name: 'Renamed' } }]);
    expect(draft.board.name).toBe('Renamed');
    expect(draft.board).not.toBe(before);
  });

  it('applies the exact revision from the burst', () => {
    const draft = snapshot([list('l1', 1)], []);
    fold(draft, [{ kind: 'revision', value: 99 }]);
    expect(draft.revision).toBe(99);
  });

  it('returns true on a resync event, leaving the draft untouched', () => {
    const draft = snapshot([list('l1', 1)], [card('c1', 'l1', 1)]);
    const frozen: BoardSnapshot = JSON.parse(JSON.stringify(draft));
    const resync = fold(draft, [{ kind: 'card-delete', id: 'c1' }, { kind: 'resync' }], []);
    expect(resync).toBe(true);
    expect(draft).toEqual(frozen); // the full snapshot answers, not the fold
  });

  it('skips views that miss their touched id (other boards, or created-and-deleted in the burst)', () => {
    const draft = snapshot([list('l1', 1)], [card('c1', 'l1', 1)]);
    fold(draft, [{ kind: 'card-touch', id: 'unknown' }], []);
    expect(draft.cards.map((row) => row.id)).toEqual(['c1']);
  });
});

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
  resolved_at: null,
  resolved_by: null,
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
      { kind: 'tag-upsert', row: { id: 't1', name: 'urgent' } },
      { kind: 'revision', value: 42 },
      { kind: 'resync' },
    ]);
    expect(plan.boardRow).toEqual({} as never);
    expect(plan.listUpserts.map((row) => row.id)).toEqual(['l9']);
    expect(plan.listDeletes).toEqual(new Set(['l1']));
    expect(plan.cardTouches).toEqual(new Set(['c1']));
    expect(plan.cardDeletes).toEqual(new Set(['c2']));
    expect(plan.tagUpserts.get('t1')).toEqual({ id: 't1', name: 'urgent' });
    expect(plan.revision).toBe(42);
    expect(plan.resync).toBe(true);
  });

  it('keeps the LAST tag upsert per id in a burst', () => {
    const plan = planFold([
      { kind: 'tag-upsert', row: { id: 't1', name: 'old-name' } },
      { kind: 'tag-upsert', row: { id: 't1', name: 'new-name' } },
    ]);
    expect(plan.tagUpserts.size).toBe(1);
    expect(plan.tagUpserts.get('t1')?.name).toBe('new-name');
  });

  it('a tag upsert alone asks for NEITHER a resync NOR a card fetch (the phase-2 proof)', () => {
    const plan = planFold([{ kind: 'tag-upsert', row: { id: 't1', name: 'renamed' } }]);
    expect(plan.resync).toBe(false);
    expect(plan.cardTouches.size).toBe(0);
  });

  it('routes join rows into per-card op maps, LAST op per pair wins', () => {
    const plan = planFold([
      { kind: 'card-tag-attach', cardId: 'c1', tag: { id: 't1', name: 'alpha' } },
      { kind: 'card-tag-attach', cardId: 'c1', tag: { id: 't2', name: 'beta' } },
      { kind: 'card-tag-detach', cardId: 'c1', tagId: 't2' }, // added then removed — removed
      { kind: 'card-tag-detach', cardId: 'c2', tagId: 't1' },
      { kind: 'card-tag-attach', cardId: 'c2', tag: { id: 't1', name: 'alpha' } }, // removed then re-added
      { kind: 'card-assignee-set', cardId: 'c1', userId: 'u1', assigned: true },
      { kind: 'card-assignee-set', cardId: 'c1', userId: 'u2', assigned: true },
      { kind: 'card-assignee-set', cardId: 'c1', userId: 'u2', assigned: false }, // then unassigned
    ]);
    expect(plan.cardTagOps.get('c1')?.get('t1')).toEqual({ name: 'alpha', attached: true });
    expect(plan.cardTagOps.get('c1')?.get('t2')).toEqual({ attached: false });
    expect(plan.cardTagOps.get('c2')?.get('t1')).toEqual({ name: 'alpha', attached: true });
    expect(plan.assigneeOps.get('c1')?.get('u1')).toBe(true);
    expect(plan.assigneeOps.get('c1')?.get('u2')).toBe(false);
  });

  it('join rows ask for NEITHER a resync NOR a card fetch', () => {
    const plan = planFold([
      { kind: 'card-tag-attach', cardId: 'c1', tag: { id: 't1', name: 'alpha' } },
      { kind: 'card-assignee-set', cardId: 'c1', userId: 'u1', assigned: true },
    ]);
    expect(plan.resync).toBe(false);
    expect(plan.cardTouches.size).toBe(0);
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
      [
        { kind: 'card-touch', id: 'c1' },
        { kind: 'card-touch', id: 'c3' },
      ],
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

  it('a tag rename rewrites every chip carrying the tag, in memory, re-sorted', () => {
    const draft = snapshot([list('l1', 1)], []);
    draft.cards.push(
      {
        ...card('c1', 'l1', 1),
        tags: [
          { id: 't1', name: 'zzz-old' },
          { id: 't2', name: 'beta' },
        ],
      },
      { ...card('c2', 'l1', 2), tags: [{ id: 't1', name: 'zzz-old' }] },
      { ...card('c3', 'l1', 3), tags: [{ id: 't2', name: 'beta' }] },
    );
    fold(draft, [{ kind: 'tag-upsert', row: { id: 't1', name: 'aaa-new' } }]);
    // Every embedded copy moved — there is exactly one truth per tag.
    expect(draft.cards[0]!.tags.map((tag) => tag.name)).toEqual(['aaa-new', 'beta']);
    expect(draft.cards[1]!.tags.map((tag) => tag.name)).toEqual(['aaa-new']);
    // Cards without the tag are untouched.
    expect(draft.cards[2]!.tags.map((tag) => tag.name)).toEqual(['beta']);
    // A rename can reorder chips: 'aaa-new' sorts before 'beta' now —
    // the fold re-sorts so the client's merge sees a settled order.
    expect(draft.cards[0]!.tags.map((tag) => tag.id)).toEqual(['t1', 't2']);
  });

  it('a rename of a tag no card carries is a no-op on the draft', () => {
    const draft = snapshot(
      [list('l1', 1)],
      [{ ...card('c1', 'l1', 1), tags: [{ id: 't2', name: 'beta' }] }],
    );
    const frozen: BoardSnapshot = JSON.parse(JSON.stringify(draft));
    fold(draft, [{ kind: 'tag-upsert', row: { id: 't-unlinked', name: 'lonely' } }]);
    expect(draft).toEqual(frozen);
  });

  it('a tag attach adds the chip name-sorted; a detach removes it', () => {
    const draft = snapshot(
      [list('l1', 1)],
      [{ ...card('c1', 'l1', 1), tags: [{ id: 't2', name: 'beta' }] }],
    );
    fold(draft, [{ kind: 'card-tag-attach', cardId: 'c1', tag: { id: 't1', name: 'alpha' } }]);
    expect(draft.cards[0]!.tags.map((tag) => tag.id)).toEqual(['t1', 't2']); // alpha < beta
    fold(draft, [{ kind: 'card-tag-attach', cardId: 'c1', tag: { id: 't3', name: 'zeta' } }]);
    expect(draft.cards[0]!.tags.map((tag) => tag.id)).toEqual(['t1', 't2', 't3']); // zeta last
    fold(draft, [{ kind: 'card-tag-detach', cardId: 'c1', tagId: 't2' }]);
    expect(draft.cards[0]!.tags.map((tag) => tag.id)).toEqual(['t1', 't3']);
    // Re-adding an already-linked tag is idempotent (one chip, not two).
    fold(draft, [{ kind: 'card-tag-attach', cardId: 'c1', tag: { id: 't1', name: 'alpha' } }]);
    expect(draft.cards[0]!.tags.map((tag) => tag.id)).toEqual(['t1', 't3']);
  });

  it("an assignee join row sets and unsets the card's assignees", () => {
    const draft = snapshot([list('l1', 1)], [{ ...card('c1', 'l1', 1), assignees: ['u1'] }]);
    fold(draft, [{ kind: 'card-assignee-set', cardId: 'c1', userId: 'u2', assigned: true }]);
    expect(draft.cards[0]!.assignees).toEqual(['u1', 'u2']);
    fold(draft, [{ kind: 'card-assignee-set', cardId: 'c1', userId: 'u1', assigned: false }]);
    expect(draft.cards[0]!.assignees).toEqual(['u2']);
    fold(draft, [{ kind: 'card-assignee-set', cardId: 'c1', userId: 'u2', assigned: true }]);
    expect(draft.cards[0]!.assignees).toEqual(['u2']); // idempotent
  });

  it('join rows for cards this board does not hold skip quietly (other boards share the channel)', () => {
    const draft = snapshot([list('l1', 1)], [card('c1', 'l1', 1)]);
    const frozen: BoardSnapshot = JSON.parse(JSON.stringify(draft));
    fold(draft, [
      { kind: 'card-tag-attach', cardId: 'other-board-card', tag: { id: 't1', name: 'alpha' } },
      { kind: 'card-assignee-set', cardId: 'other-board-card', userId: 'u1', assigned: true },
    ]);
    expect(draft).toEqual(frozen);
  });

  it("a fetched view overwrites the same burst's join rows — the fetch is the fresher truth", () => {
    const draft = snapshot([list('l1', 1)], [card('c1', 'l1', 1)]);
    // Same burst: an attach event AND a card-touch (say, a title edit).
    // The fetch runs after the events, so its view wins for the card.
    fold(
      draft,
      [{ kind: 'card-tag-attach', cardId: 'c1', tag: { id: 't1', name: 'alpha' } }],
      [{ ...card('c1', 'l1', 1, 'retitled'), tags: [{ id: 't9', name: 'from-db' }] }],
    );
    expect(draft.cards[0]!.title).toBe('retitled');
    expect(draft.cards[0]!.tags.map((tag) => tag.id)).toEqual(['t9']);
  });
});

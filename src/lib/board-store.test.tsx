// Regression tests for the board store — most importantly, the rapid-drag
// replay bug: moving a card A→B then B→C before the database echoed must
// never visually snap back to B, no matter in which order echoes arrive.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, flush } from 'solid-js';

let pushSnapshot: (s: import('./boards').BoardSnapshot) => void = () => {};
let pendingMutations: { resolve: () => void; reject: (e: unknown) => void }[] = [];

vi.mock('./boards', () => ({
  boardStream: () => {
    const pending: import('./boards').BoardSnapshot[] = [];
    let wake: (() => void) | undefined;
    pushSnapshot = (s: import('./boards').BoardSnapshot) => {
      pending.push(s);
      if (wake) {
        const w = wake;
        wake = undefined;
        w();
      }
    };
    return {
      async *[Symbol.asyncIterator]() {
        let current = INITIAL;
        while (true) {
          yield current;
          if (pending.length === 0) {
            await new Promise<void>((r) => {
              wake = r;
            });
            wake = undefined;
          }
          current = pending.shift() ?? current;
        }
      },
    };
  },
  createCard: vi.fn(
    () => new Promise<void>((resolve, reject) => { pendingMutations.push({ resolve, reject }); }),
  ),
  moveCard: vi.fn(
    () => new Promise<void>((resolve, reject) => { pendingMutations.push({ resolve, reject }); }),
  ),
  deleteCard: vi.fn(
    () => new Promise<void>((resolve, reject) => { pendingMutations.push({ resolve, reject }); }),
  ),
  createList: vi.fn(
    () => new Promise<void>((resolve, reject) => { pendingMutations.push({ resolve, reject }); }),
  ),
  deleteList: vi.fn(
    () => new Promise<void>((resolve, reject) => { pendingMutations.push({ resolve, reject }); }),
  ),
  renameList: vi.fn(
    () => new Promise<void>((resolve, reject) => { pendingMutations.push({ resolve, reject }); }),
  ),
}));

import type { BoardSnapshot, CardRow, ListRow } from './boards';

const board = (over: Partial<BoardSnapshot> = {}): BoardSnapshot => ({
  board: { id: 'b1', name: 'Test board', owner_id: 'u1', workspace_id: null, created_at: '', updated_at: '' },
  lists: LIST_FIXTURE,
  cards: CARD_FIXTURE,
  revision: 1,
  ...over,
});

const LIST_FIXTURE: ListRow[] = [
  { id: 'l1', board_id: 'b1', name: 'To do', position: 1, created_at: '' },
  { id: 'l2', board_id: 'b1', name: 'Done', position: 2, created_at: '' },
];

const CARD_FIXTURE: CardRow[] = [
  {
    id: 'c1',
    board_id: 'b1',
    list_id: 'l1',
    title: 'First card',
    description: '',
    position: 1,
    assignee_id: null,
    created_by: 'u1',
    created_at: '',
    updated_at: '',
  },
];

const INITIAL = board();

import { createBoardStore } from './board-store';

let dispose: (() => void) | undefined;

/** The live-source pump lands its yields on real event-loop ticks; flush()
 *  then applies the update. After any stream push or server resolve, await
 *  this before asserting. */
const pendingMutationsResolved = async (index: number) => {
  pendingMutations[index].resolve();
  await settle();
};

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
};

async function makeStore() {
  let store!: ReturnType<typeof createBoardStore>;
  dispose = createRoot((d) => {
    store = createBoardStore(() => 'b1');
    return d;
  });
  flush();
  await settle();
  return store;
}

/** A plain (non-proxy) copy of the card as the UI would see it. */
const card = (store: ReturnType<typeof createBoardStore>, id: string): CardRow | undefined => {
  const found = store.board.cards.find((c: CardRow) => c.id === id);
  return found ? JSON.parse(JSON.stringify(found)) : undefined;
};

const anyCard = (store: ReturnType<typeof createBoardStore>, pred: (c: CardRow) => boolean) =>
  store.board.cards.some((c: CardRow) => pred(JSON.parse(JSON.stringify(c))));

beforeEach(() => {
  pendingMutations = [];
  pushSnapshot = () => {};
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.clearAllMocks();
});

describe('createBoardStore', () => {
  it('shows the initial snapshot from the stream', async () => {
    const store = await makeStore();
    expect(store.board.board.id).toBe('b1');
    expect(card(store, 'c1')?.list_id).toBe('l1');
  });

  it('moves a card optimistically and settles invisibly on the echo', async () => {
    const store = await makeStore();
    expect(card(store, 'c1')?.list_id).toBe('l1');

    store.actions.moveCard('c1', 'l2', 0);
    flush();
    // Optimistic: visible immediately.
    expect(card(store, 'c1')?.list_id).toBe('l2');

    // Server confirms; the database echo carries the same truth.
    await pendingMutationsResolved(0);
    pushSnapshot(board({ cards: [{ ...CARD_FIXTURE[0], list_id: 'l2', position: 1 }] }));
    await settle();
    // Overlay → durable handoff: no visible change.
    expect(card(store, 'c1')?.list_id).toBe('l2');
  });

  it('NEVER snaps back when rapid drags interleave with echoes (the replay bug)', async () => {
    const store = await makeStore();
    const l3: ListRow = { id: 'l3', board_id: 'b1', name: 'Third', position: 3, created_at: '' };
    pushSnapshot(board({ lists: [...LIST_FIXTURE, l3] }));
    await settle();

    // Move 1: l1 → l2 (server call pending)
    store.actions.moveCard('c1', 'l2', 0);
    flush();
    expect(card(store, 'c1')?.list_id).toBe('l2');

    // Move 2 before move 1's echo: l2 → l3 (server call pending)
    store.actions.moveCard('c1', 'l3', 0);
    flush();
    expect(card(store, 'c1')?.list_id).toBe('l3');

    // Move 1's echo arrives: the database says the card is in l2 — but the
    // overlay for move 2 (l3) must keep it visible at l3. This is the exact
    // moment the old revision-guard replayed the sequence.
    await pendingMutationsResolved(0);
    pushSnapshot(
      board({
        lists: [...LIST_FIXTURE, l3],
        cards: [{ ...CARD_FIXTURE[0], list_id: 'l2', position: 1 }],
      }),
    );
    flush();
    expect(card(store, 'c1')?.list_id).toBe('l3');

    // Move 2's echo arrives: the card is at l3 in the database too.
    await pendingMutationsResolved(0);
    pushSnapshot(
      board({
        lists: [...LIST_FIXTURE, l3],
        cards: [{ ...CARD_FIXTURE[0], list_id: 'l3', position: 1 }],
      }),
    );
    flush();
    expect(card(store, 'c1')?.list_id).toBe('l3');
  });

  it('reverts the move when the server rejects it', async () => {
    const store = await makeStore();

    store.actions.moveCard('c1', 'l2', 0);
    flush();
    expect(card(store, 'c1')?.list_id).toBe('l2');

    pendingMutations[0].reject(new Error('nope'));
    await settle();
    // Overlay discarded: back to the durable state.
    expect(card(store, 'c1')?.list_id).toBe('l1');
  });

  it('adds a card optimistically and keeps it through the echo', async () => {
    const store = await makeStore();

    store.actions.addCard('l1', 'A new card');
    flush();
    expect(anyCard(store, (c) => c.title === 'A new card' && c.list_id === 'l1')).toBe(true);

    await pendingMutationsResolved(0);
    pushSnapshot(
      board({
        cards: [
          ...CARD_FIXTURE,
          {
            id: 'c-real',
            board_id: 'b1',
            list_id: 'l1',
            title: 'A new card',
            description: '',
            position: 2,
            assignee_id: null,
            created_by: 'u1',
            created_at: '',
            updated_at: '',
          },
        ],
      }),
    );
    flush();
    const titles = store.board.cards.map((c: CardRow) => c.title);
    expect(titles).toContain('A new card');
    expect(titles).toHaveLength(2);
  });

  it('removes a list optimistically, cards and all', async () => {
    const store = await makeStore();
    store.actions.removeList('l1');
    flush();
    expect(
      store.board.lists.some((l: ListRow) => l.id === 'l1'),
    ).toBe(false);
    expect(card(store, 'c1')).toBeUndefined();

    await pendingMutationsResolved(0);
    pushSnapshot(board({ lists: [LIST_FIXTURE[1]], cards: [] }));
    await settle();
    expect(store.board.lists.length).toBe(1);
  });
});

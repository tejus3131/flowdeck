// The board store: one live source, one optimistic overlay, and the actions
// that write through to the server.
//
// The pattern (per the Mutations docs): every action writes the expected
// result into the optimistic store first — it shows immediately — then
// yields the server call, then holds the overlay open with `until()` until
// the LIVE STREAM has echoed the specific change (a predicate only the
// database can satisfy — the overlay can't). If the server call fails, the
// overlay is discarded automatically and the card snaps back — there is no
// rollback code here.
//
// The durable stream (below) is the overlay-free view of the database;
// predicates read it so a pending action's own optimistic write can never
// satisfy its guard. Guards match the specific change (list + position),
// never "any activity happened" — that was the bug that made rapid drags
// replay: any echo settled every action, dropping overlays whose change
// hadn't landed yet.
import {
  action,
  createMemo,
  createOptimisticStore,
  createSignal,
  until,
  type Accessor,
  type Store,
} from 'solid-js';

import type { LiveSourceStatus } from '@solidjs/web/server-functions';

import {
  boardStream,
  createCard,
  createList,
  deleteCard,
  deleteList,
  moveCard as moveCardServer,
  renameBoard as renameBoardServer,
  renameList as renameListServer,
  updateCard as updateCardServer,
  type BoardSnapshot,
  type CardRow,
  type ListRow,
} from './boards';

const ECHO_TIMEOUT = 8000;

/** Commit #0: what the store shows before the live source's first answer.
 *  Serving this seed keeps reads non-suspending (the shell renders
 *  instantly) and lets optimistic writes race the initial load cleanly. */
const EMPTY_SNAPSHOT: BoardSnapshot = {
  board: { id: '', name: '', owner_id: '', created_at: '', updated_at: '' },
  lists: [],
  cards: [],
  revision: 0,
};

/** The position a card would take at `index` inside `listId`'s cards. */
function positionAt(cards: CardRow[], listId: string, index: number): number {
  const positions = cards
    .filter((card) => card.list_id === listId)
    .map((card) => card.position)
    .sort((a, b) => a - b);
  const prev = positions[index - 1];
  const next = positions[index];
  if (prev === undefined && next === undefined) return 1;
  if (prev === undefined) return next / 2;
  if (next === undefined) return prev + 1;
  return (prev + next) / 2;
}

/** Sort the cards array the way the board displays it. */
function displaySort(cards: CardRow[], lists: ListRow[]): (a: CardRow, b: CardRow) => number {
  const listIndex = new Map(lists.map((list, index) => [list.id, index]));
  return (a, b) => {
    const la = listIndex.get(a.list_id) ?? 0;
    const lb = listIndex.get(b.list_id) ?? 0;
    return la === lb ? a.position - b.position : la - lb;
  };
}

/** Wait for the database to echo a specific change; never settle on
 *  anything weaker. A timeout settles quietly (the overlay drops and the
 *  stream reconciles whenever the echo eventually arrives); a server error
 *  rejects for real and the overlay is discarded. */
const echo = (predicate: () => boolean) =>
  until(predicate, { timeout: ECHO_TIMEOUT }).catch(() => {
    /* timed out: settle without the echo */
  });

export function createBoardStore(boardId: Accessor<string>) {
  // Transport facts of the live connection, for the "reconnecting" pill.
  const [status, setStatus] = createSignal<LiveSourceStatus | undefined>();

  // One memo, one connection per viewer — pass the value down, don't reopen.
  const stream = createMemo(() => {
    const source = boardStream(boardId());
    source.onstatus = (next) => setStatus(next);
    return source;
  }, {
    loadingValue: EMPTY_SNAPSHOT,
  });
  // The overlay-free view of what the database has confirmed. Predicates
  // read this, never the optimistic store.
  const durable = createMemo<BoardSnapshot>(() => stream());
  const [board, setBoard] = createOptimisticStore<BoardSnapshot>(() => stream());

  const cardAt = (id: string) => durable()?.cards.find((card) => card.id === id);

  const addCard = action(function* (listId: string, title: string) {
    setBoard((s) => {
      const last = Math.max(
        0,
        ...s.cards.filter((c) => c.list_id === listId).map((c) => c.position),
      );
      s.cards.push({
        id: crypto.randomUUID(),
        board_id: s.board.id,
        list_id: listId,
        title,
        description: '',
        position: last + 1,
        assignee_id: null,
        created_by: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    });
    yield createCard(listId, title);
    // Echoed when the database has a card with this title in this list.
    yield echo(() =>
      (durable()?.cards ?? []).some((c) => c.list_id === listId && c.title === title),
    );
  });

  const removeCard = action(function* (cardId: string) {
    setBoard((s) => {
      const index = s.cards.findIndex((c) => c.id === cardId);
      if (index >= 0) s.cards.splice(index, 1);
    });
    yield deleteCard(cardId);
    yield echo(() => !(durable()?.cards ?? []).some((c) => c.id === cardId));
  });

  /** Drag & drop: move `cardId` into `toListId` at display index `toIndex`. */
  const moveCard = action(function* (cardId: string, toListId: string, toIndex: number) {
    const position = positionAt(board.cards, toListId, toIndex);
    setBoard((s) => {
      const index = s.cards.findIndex((c) => c.id === cardId);
      if (index < 0) return;
      const [card] = s.cards.splice(index, 1);
      card.list_id = toListId;
      card.position = positionAt(
        s.cards.filter((c) => c.id !== cardId),
        toListId,
        toIndex,
      );
      s.cards.push(card);
      s.cards.sort(displaySort(s.cards, s.lists));
    });
    yield moveCardServer(cardId, toListId, position);
    // Echoed only when THIS card sits at the exact list + position the
    // server was told to write — another action's echo can never settle it.
    yield echo(() => {
      const card = cardAt(cardId);
      return !!card && card.list_id === toListId && card.position === position;
    });
  });

  const addList = action(function* (name: string) {
    setBoard((s) => {
      const last = Math.max(0, ...s.lists.map((l) => l.position));
      s.lists.push({
        id: crypto.randomUUID(),
        board_id: s.board.id,
        name,
        position: last + 1,
        created_at: new Date().toISOString(),
      });
    });
    yield createList(boardId(), name);
    yield echo(() => (durable()?.lists ?? []).some((l) => l.name === name));
  });

  const removeList = action(function* (listId: string) {
    setBoard((s) => {
      const index = s.lists.findIndex((l) => l.id === listId);
      if (index >= 0) s.lists.splice(index, 1);
      s.cards = s.cards.filter((c) => c.list_id !== listId);
    });
    yield deleteList(listId);
    yield echo(() => !(durable()?.lists ?? []).some((l) => l.id === listId));
  });

  const renameList = action(function* (listId: string, name: string) {    setBoard((s) => {
      const list = s.lists.find((l) => l.id === listId);
      if (list) list.name = name;
    });
    yield renameListServer(listId, name);
    yield echo(() =>
      (durable()?.lists ?? []).some((l) => l.id === listId && l.name === name),
    );
  });

  /** Edit a card's title/description from the detail drawer. */
  const updateCard = action(function* (
    cardId: string,
    patch: { title?: string; description?: string },
  ) {
    setBoard((s) => {
      const card = s.cards.find((c) => c.id === cardId);
      if (!card) return;
      if (patch.title !== undefined) card.title = patch.title;
      if (patch.description !== undefined) card.description = patch.description;
    });
    yield updateCardServer(cardId, patch);
    yield echo(() => {
      const card = cardAt(cardId);
      if (!card) return false;
      if (patch.title !== undefined && card.title !== patch.title) return false;
      if (patch.description !== undefined && card.description !== patch.description) return false;
      return true;
    });
  });

  const renameBoard = action(function* (name: string) {
    setBoard((s) => {
      s.board.name = name;
    });
    yield renameBoardServer(boardId(), name);
    yield echo(() => durable().board.name === name);
  });

  return {
    board: board as Store<BoardSnapshot>,
    durable,
    stream,
    status,
    actions: {
      addCard,
      removeCard,
      moveCard,
      addList,
      removeList,
      renameList,
      renameBoard,
      updateCard,
    },
  };
}

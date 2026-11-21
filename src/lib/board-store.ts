// The board store: one live source, one optimistic overlay, and the actions
// that write through to the server.
//
// The pattern (per the Mutations docs): every action writes the expected
// result into the optimistic store first — it shows immediately — then
// yields the server call, then holds the overlay open with `until()` until
// the live stream echoes the change (the stream's `revision` is only ever
// bumped by the database, never by our overlay, so the predicate can only
// be satisfied by the authoritative echo). If the server call fails, the
// overlay is discarded automatically and the card snaps back — there is no
// rollback code here.
import {
  action,
  createMemo,
  createOptimisticStore,
  until,
  type Accessor,
  type Store,
} from 'solid-js';

import {
  boardStream,
  createCard,
  createList,
  deleteCard,
  deleteList,
  moveCard as moveCardServer,
  renameList as renameListServer,
  type BoardSnapshot,
  type CardRow,
  type ListRow,
} from './boards';

const ECHO_TIMEOUT = 5000;

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

export function createBoardStore(boardId: Accessor<string>) {
  // One memo, one connection per viewer — pass the value down, don't reopen.
  const stream = createMemo(() => boardStream(boardId()));
  const [board, setBoard] = createOptimisticStore<BoardSnapshot>(() => stream());

  /** The durable revision: only a database echo ever moves it. */
  const revision = () => board.revision;

  const addCard = action(function* (listId: string, title: string) {
    const r0 = revision();
    const tempId = crypto.randomUUID();
    setBoard((s) => {
      const last = Math.max(0, ...s.cards.filter((c) => c.list_id === listId).map((c) => c.position));
      s.cards.push({
        id: tempId,
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
    yield until(() => revision() > r0, { timeout: ECHO_TIMEOUT });
  });

  const removeCard = action(function* (cardId: string) {
    const r0 = revision();
    setBoard((s) => {
      const index = s.cards.findIndex((c) => c.id === cardId);
      if (index >= 0) s.cards.splice(index, 1);
    });
    yield deleteCard(cardId);
    yield until(() => revision() > r0, { timeout: ECHO_TIMEOUT });
  });

  /** Drag & drop: move `cardId` into `toListId` at display index `toIndex`. */
  const moveCard = action(function* (cardId: string, toListId: string, toIndex: number) {
    const r0 = revision();
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
    yield until(() => revision() > r0, { timeout: ECHO_TIMEOUT });
  });

  const addList = action(function* (name: string) {
    const r0 = revision();
    const tempId = crypto.randomUUID();
    setBoard((s) => {
      const last = Math.max(0, ...s.lists.map((l) => l.position));
      s.lists.push({
        id: tempId,
        board_id: s.board.id,
        name,
        position: last + 1,
        created_at: new Date().toISOString(),
      });
    });
    yield createList(boardId(), name);
    yield until(() => revision() > r0, { timeout: ECHO_TIMEOUT });
  });

  const removeList = action(function* (listId: string) {
    const r0 = revision();
    setBoard((s) => {
      const index = s.lists.findIndex((l) => l.id === listId);
      if (index >= 0) s.lists.splice(index, 1);
      s.cards = s.cards.filter((c) => c.list_id !== listId);
    });
    yield deleteList(listId);
    yield until(() => revision() > r0, { timeout: ECHO_TIMEOUT });
  });

  const renameList = action(function* (listId: string, name: string) {
    const r0 = revision();
    setBoard((s) => {
      const list = s.lists.find((l) => l.id === listId);
      if (list) list.name = name;
    });
    yield renameListServer(listId, name);
    yield until(() => revision() > r0, { timeout: ECHO_TIMEOUT });
  });

  return {
    board: board as Store<BoardSnapshot>,
    actions: { addCard, removeCard, moveCard, addList, removeList, renameList },
  };
}

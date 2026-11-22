// Open-scope registry: which chats the user is LOOKING at right now.
// The notification engine consults it — a mention that lands in a chat
// you have open doesn't toast/chime/push (Slack's "you're already
// there" behavior); the row is quietly marked read instead.
import { createSignal } from 'solid-js';

const openBoards = new Set<string>();
const openCards = new Set<string>();
const [version, setVersion] = createSignal(0, { equals: false });

function bump(): void {
  setVersion(version() + 1);
}

/** The board chat panel is open (its messages are on screen). */
export function openBoardChat(boardId: string): () => void {
  openBoards.add(boardId);
  bump();
  return () => {
    openBoards.delete(boardId);
    bump();
  };
}

/** A card's drawer is open (its comments are on screen). */
export function openCardScope(cardId: string): () => void {
  openCards.add(cardId);
  bump();
  return () => {
    openCards.delete(cardId);
    bump();
  };
}

/** Is the row's scope on screen? (chat/mention rows only). */
export function isScopeOpen(row: { board_id: string | null; card_id: string | null }): boolean {
  version();
  if (row.card_id) return openCards.has(row.card_id);
  if (row.board_id) return openBoards.has(row.board_id);
  return false;
}

/** The boards whose chat is open right now (for stamping read). */
export function openBoardChatIds(): string[] {
  version();
  return [...openBoards];
}

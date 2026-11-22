// Board-chat read state — shared by the board page's unread dot AND the
// bell panel (marking a chat notification read clears the dot too).
const KEY = (boardId: string) => `flowdeck:board-chat-seen:${boardId}`;

/** The last message instant this device saw for the board. */
export function boardChatStamp(boardId: string): number {
  try {
    return Number(localStorage.getItem(KEY(boardId)) ?? '0');
  } catch {
    return 0;
  }
}

/** Record that this device has seen up to `latest` (monotonic). */
export function stampBoardChatSeen(boardId: string, latest: number): void {
  try {
    if (latest > boardChatStamp(boardId)) {
      localStorage.setItem(KEY(boardId), String(latest));
    }
  } catch {
    // best effort — the dot just lingers
  }
}

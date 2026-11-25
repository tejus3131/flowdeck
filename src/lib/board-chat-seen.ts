// Board-chat read state — shared by the board page's unread dot AND the
// bell panel (marking a chat notification read clears the dot too).
//
// The SOURCE OF TRUTH is server-side (#37, #43): a chat_seen row per
// user per scope (migration 0056), written through mark_chat_seen and
// read through get_chat_seen. localStorage keeps an instant per-device
// cache — marks land there immediately (the dot never waits on the
// network), the server write follows on a short debounce, and a fresh
// device hydrates its stamp from the server on board open so it no
// longer shows every message unread.
import { createSignal } from 'solid-js';

import { createSupabaseRequestClient } from '../server/supabase';

const KEY = (boardId: string) => `flowdeck:board-chat-seen:${boardId}`;

// Reactive version: every stamp advance bumps it, so consumers reading
// boardChatStamp() re-run — a mark from the bell panel clears the board
// page's dot, and a server hydration can clear "unread" right away.
const [version, setVersion] = createSignal(0, { equals: false });

function readLocal(boardId: string): number {
  try {
    return Number(localStorage.getItem(KEY(boardId)) ?? '0');
  } catch {
    return 0;
  }
}

function writeLocal(boardId: string, latest: number): void {
  try {
    localStorage.setItem(KEY(boardId), String(latest));
  } catch {
    // best effort — the dot just lingers
  }
}

/** Advance the stamp locally (monotonic). */
function stampLocal(boardId: string, latest: number): void {
  if (latest > readLocal(boardId)) {
    writeLocal(boardId, latest);
    setVersion(version() + 1);
  }
}

/** The last message instant this device saw for the board. */
export function boardChatStamp(boardId: string): number {
  version(); // track: local marks + server hydration re-run this
  return readLocal(boardId);
}

// ── server sync: debounced writes, hydrating reads ──────────────────────
const pending = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    const batch = [...pending.entries()];
    pending.clear();
    for (const [boardId, at] of batch) {
      void pushBoardChatSeen(boardId, at).catch(() => {});
    }
  }, 1500);
}

/** Record that this device has seen up to `latest` (monotonic). The
 *  local cache advances instantly; the server row follows shortly. */
export function stampBoardChatSeen(boardId: string, latest: number): void {
  stampLocal(boardId, latest);
  if (latest > (pending.get(boardId) ?? 0)) pending.set(boardId, latest);
  scheduleFlush();
}

/** Seed this device's stamp from the server (a new device opens the
 *  board with its true read state — not "everything unread"). */
export async function hydrateBoardChatSeen(boardId: string): Promise<void> {
  try {
    const serverAt = await fetchBoardChatSeen(boardId);
    if (serverAt > 0) stampLocal(boardId, serverAt);
  } catch {
    // offline / signed out — the local stamp still governs
  }
}

/** The server-side stamp for a board scope, in epoch ms (0 when none). */
async function fetchBoardChatSeen(boardId: string): Promise<number> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return 0;
  const { data, error } = await supabase.rpc('get_chat_seen', {
    p_scope_type: 'board',
    p_scope_id: boardId,
  });
  if (error) throw new Error(error.message);
  return data ? +new Date(data) : 0;
}

/** Move the server-side stamp forward (it never moves back). */
async function pushBoardChatSeen(boardId: string, seenAt: number): Promise<void> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return;
  const { error } = await supabase.rpc('mark_chat_seen', {
    p_scope_type: 'board',
    p_scope_id: boardId,
    p_seen_at: new Date(seenAt).toISOString(),
  });
  if (error) throw new Error(error.message);
}

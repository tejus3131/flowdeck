// Prefetch by journey — Phase 3 of docs/performance.md (card #45's
// "optimistic caching": everything the user is about to see arrives in
// the cache before they click).
//
// Three journeys warm the Phase 1 cache:
//   * a notification arrives → its board snapshot, the board chat, and
//     the card's comments + timeline (whichever the row points at)
//   * a grant notification → the granted board (same path, by kind)
//   * the dashboard → the most recently opened boards
//
// The rules (docs/performance-rules.md 12–13): idle-time, deduped
// in-flight, warm-if-missing (cached targets revalidate on open —
// re-fetching them is the thing we removed), and a warm that finishes
// over an OPEN board never writes (the board's live channel owns its
// freshness; a late stale write would sit until the next change).
//
// The server reads are imported lazily: the warm path runs only in the
// browser, on idle, off the critical module graph.
import { isServer } from '@solidjs/web';

import { cacheGet, cachePut } from './cache';

/** Boards currently open in the app — the route marks its board so a
 *  finishing warm skips the write (rule: never overwrite the live). */
const openBoards = new Set<string>();

export function warmBoardActive(boardId: string, active: boolean): void {
  if (active) openBoards.add(boardId);
  else openBoards.delete(boardId);
}

/** Keys with a warm in flight — one fetch per key, bursts coalesce. */
const inFlight = new Set<string>();

function idle(work: () => void): void {
  if (isServer) return;
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => work());
  } else {
    setTimeout(work, 300); // Safari: idle-ish
  }
}

/**
 * Warm one cache key: idle-time, deduped, warm-if-missing, best-effort.
 * `fetch` supplies the fresh value (null/undefined = nothing to cache);
 * the write is skipped when `guard` says the target is live-owned now.
 */
export function warm(key: string, fetch: () => Promise<unknown>, guard?: () => boolean): void {
  if (isServer) return;
  idle(() => {
    void (async () => {
      if (inFlight.has(key)) return;
      inFlight.add(key);
      try {
        if ((await cacheGet(key)) !== null) return; // warm-if-missing
        const value = await fetch();
        if (value === null || value === undefined) return;
        if (guard?.()) return; // live-owned: let the channel write it
        cachePut(key, value);
      } catch {
        // best-effort — the open path fetches on demand anyway
      } finally {
        inFlight.delete(key);
      }
    })();
  });
}

// ── the journeys ────────────────────────────────────────────────────────

/** The board snapshot — a denied board warms nothing (no stale flash,
 *  no caching what the user cannot see). */
export function warmBoard(boardId: string): void {
  warm(
    `board:${boardId}`,
    async () => {
      const { getBoardSnapshot } = await import('./boards');
      const snapshot = await getBoardSnapshot(boardId);
      return snapshot.denied ? null : snapshot;
    },
    () => openBoards.has(boardId),
  );
}

/** The board chat's latest page (the chat stream writes this shape). */
export function warmBoardChat(boardId: string): void {
  warm(
    `board-chat:${boardId}`,
    async () => {
      const { getBoardChatSnapshot } = await import('./boards');
      return getBoardChatSnapshot(boardId);
    },
    () => openBoards.has(boardId),
  );
}

/** A card's latest comments page (the drawer's stream writes this shape). */
export function warmCardComments(cardId: string): void {
  warm(`card-comments:${cardId}`, async () => {
    const { getCardComments } = await import('./boards');
    return getCardComments(cardId);
  });
}

/** A card's activity timeline (the settings tab fetches this shape). */
export function warmCardTimeline(cardId: string): void {
  warm(`card-timeline:${cardId}`, async () => {
    const { getCardEvents } = await import('./boards');
    return getCardEvents(cardId);
  });
}

/** The notification journey: whatever the row points at warms before the
 *  click — board first (the big cold cost), then the chat, then the
 *  card's comments and timeline when it names a card. */
export function warmNotificationTarget(row: {
  board_id: string | null;
  card_id: string | null;
}): void {
  if (!row.board_id) return;
  warmBoard(row.board_id);
  warmBoardChat(row.board_id);
  if (row.card_id) {
    warmCardComments(row.card_id);
    warmCardTimeline(row.card_id);
  }
}

// ── the dashboard journey (most recently opened boards) ─────────────────

const RECENT_KEY = 'fd-recent-boards';
const RECENT_MAX = 5;

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? (raw.filter((id) => typeof id === 'string') as string[]) : [];
  } catch {
    return []; // blocked storage or corrupt list — prefetch is best-effort
  }
}

/** The board route marks itself most-recently-used. */
export function trackRecentBoard(boardId: string): void {
  if (isServer) return;
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([boardId, ...readRecent().filter((id) => id !== boardId)].slice(0, RECENT_MAX)),
    );
  } catch {
    // blocked storage — the dashboard just warms less
  }
}

/** The dashboard journey: warm the boards the user actually re-opens. */
export function warmRecentBoards(): void {
  for (const id of readRecent()) warmBoard(id);
}

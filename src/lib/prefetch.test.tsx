// Prefetch journey tests — Phase 3's contract: every fresh notification
// warms its target before the click, warm-if-missing never re-fetches,
// an open board's live channel is never overwritten by a late warm, and
// MRU warming feeds the dashboard. The server reads are mocked (the
// journeys are compositions; the machinery is what needs pinning).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheClear, cacheGet } from './cache';
import {
  trackRecentBoard,
  warmBoard,
  warmBoardActive,
  warmCardComments,
  warmNotificationTarget,
  warmRecentBoards,
} from './prefetch';
import { getBoardChatSnapshot, getBoardSnapshot, getCardComments, getCardEvents } from './boards';

vi.mock('./boards', () => ({
  getBoardSnapshot: vi.fn(async (boardId: string) => ({
    board: { id: boardId },
    lists: [],
    cards: [],
    revision: 1,
    myAccess: 'edit',
    denied: false,
  })),
  getBoardChatSnapshot: vi.fn(async (boardId: string) => [{ id: `m-${boardId}` }]),
  getCardComments: vi.fn(async (cardId: string) => [{ id: `c-${cardId}` }]),
  getCardEvents: vi.fn(async (cardId: string) => [{ id: `e-${cardId}` }]),
}));

/** warm() schedules idle-time (setTimeout fallback) — let it land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 450));

describe('prefetch by journey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheClear();
    localStorage.removeItem('fd-recent-boards');
    warmBoardActive('b1', false);
    warmBoardActive('b2', false);
  });
  afterEach(async () => {
    warmBoardActive('b1', false);
    warmBoardActive('b2', false);
    cacheClear();
    localStorage.removeItem('fd-recent-boards');
    await settle();
  });

  it('a notification with a board and card warms all four targets', async () => {
    warmNotificationTarget({ board_id: 'b1', card_id: 'c1' });
    await settle();
    expect(getBoardSnapshot).toHaveBeenCalledWith('b1');
    expect(getBoardChatSnapshot).toHaveBeenCalledWith('b1');
    expect(getCardComments).toHaveBeenCalledWith('c1');
    expect(getCardEvents).toHaveBeenCalledWith('c1');
    expect(await cacheGet('board:b1')).toMatchObject({ board: { id: 'b1' } });
    expect(await cacheGet('board-chat:b1')).toEqual([{ id: 'm-b1' }]);
    expect(await cacheGet('card-comments:c1')).toEqual([{ id: 'c-c1' }]);
    expect(await cacheGet('card-timeline:c1')).toEqual([{ id: 'e-c1' }]);
  });

  it('a board-only notification warms the board and chat, no card pages', async () => {
    warmNotificationTarget({ board_id: 'b2', card_id: null });
    await settle();
    expect(getBoardSnapshot).toHaveBeenCalledWith('b2');
    expect(getBoardChatSnapshot).toHaveBeenCalledWith('b2');
    expect(getCardComments).not.toHaveBeenCalled();
    expect(getCardEvents).not.toHaveBeenCalled();
  });

  it('a notification without a board warms nothing', async () => {
    warmNotificationTarget({ board_id: null, card_id: 'c1' });
    await settle();
    expect(getBoardSnapshot).not.toHaveBeenCalled();
  });

  it('warm-if-missing: an already-cached target is not re-fetched', async () => {
    warmNotificationTarget({ board_id: 'b1', card_id: 'c1' });
    await settle();
    expect(getBoardSnapshot).toHaveBeenCalledTimes(1);
    // A second notification about the same board: cached → no re-fetch.
    warmNotificationTarget({ board_id: 'b1', card_id: 'c1' });
    await settle();
    expect(getBoardSnapshot).toHaveBeenCalledTimes(1);
    expect(getCardComments).toHaveBeenCalledTimes(1);
  });

  it('a late warm never overwrites an open board (the live channel owns it)', async () => {
    warmBoardActive('b1', true); // the user opened the board mid-warm
    warmBoard('b1');
    await settle();
    expect(getBoardSnapshot).toHaveBeenCalledTimes(1); // fetched…
    expect(await cacheGet('board:b1')).toBeNull(); // …but not written
  });

  it('a denied board warms nothing (no stale flash, no caching the invisible)', async () => {
    vi.mocked(getBoardSnapshot).mockResolvedValueOnce({
      board: {
        id: 'b1',
        name: 'B',
        description: '',
        owner_id: 'u1',
        workspace_id: null,
        created_at: '',
        updated_at: '',
        client_op: null,
        access_delegation: false,
      },
      lists: [],
      cards: [],
      revision: 0,
      myAccess: null,
      denied: true,
    });
    warmBoard('b1');
    await settle();
    expect(await cacheGet('board:b1')).toBeNull();
  });

  it('bursts coalesce: concurrent warms of one key fetch once', async () => {
    warmBoard('b1');
    warmBoard('b1');
    warmBoard('b1');
    await settle();
    expect(getBoardSnapshot).toHaveBeenCalledTimes(1);
  });

  it('a failed warm is swallowed (best-effort — the open path fetches anyway)', async () => {
    vi.mocked(getCardComments).mockRejectedValueOnce(new Error('network died'));
    warmCardComments('c1');
    await expect(settle()).resolves.toBeUndefined();
    expect(await cacheGet('card-comments:c1')).toBeNull();
  });

  it('the dashboard warms the MRU boards, most recent first, capped at 5', async () => {
    for (const id of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']) trackRecentBoard(id);
    warmRecentBoards();
    await settle();
    // 6 tracked, 5 warmed — b6 most recent first.
    expect(getBoardSnapshot).toHaveBeenCalledTimes(5);
    const calls = vi.mocked(getBoardSnapshot).mock.calls.map((call) => call[0]);
    expect(calls).toEqual(['b6', 'b5', 'b4', 'b3', 'b2']);
  });

  it('re-opening a board moves it to the front of MRU', async () => {
    trackRecentBoard('b1');
    trackRecentBoard('b2');
    trackRecentBoard('b1');
    warmRecentBoards();
    await settle();
    const calls = vi.mocked(getBoardSnapshot).mock.calls.map((call) => call[0]);
    expect(calls).toEqual(['b1', 'b2']);
  });
});

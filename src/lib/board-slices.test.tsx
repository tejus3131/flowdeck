// Topic-slice tests (phase 4, ADR-3). The one bug class the fold tests
// cannot see: a slice keyed by the CARD id would spin a phantom, denied
// board topic whose digests never arrive — invisible to everything but
// the 20s poll. These pin the contract: the topic is called with the
// BOARD id, the pages are per-card, and only this card's digest rows
// move the slice.
import { describe, expect, it } from 'vitest';

import { commentsSlice, timelineSlice } from './board-slices';
import type { BoardTopicSnapshot, CardEventRow, CommentRow } from './boards';

// ── fixtures ─────────────────────────────────────────────────────────────

const composite = (
  over: {
    newEvents?: Array<CardEventRow & { card_id: string | null }>;
    commentPages?: Record<string, CommentRow[]>;
  } = {},
): BoardTopicSnapshot =>
  ({
    board: { id: 'b1' },
    lists: [],
    cards: [],
    revision: 0,
    myAccess: 'edit',
    denied: false,
    chat: [],
    commentPages: over.commentPages ?? {},
    newEvents: over.newEvents ?? [],
  }) as unknown as BoardTopicSnapshot;

const evt = (id: number, cardId: string | null): CardEventRow & { card_id: string | null } => ({
  id,
  kind: 'created',
  detail: {},
  actor_id: null,
  card_id: cardId,
  created_at: `2026-01-0${Math.min(id, 9)}T00:00:00Z`,
  agent: false,
});

const comment = (id: string): CommentRow =>
  ({
    id,
    body: 'hi',
    created_at: '2026-01-01T00:00:00Z',
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
    deleted_as: null,
    deleted_as_team_id: null,
    seq: 1,
    client_op: null,
    agent: false,
    author_id: null,
    avatar_url: null,
    author: 'Someone',
  }) as CommentRow;

// ── the contract ─────────────────────────────────────────────────────────

describe('topic slices', () => {
  it('the timeline slice subscribes to the topic by the BOARD id', async () => {
    const calls: string[] = [];
    const topic = (boardId: string) => {
      calls.push(boardId);
      return (async function* () {
        yield composite();
      })();
    };
    const rows: CardEventRow[] = [];
    for await (const page of timelineSlice({
      boardId: 'BOARD',
      cardId: 'CARD',
      topic,
      fetchPage: async () => [],
    })) {
      rows.push(...page);
    }
    expect(calls).toEqual(['BOARD']); // never the card id
  });

  it("the timeline appends only THIS card's events, in bursts", async () => {
    const topic = () =>
      (async function* () {
        yield composite({ newEvents: [evt(1, 'CARD'), evt(2, 'OTHER')] });
        yield composite({ newEvents: [evt(3, 'CARD')] });
        yield composite({ commentPages: { CARD: [] } }); // no events: no yield
      })();
    const pages: CardEventRow[][] = [];
    for await (const page of timelineSlice({
      boardId: 'BOARD',
      cardId: 'CARD',
      topic,
      fetchPage: async () => [evt(0, 'CARD')],
    })) {
      pages.push(page);
    }
    // The cold page, then two appends; the other card's event never lands;
    // the events-free burst yields nothing.
    expect(pages.map((page) => page.map((row) => row.id))).toEqual([[0], [0, 1], [0, 1, 3]]);
  });

  it("the comments slice subscribes by the BOARD id and replaces on its card's digest", async () => {
    const calls: string[] = [];
    const topic = (boardId: string) => {
      calls.push(boardId);
      return (async function* () {
        yield composite({ commentPages: { OTHER: [comment('x')] } }); // not this card
        yield composite({ commentPages: { CARD: [comment('a')] } });
      })();
    };
    const pages: CommentRow[][] = [];
    for await (const page of commentsSlice({
      boardId: 'BOARD',
      cardId: 'CARD',
      topic,
      fetchPage: async () => [comment('cold')],
    })) {
      pages.push(page);
    }
    expect(calls).toEqual(['BOARD']);
    expect(pages.map((page) => page.map((row) => row.id))).toEqual([['cold'], ['a']]);
  });
});

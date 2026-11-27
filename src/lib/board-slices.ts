// The drawer's topic slices (phase 4, ADR-3) — the per-card surfaces of
// the board composite. Extracted from the route so the KEY CONTRACT is
// testable with a mock topic: the topic is subscribed by the BOARD id
// (the composite is board-scoped) while the page data is per-CARD — a
// slice that keyed the topic by the card id would spin a phantom, denied
// board topic whose digests never arrive, and only the engine's 20s
// durable poll would mask the bug. The mock-topic tests pin the right
// key and the per-card filtering; the fold tests can't see either.
import { foldTimelineBurst } from './board-fold';
import type { BoardTopicSnapshot, CardEventRow, CommentRow } from './boards';

/**
 * The timeline slice: the cold page from one fetch, then the topic's new
 * event rows for THIS card append through foldTimelineBurst (monotonic —
 * out-of-order arrivals skip; the engine's durable poll converges them,
 * the same bound the standalone producer kept).
 */
export function timelineSlice(input: {
  boardId: string;
  cardId: string;
  /** The topic accessor — called with the BOARD id. */
  topic: (boardId: string) => AsyncIterable<BoardTopicSnapshot>;
  fetchPage: (cardId: string) => Promise<CardEventRow[]>;
}): AsyncGenerator<CardEventRow[]> {
  return (async function* () {
    let page = await input.fetchPage(input.cardId);
    yield page;
    for await (const composite of await input.topic(input.boardId)) {
      if (composite.newEvents.length === 0) continue;
      const mine = composite.newEvents.filter((row) => row.card_id === input.cardId);
      if (mine.length === 0) continue;
      const folded = foldTimelineBurst(page, mine);
      if (folded) {
        page = folded;
        yield page;
      }
    }
  })();
}

/**
 * The comments slice: the cold page from one fetch, then the digest's
 * page for THIS card replaces it whenever the card's comments changed.
 */
export function commentsSlice(input: {
  boardId: string;
  cardId: string;
  /** The topic accessor — called with the BOARD id. */
  topic: (boardId: string) => AsyncIterable<BoardTopicSnapshot>;
  fetchPage: (cardId: string) => Promise<CommentRow[]>;
}): AsyncGenerator<CommentRow[]> {
  return (async function* () {
    let page = await input.fetchPage(input.cardId);
    yield page;
    for await (const composite of await input.topic(input.boardId)) {
      const digest = composite.commentPages[input.cardId];
      if (digest) {
        page = digest;
        yield page;
      }
    }
  })();
}

// The drop planner — where a dragged card lands, and how degenerate
// positions heal (board card #45's move bug: three cards tied at
// position 1 made every drop between them compute (1+1)/2 = 1 — the
// card JOINED the tie instead of landing between, then the fold's
// re-merge shuffled the tie's order seconds later: the "snap").
//
// The invariant the planner keeps: the position it returns is STRICTLY
// between the drop's neighbours — or the neighbours were tied/exhausted
// and the whole segment re-spreads across its surrounding gap, with the
// displaced cards carried as `heals` (extra move ops, one per card).
// Ties can therefore never form: every drop near one heals the list.
import type { CardView } from './boards';

export type DropPlan = {
  /** The moving card's new position — strictly ordered with its neighbours. */
  position: number;
  /** Cards whose positions must be rewritten to make room (the tied or
   *  exhausted segment's members, the moving card excluded). */
  heals: { cardId: string; position: number }[];
};

type Positioned = { id: string; list_id: string; position: number };

/**
 * Plan a drop of `movingCardId` at display index `toIndex` of `listId`.
 * `toIndex` counts the DOM cards of the list — INCLUDING the moving card
 * when it drags within its own list (that is what the column's geometry
 * measures); the planner removes it before finding neighbours.
 */
export function planDrop(
  cards: Positioned[] | CardView[],
  listId: string,
  toIndex: number,
  movingCardId: string,
): DropPlan {
  const full = (cards as Positioned[]).filter((card) => card.list_id === listId);
  const meAt = full.findIndex((card) => card.id === movingCardId);
  // Display order without the moving card; the drop index shifts by one
  // when the card drags past itself within the same list.
  const display = full.filter((card) => card.id !== movingCardId);
  const index = meAt >= 0 && meAt < toIndex ? toIndex - 1 : toIndex;

  const prev = display[index - 1];
  const next = display[index];

  // Empty list, or a drop before/after everything: anchors are free.
  if (!prev && !next) return { position: 1, heals: [] };
  if (!prev) {
    const half = next!.position / 2;
    if (half < next!.position) return { position: half, heals: [] };
    return heal(display, index, next!.position - 1, upperAnchor(display, index, next!.position));
  }
  if (!next) return { position: prev.position + 1, heals: [] };

  const mid = (prev.position + next.position) / 2;
  if (mid > prev.position && mid < next.position) {
    return { position: mid, heals: [] };
  }
  // Degenerate: the neighbours are tied (or the gap has been halved down
  // to float precision). Re-spread the segment between the nearest
  // distinct anchors, the moving card included at its drop slot.
  return heal(
    display,
    index,
    lowerAnchor(display, index, prev.position),
    upperAnchor(display, index, next.position),
  );
}

/** The nearest position strictly below the drop's segment, or a free one. */
function lowerAnchor(display: Positioned[], index: number, at: number): number {
  for (let i = index - 1; i >= 0; i--) {
    if (display[i]!.position < at) return display[i]!.position;
  }
  return at - 1;
}

/** The nearest position strictly above the drop's segment, or a free one. */
function upperAnchor(display: Positioned[], index: number, at: number): number {
  for (let i = index; i < display.length; i++) {
    if (display[i]!.position > at) return display[i]!.position;
  }
  return at + 1;
}

/**
 * Re-spread the cards strictly between the anchors across the gap, with
 * the moving card dropped into its slot: n slots, evenly spaced, all
 * strictly distinct and strictly ordered.
 */
function heal(display: Positioned[], index: number, lower: number, upper: number): DropPlan {
  // The segment: every card whose position sits strictly between the
  // anchors, in display order — the order the user sees and drops into.
  const segment: Positioned[] = [];
  for (const card of display) {
    if (card.position > lower && card.position < upper) segment.push(card);
  }
  // The moving card enters after display[index-1] (or at the segment's
  // start when dropping above it): its slot among the segment.
  const insertAfter = display[index - 1];
  const slot = insertAfter ? segment.findIndex((card) => card.id === insertAfter.id) + 1 : 0;
  const count = segment.length + 1;
  const spread = (s: number) => lower + ((upper - lower) * (s + 1)) / (count + 1);
  const position = spread(slot);
  const heals: { cardId: string; position: number }[] = [];
  for (let s = 0, i = 0; s < count; s++) {
    if (s === slot) continue;
    heals.push({ cardId: segment[i]!.id, position: spread(s) });
    i++;
  }
  return { position, heals };
}

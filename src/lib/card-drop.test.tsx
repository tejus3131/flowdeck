// Drop planner tests — the move bug on the Flowdeck changes board: three
// cards tied at position 1 made a drop between them compute (1+1)/2 = 1,
// joining the tie instead of landing between (the card "snapped" into
// place seconds later when the fold re-shuffled the tie's order).
// The planner's contract: the returned position is STRICTLY between the
// drop's neighbours — or the degenerate segment heals, spread evenly
// across its surrounding gap with every displaced card carried out.
import { describe, expect, it } from 'vitest';

import { planDrop } from './card-drop';

const cards = (listId: string, positions: number[], prefix = 'c') =>
  positions.map((position, i) => ({ id: `${prefix}${i + 1}`, list_id: listId, position }));

describe('planDrop', () => {
  it('healthy gaps take the midpoint — one row, no heals', () => {
    const list = cards('l1', [1, 2, 4]);
    expect(planDrop(list, 'l1', 2, 'from-elsewhere')).toEqual({ position: 3, heals: [] });
    expect(planDrop(list, 'l1', 1, 'from-elsewhere')).toEqual({ position: 1.5, heals: [] });
    expect(planDrop(list, 'l1', 0, 'from-elsewhere')).toEqual({ position: 0.5, heals: [] });
    expect(planDrop(list, 'l1', 3, 'from-elsewhere')).toEqual({ position: 5, heals: [] });
  });

  it('an empty list drops at 1', () => {
    expect(planDrop(cards('l1', []), 'l1', 0, 'x')).toEqual({ position: 1, heals: [] });
  });

  it('THE BUG: a drop inside a tie run heals the run, not joins it', () => {
    // The live board's To do list: three cards at position 1, next at 2.
    // Dropping between the 2nd and 3rd tied cards used to produce
    // (1+1)/2 = 1 — a fourth tie. Now the run re-spreads across (0, 2).
    const list = [
      { id: 'a', list_id: 'l1', position: 1 },
      { id: 'b', list_id: 'l1', position: 1 },
      { id: 'c', list_id: 'l1', position: 1 },
      { id: 'd', list_id: 'l1', position: 2 },
    ];
    const plan = planDrop(list, 'l1', 2, 'moving');
    // Everything ends strictly ordered and distinct.
    const all = [
      ...plan.heals.map((h) => ({ id: h.cardId, position: h.position })),
      { id: 'moving', position: plan.position },
    ];
    expect(all).toHaveLength(4);
    const positions = all.map((row) => row.position).sort((a, b) => a - b);
    expect(new Set(positions).size).toBe(4); // no ties remain
    expect(positions.every((p) => p > 0 && p < 2)).toBe(true); // inside the gap
    // Display order preserved: a, b, [moving between b and c], c, d.
    const order = (id: string) => all.find((row) => row.id === id)!.position;
    expect(order('a')).toBeLessThan(order('b'));
    expect(order('b')).toBeLessThan(order('moving'));
    expect(order('moving')).toBeLessThan(order('c'));
    // d keeps its position 2 (outside the healed segment).
    expect(plan.heals.find((h) => h.cardId === 'd')).toBeUndefined();
  });

  it('a drop at the very top of a tied run takes the free gap below it', () => {
    const list = [
      { id: 'a', list_id: 'l1', position: 1 },
      { id: 'b', list_id: 'l1', position: 1 },
    ];
    const plan = planDrop(list, 'l1', 0, 'moving');
    // Before the run there is room: 0.5 — strictly less than the tie,
    // so the drop lands above the cluster without joining it.
    expect(plan).toEqual({ position: 0.5, heals: [] });
  });

  it('an exhausted gap (halved to float precision) heals instead of tying', () => {
    const list = [
      { id: 'a', list_id: 'l1', position: 1 },
      { id: 'b', list_id: 'l1', position: 1.0000000000000002 },
      { id: 'c', list_id: 'l1', position: 1.0000000000000004 },
      { id: 'd', list_id: 'l1', position: 3 },
    ];
    const plan = planDrop(list, 'l1', 2, 'moving'); // between b and c
    const all = [...plan.heals, { id: 'moving', position: plan.position }];
    expect(all).toHaveLength(3); // b, moving, c — a and d sit outside
    expect(plan.heals.find((h) => h.cardId === 'a')).toBeUndefined();
    expect(plan.heals.find((h) => h.cardId === 'd')).toBeUndefined();
    const positions = all.map((row) => row.position).sort((x, y) => x - y);
    expect(new Set(positions).size).toBe(3);
  });

  it('dragging within the same list excludes the dragged card from the neighbours', () => {
    // [m(1), a(2), b(4)] — dropping m after a (DOM index 2): the display
    // list without m is [a, b], the drop lands between a and b → 3.
    const list = [
      { id: 'm', list_id: 'l1', position: 1 },
      { id: 'a', list_id: 'l1', position: 2 },
      { id: 'b', list_id: 'l1', position: 4 },
    ];
    expect(planDrop(list, 'l1', 2, 'm')).toEqual({ position: 3, heals: [] });
    // Dropping m at the top (DOM index 0): display [a, b], before a(2).
    expect(planDrop(list, 'l1', 0, 'm')).toEqual({ position: 1, heals: [] });
  });

  it('other lists never interfere', () => {
    const list = cards('l1', [1, 2]);
    list.push(...cards('l2', [1, 1, 5]));
    expect(planDrop(list, 'l1', 1, 'x')).toEqual({ position: 1.5, heals: [] });
  });
});

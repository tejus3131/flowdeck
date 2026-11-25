import { describe, expect, it } from 'vitest';
import { pageSlices } from './tags';

describe('pageSlices', () => {
  it('a window under the ceiling is one slice', () => {
    expect(pageSlices(30)).toEqual([{ offset: 0, limit: 30 }]);
  });

  it('exactly the ceiling is one full slice', () => {
    expect(pageSlices(100)).toEqual([{ offset: 0, limit: 100 }]);
  });

  it('past the ceiling walks consecutive slices with a short tail', () => {
    expect(pageSlices(150)).toEqual([
      { offset: 0, limit: 100 },
      { offset: 100, limit: 50 },
    ]);
  });

  it('a deep feed keeps its depth — no snap-back', () => {
    expect(pageSlices(370)).toEqual([
      { offset: 0, limit: 100 },
      { offset: 100, limit: 100 },
      { offset: 200, limit: 100 },
      { offset: 300, limit: 70 },
    ]);
  });

  it('nothing loaded is nothing to fetch', () => {
    expect(pageSlices(0)).toEqual([]);
  });
});

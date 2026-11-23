// Perf mark tests: the recorder contract the debug panel relies on —
// durations land, once per open, capped, and stream wrappers close their
// marks exactly once (first value or failure, never both).
import { afterEach, describe, expect, it } from 'vitest';

import {
  perfCancel,
  perfClear,
  perfEnd,
  perfFirstValue,
  perfInFlight,
  perfStart,
  perfStats,
  perfTrack,
} from './perf';

const stat = (label: string) => perfStats().find((row) => row.label === label);

async function* stream<T>(...values: T[]): AsyncGenerator<T> {
  for (const value of values) yield value;
}

describe('perf marks', () => {
  afterEach(() => {
    perfClear();
  });

  it('records a duration for a start/end pair', () => {
    perfStart('t-pair');
    const ms = perfEnd('t-pair');
    expect(ms).not.toBeNull();
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(stat('t-pair')).toMatchObject({ count: 1 });
    expect(stat('t-pair')!.last).toBe(ms);
    expect(perfInFlight()).toEqual([]);
  });

  it('cancels an open mark without recording (an abandoned open is not a sample)', () => {
    const token = perfStart('t-cancel');
    expect(perfInFlight()).toContain('t-cancel');
    perfCancel('t-cancel', token);
    expect(stat('t-cancel')).toBeUndefined();
    expect(perfInFlight()).toEqual([]);
  });

  it('ignores an end without a start', () => {
    expect(perfEnd('t-orphan')).toBeNull();
    expect(stat('t-orphan')).toBeUndefined();
  });

  it('replaces a dangling start: the newest open wins, stale ends no-op', () => {
    const stale = perfStart('t-overwrite');
    const live = perfStart('t-overwrite');
    // The displaced open's completion must not consume the live mark.
    expect(perfEnd('t-overwrite', stale)).toBeNull();
    expect(perfInFlight()).toContain('t-overwrite');
    expect(perfEnd('t-overwrite', live)).not.toBeNull();
    expect(perfEnd('t-overwrite')).toBeNull();
    expect(stat('t-overwrite')!.count).toBe(1);
  });

  it('a stale tracked fetch cannot consume a newer open (the timeline race)', async () => {
    let resolveFirst: (value: number) => void = () => {};
    const first = perfTrack('t-race', () => new Promise<number>((resolve) => {
      resolveFirst = resolve;
    }));
    // The user closes and reopens before the first fetch resolves: the
    // second open replaces the mark, then resolves.
    const second = perfTrack('t-race', () => Promise.resolve(2));
    await second;
    // NOW the first (stale) fetch resolves — it must record nothing.
    resolveFirst(1);
    await first;
    expect(stat('t-race')!.count).toBe(1);
  });

  it('tracks a promise and passes its value through', async () => {
    const value = await perfTrack('t-track', async () => 42);
    expect(value).toBe(42);
    expect(stat('t-track')).toMatchObject({ count: 1 });
  });

  it('records a failed track too (slow failures are slow opens)', async () => {
    await expect(perfTrack('t-fail', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(stat('t-fail')).toMatchObject({ count: 1 });
  });

  it('marks a stream at its first value, once', async () => {
    const wrapped = perfFirstValue(stream(1, 2, 3), 't-stream');
    const seen: number[] = [];
    for await (const value of wrapped) seen.push(value);
    expect(seen).toEqual([1, 2, 3]);
    expect(stat('t-stream')).toMatchObject({ count: 1 });
    expect(perfInFlight()).toEqual([]);
  });

  it('a stream finalizer after the first value records nothing more', async () => {
    const wrapped = perfFirstValue(stream(1), 't-late-final');
    const iterator = wrapped[Symbol.asyncIterator]();
    await iterator.next(); // first value → the mark closed
    await iterator.return?.(); // late finalizer → must be a no-op
    expect(stat('t-late-final')!.count).toBe(1);
  });

  it('a stale stream finalizer cannot consume a newer open', async () => {
    const old = perfFirstValue(stream(1), 't-stream-race');
    const oldIterator = old[Symbol.asyncIterator]();
    await oldIterator.next(); // old's own open records
    const fresh = perfFirstValue(stream(5), 't-stream-race');
    const freshIterator = fresh[Symbol.asyncIterator]();
    await freshIterator.next(); // fresh records — two legit opens so far
    await oldIterator.return?.(); // old's LATE finalizer → must not record
    expect(stat('t-stream-race')!.count).toBe(2);
  });

  it('marks a stream that dies before its first value', async () => {
    const dead = {
      // eslint-disable-next-line require-yield -- fixture: throws before any value
      async *[Symbol.asyncIterator]() {
        throw new Error('dead');
      },
    };
    const wrapped = perfFirstValue(dead, 't-dead');
    await expect(async () => {
      for await (const value of wrapped) void value;
    }).rejects.toThrow('dead');
    expect(stat('t-dead')).toMatchObject({ count: 1 });
  });

  it('leaves a never-started stream open (diagnosable as in-flight)', async () => {
    const wrapped = perfFirstValue(stream(1), 't-abandoned');
    const iterator = wrapped[Symbol.asyncIterator]();
    // return() before the first next() never enters the body, so no end
    // mark runs — the open stays visible in perfInFlight, which is the
    // honest signal (a source created but never iterated).
    await iterator.return?.();
    expect(stat('t-abandoned')).toBeUndefined();
    expect(perfInFlight()).toContain('t-abandoned');
  });

  it('caps the buffer per label at 100 samples', () => {
    for (let i = 0; i < 130; i++) {
      perfStart('t-cap');
      perfEnd('t-cap');
    }
    expect(stat('t-cap')!.count).toBe(100);
  });

  it('keeps the distribution ordered: p50 ≤ p95 ≤ max', () => {
    // Durations are scheduling-dependent (~0ms each), so the assertion is
    // the invariant the panel relies on: the quantiles are non-decreasing
    // and never exceed the max, whatever the window holds.
    for (let i = 0; i < 20; i++) {
      perfStart('t-quantile');
      perfEnd('t-quantile');
    }
    const row = stat('t-quantile')!;
    expect(row.count).toBe(20);
    expect(row.max).toBeGreaterThanOrEqual(row.p95);
    expect(row.p95).toBeGreaterThanOrEqual(row.p50);
    expect(row.p50).toBeGreaterThanOrEqual(0);
  });

  it('clear drops everything', () => {
    perfStart('t-clear');
    perfEnd('t-clear');
    perfClear();
    expect(perfStats()).toEqual([]);
  });
});

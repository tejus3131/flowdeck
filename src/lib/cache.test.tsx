// Client cache tests — the stale-while-revalidate contract: the seed
// paints instantly and is replaced by live truth, every live value warms
// the next open, and the store stays bounded (LRU + TTL). jsdom has no
// IndexedDB, so these run against the in-memory fallback — the IndexedDB
// wrapper is the same logic with a real store behind it.
import { afterEach, describe, expect, it } from 'vitest';

import { __testAge, cacheClear, cacheGet, cachePut, cacheSetUser, cachedStream } from './cache';
import { perfStats } from './perf';

/** cachePut is fire-and-forget by design; tests wait a macrotask so every
 *  pending write (and any sweep it triggered) has landed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

async function* stream<T>(...values: T[]): AsyncGenerator<T> {
  for (const value of values) yield value;
}

describe('client cache', () => {
  afterEach(async () => {
    cacheClear();
    cacheSetUser('');
    await settle();
  });

  it('round-trips a value', async () => {
    cachePut('k', { a: 1 });
    await settle();
    expect(await cacheGet<{ a: number }>('k')).toEqual({ a: 1 });
  });

  it('misses read as null', async () => {
    expect(await cacheGet('nope')).toBeNull();
  });

  it('expires entries past the TTL (the read deletes them)', async () => {
    cachePut('old', 'v');
    await settle();
    await __testAge('old', 8 * 24 * 60 * 60 * 1000);
    expect(await cacheGet('old')).toBeNull();
  });

  it('evicts the stalest entries past the cap (LRU)', async () => {
    // 330 writes: the sweep at the 325th sees ≥325 entries and trims back
    // to the 300 freshest. The oldest 25 always age out; the exact 26th–
    // 30th depend on write interleaving, so the test pins the invariants.
    for (let i = 1; i <= 330; i++) cachePut(`k${i}`, i);
    await settle();
    expect(await cacheGet('k1')).toBeNull();
    expect(await cacheGet('k25')).toBeNull();
    expect(await cacheGet('k31')).toBe(31);
    expect(await cacheGet('k330')).toBe(330);
  });

  it('clear drops everything (sign-out)', async () => {
    cachePut('a', 1);
    cachePut('b', 2);
    await settle();
    cacheClear();
    await settle();
    expect(await cacheGet('a')).toBeNull();
    expect(await cacheGet('b')).toBeNull();
  });

  it('cachedStream: cold open yields live values and warms the cache', async () => {
    const seen: number[] = [];
    for await (const value of cachedStream('cs', () => stream(7, 8))) {
      seen.push(value);
    }
    expect(seen).toEqual([7, 8]);
    await settle(); // writes are fire-and-forget
    expect(await cacheGet<number>('cs')).toBe(8);
  });

  it('cachedStream: warm open seeds the cached page first, live revalidates', async () => {
    for await (const value of cachedStream('cs2', () => stream(7, 8))) void value;
    await settle();
    const seen: number[] = [];
    for await (const value of cachedStream('cs2', () => stream(9))) seen.push(value);
    // The cached 8 paints immediately, then the live 9 replaces it — and
    // the cache now holds the live truth.
    expect(seen).toEqual([8, 9]);
    await settle();
    expect(await cacheGet<number[]>('cs2')).toBe(9);
  });

  it('scopes every key to the current user (stale sessions cannot leak)', async () => {
    cacheSetUser('u1');
    cachePut('k', 'v1');
    await settle();
    cacheSetUser('u2');
    expect(await cacheGet('k')).toBeNull(); // u2 cannot read u1's entry
    cacheSetUser('u1');
    expect(await cacheGet('k')).toBe('v1'); // untouched for u1
  });

  it('cachedStream: liveMark ends at the first live value', async () => {
    const seen: number[] = [];
    for await (const value of cachedStream('cs4', () => stream(5), 'cs-live')) {
      seen.push(value);
    }
    expect(seen).toEqual([5]);
    const mark = perfStats().find((row) => row.label === 'cs-live');
    expect(mark).toMatchObject({ count: 1 });
  });

  it('cachedStream: a source error propagates after any seed', async () => {
    cachePut('cs3', 'cached');
    await settle();
    const seen: string[] = [];
    await expect(async () => {
      for await (const value of cachedStream<string>('cs3', () => {
        throw new Error('source died');
      })) {
        seen.push(value);
      }
    }).rejects.toThrow('source died');
    expect(seen).toEqual(['cached']);
  });
});

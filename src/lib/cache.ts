// The Phase 1 client cache — the read-side half of the performance plan
// (docs/performance.md). One small store per device, stale-while-revalidate
// on every open path:
//
//   open  → paint from cache instantly; the live producer revalidates
//   live  → every yielded value refreshes the cache, so the next open
//           is warm (and other viewers' changes land in the cache with it)
//
// The rules it keeps (docs/performance-rules.md, "Cache hygiene"):
//   * never blocks the open — reads are ~1 ms, writes are fire-and-forget
//   * never grows unbounded — LRU by last-write plus a TTL for abandoned
//     keys (revoked boards, deleted cards age out)
//   * never breaks the app — every failure path degrades to "no cache"
//
// Storage: IndexedDB when the browser has it, an in-memory Map otherwise
// (old browsers; jsdom). On the server everything is a no-op — the cache
// is about what the BROWSER waits for.
import { isServer } from '@solidjs/web';

const DB_NAME = 'flowdeck-cache';
const STORE = 'entries';
/** Bump to wipe every cached entry on upgrade (shapes change with it). */
const VERSION = 1;

/** Entries kept before the LRU sweep starts deleting the stalest. */
const MAX_ENTRIES = 300;
/** An entry older than this reads as a miss (and is deleted). */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** LRU sweeps run every Nth write — cheap amortized, never per-write. */
const SWEEP_EVERY = 25;

type Entry = { at: number; value: unknown };

interface Backend {
  get(key: string): Promise<Entry | null>;
  put(key: string, entry: Entry): Promise<void>;
  delete(key: string): Promise<void>;
  all(): Promise<{ key: string; at: number }[]>;
  clear(): Promise<void>;
}

// ── in-memory fallback ───────────────────────────────────────────────────

function memoryBackend(): Backend {
  const map = new Map<string, Entry>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, entry) {
      map.set(key, entry);
    },
    async delete(key) {
      map.delete(key);
    },
    async all() {
      return [...map].map(([key, entry]) => ({ key, at: entry.at }));
    },
    async clear() {
      map.clear();
    },
  };
}

// ── IndexedDB backend ────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        // A version bump wipes: cached shapes are not migrated, they are
        // refetched — that is the whole point of revalidation.
        for (const name of Array.from(db.objectStoreNames)) {
          db.deleteObjectStore(name);
        }
        db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      // A cache that fails to open is no cache — never an app failure.
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }
  return dbPromise;
}

function idbBackend(): Promise<Backend> {
  return openDb().then((db) => {
    if (!db) return memoryBackend();
    const withStore = <T>(
      mode: IDBTransactionMode,
      work: (store: IDBObjectStore) => IDBRequest | null,
      collect: (request: IDBRequest | null) => T,
    ): Promise<T> =>
      new Promise((resolve) => {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(collect(request));
        tx.onabort = tx.onerror = () => resolve(collect(null));
      });
    return {
      get(key) {
        return withStore<Entry | null>(
          'readonly',
          (store) => store.get(key),
          (request) => (request?.result as Entry | undefined) ?? null,
        );
      },
      put(key, entry) {
        return withStore<void>('readwrite', (store) => store.put(entry, key), () => {});
      },
      delete(key) {
        return withStore<void>('readwrite', (store) => store.delete(key), () => {});
      },
      all() {
        // The LRU sweep's walk: every key with its write time. Capped at
        // MAX_ENTRIES, so this stays small even in the worst case.
        return new Promise((resolve) => {
          const rows: { key: string; at: number }[] = [];
          const tx = db.transaction(STORE, 'readonly');
          const request = tx.objectStore(STORE).openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
              rows.push({ key: String(cursor.key), at: (cursor.value as Entry).at });
              cursor.continue();
            }
          };
          tx.oncomplete = () => resolve(rows);
          tx.onabort = tx.onerror = () => resolve(rows);
        });
      },
      clear() {
        return withStore<void>('readwrite', (store) => store.clear(), () => {});
      },
    };
  });
}

// ── the public surface ──────────────────────────────────────────────────

let backendPromise: Promise<Backend> | null = null;
let writes = 0;

function backend(): Promise<Backend> {
  // On the server there is no cache — every call no-ops (the callers'
  // seeds read null, their writes vanish).
  if (isServer) return Promise.resolve(memoryBackend());
  if (!backendPromise) backendPromise = idbBackend();
  return backendPromise;
}

/** Read a cached value. A miss (or an entry past its TTL) is null —
 *  the caller paints nothing and the live producer serves as before. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const store = await backend();
  const entry = await store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    void store.delete(key);
    return null;
  }
  return entry.value as T;
}

/** Fire-and-forget write: never blocks, never throws. Every Nth write an
 *  LRU sweep trims the stalest entries past MAX_ENTRIES. */
export function cachePut(key: string, value: unknown): void {
  void (async () => {
    const store = await backend();
    await store.put(key, { at: Date.now(), value });
    writes++;
    if (writes % SWEEP_EVERY === 0) {
      const entries = await store.all();
      if (entries.length > MAX_ENTRIES) {
        entries.sort((a, b) => a.at - b.at);
        for (const victim of entries.slice(0, entries.length - MAX_ENTRIES)) {
          await store.delete(victim.key);
        }
      }
    }
  })();
}

/** Drop one key (deletions can retire their cache entry eagerly). */
export function cacheDelete(key: string): void {
  void (async () => {
    const store = await backend();
    await store.delete(key);
  })();
}

/** Drop everything — the sign-out path: no cached data outlives the
 *  session on a shared device. */
export function cacheClear(): void {
  void (async () => {
    const store = await backend();
    await store.clear();
  })();
}

/** Ask the browser not to evict us under storage pressure (best-effort,
 *  once per session). */
export function cachePersist(): void {
  if (isServer) return;
  try {
    void navigator.storage?.persist?.()?.catch(() => {});
  } catch {
    // Storage API blocked — the cache stays best-effort.
  }
}

/** Test-only: age a stored entry past the TTL without waiting a week. */
export async function __testAge(key: string, byMs: number): Promise<void> {
  const store = await backend();
  const entry = await store.get(key);
  if (entry) await store.put(key, { ...entry, at: entry.at - byMs });
}

// ── the stale-while-revalidate wrapper ─────────────────────────────────

/**
 * Wrap a live stream source with the cache (docs/performance.md, layer 1):
 * a cached page — when one exists — yields FIRST so the engine's view
 * paints instantly, then every live value revalidates the view AND
 * refreshes the cache. The engine's merge reconciles the two (guards
 * protect in-flight ops; live rows replace cached rows), which is exactly
 * the "open from cache, refetch on open, verify" behavior card #45 asks
 * for. Cold opens (no cache) behave exactly like the unwrapped stream.
 */
export function cachedStream<S>(
  key: string,
  source: () => AsyncIterable<S> | Promise<AsyncIterable<S>>,
): AsyncIterable<S> {
  return {
    async *[Symbol.asyncIterator]() {
      const cached = await cacheGet<S>(key);
      if (cached !== null) yield cached;
      const iterable = await source();
      for await (const value of iterable) {
        cachePut(key, value);
        yield value;
      }
    },
  };
}

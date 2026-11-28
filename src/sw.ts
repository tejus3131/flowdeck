/// <reference lib="webworker" />
/* Orbit service worker — the offline shell + the notification half of
 * the PWA. *
 * Five jobs:
 *  1. `install`: precache this build's hashed assets (cache-first later —
 *     the URL hash is the cache key, so a new build is a new key).
 *  2. `activate`: sweep every cache not in EXPECTED_CACHES, then wait for
 *     the page's go-ahead — this worker NEVER takes control on its own
 *     (no skipWaiting): the page decides when to apply an update, because
 *     the outbox may hold unsynced edits (see lib/sw-update.ts).
 *  3. `fetch`: navigations are network-first with a cached-shell fallback
 *     allowlisted to app routes only; hashed assets are cache-first; the
 *     image cache (board card #51) stays stale-while-revalidate. Responses
 *     marked `cache-control: no-store` are never cached.
 *  4. `push` / `notificationclick` / `pushsubscriptionchange`: carried
 *     over unchanged from the notification-only worker (push shipped
 *     first) — same payloads, same `orbit-navigate` / `orbit-resubscribe`
 *     postMessage protocol.
 *  5. `message`: the page-driven update protocol — SKIP_WAITING on the
 *     page's explicit request, and an outbox-drained notice so a waiting
 *     update applies as soon as edits are safe.
 *
 * The update contract lives in src/lib/sw-update.ts (the page half); the
 * cache-name version and the asset manifest are stamped at build time by
 * the Vite plugin (vite.config.ts) — this file is the template they are
 * written into.
 */

// The DOM lib's `self: Window` declaration and the webworker lib's
// `self: WorkerGlobalScope` collide in a global script; the SW scope is
// the worker one. (The file has no imports — this export makes it a
// module so the declaration below wins.)
export {};
declare const self: ServiceWorkerGlobalScope;

// ── build-time stamps (the Vite plugin replaces these tokens) ────────────
const CACHE_VERSION = '__FD_SW_VERSION__';
const PRECACHE_URLS = JSON.parse('__FD_PRECACHE_MANIFEST__') as string[];

// ── caches ───────────────────────────────────────────────────────────────
// Version-scoped: a new build gets a new shell cache; activate deletes
// every cache outside the allowlist (the old shell cache goes with it).
const SHELL_CACHE = `orbit-shell-${CACHE_VERSION}`;
const IMAGE_CACHE = 'orbit-images-v1';
const EXPECTED_CACHES = [SHELL_CACHE, IMAGE_CACHE];

/** The cached-shell fallback answers ONLY these navigations. Everything
 *  else (sign-in, auth callbacks, invites, API, MCP) is network-only —
 *  the shell is user-agnostic markup, but serving it for an auth page
 *  would mask a real failure, and authed HTML is never cached.
 *  Keep in step with src/lib/sw-update.ts's isAppRoute (the page half
 *  uses the same list for its update checks). */
const APP_ROUTE_PREFIXES = ['/b/', '/w/', '/u/', '/profile', '/search'];
const APP_ROUTE_EXACT = ['/'];

/** The offline last resort — a static document in the precache. */
const OFFLINE_URL = '/offline.html';

// ── install: precache the build ──────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll fails the whole install if one URL misses — the manifest
      // is generated from the build output, so a miss is a build bug we
      // want to see; the old worker keeps serving meanwhile.
      await cache.addAll([...PRECACHE_URLS, OFFLINE_URL]);
      // The offline fallback must answer navigations even when the
      // server rendered it with a redirect or a query — normalize.
      await cache.put(OFFLINE_URL, (await cache.match(OFFLINE_URL))!);
    })(),
  );
});

// ── activate: sweep stale caches, then WAIT ──────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !EXPECTED_CACHES.includes(name)).map((name) => caches.delete(name)),
      );
      // No clients.claim(), no skipWaiting() — the page applies the
      // update (lib/sw-update.ts): next navigation when the outbox is
      // empty, after drain or explicit consent when edits are pending.
    })(),
  );
});

// ── the page-driven update protocol ──────────────────────────────────────
self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === 'orbit-skip-waiting') {
    // The page's explicit apply (outbox empty, or the user chose
    // "Update now"). The reload itself happens on the page's
    // controllerchange handler — once, guarded there.
    self.skipWaiting();
  } else if (data?.type === 'orbit-outbox-drained') {
    // The outbox just emptied while an update was waiting: the page
    // applies on its next navigation (it owns that decision); nothing
    // to do here beyond acknowledging — kept as a protocol hook so the
    // worker can later prefetch the new build's assets while waiting.
  }
});

// ── fetch: the three surfaces ────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }
  // Hashed build assets (JS/CSS/fonts under /assets/) are immutable —
  // cache-first. Everything else non-image takes the network untouched.
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }
  // Images only for the SWR cache — <img> loads everywhere in the app
  // (avatars, icons). Everything else takes the default network path.
  if (request.destination !== 'image') return;
  event.respondWith(staleWhileRevalidateImage(request));
});

/** Network-first for navigations: fresh HTML when online, the cached
 *  shell for app routes when offline, offline.html as the last resort.
 *  Never caches authed HTML — the fallback is the precached shell, and
 *  only for the allowlisted app routes. */
async function handleNavigation(request: Request): Promise<Response> {
  // Network-only paths: auth surfaces, invites, API, MCP. A cached
  // answer here would mask a real failure (or leak a shell where the
  // server must decide).
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    const path = url.pathname;
    if (
      path.startsWith('/sign-in') ||
      path.startsWith('/auth') ||
      path.startsWith('/invite') ||
      path.startsWith('/api/') ||
      path.startsWith('/mcp') ||
      path.startsWith('/connection') ||
      path.startsWith('/docs') ||
      path.startsWith('/playground') ||
      path.startsWith('/legal') ||
      path.startsWith('/contact') ||
      path.startsWith('/.well-known')
    ) {
      return networkOnly(request);
    }
  }
  try {
    // Navigation preload is deliberately NOT enabled: with an HTML
    // fallback in play, the preload's parallel request would race the
    // cache answer we can already serve (Workbox's guidance for SWs
    // that can answer navigations themselves).
    const response = await fetch(request);
    // Successful HTML navigations are NOT cached (SSR renders per user;
    // the shell fallback is the precached offline document instead).
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const path = url.pathname;
    const isAppRoute =
      url.origin === self.location.origin &&
      (APP_ROUTE_EXACT.includes(path) || APP_ROUTE_PREFIXES.some((p) => path.startsWith(p)));
    if (isAppRoute) {
      // The precached shell: user-agnostic markup; the entity store
      // (IndexedDB) rehydrates the board, the outbox replays edits.
      // The document is stored under its literal URL (/index.html —
      // Cache API keys are exact), so the '/' lookup must use the
      // stored key, not the request path.
      const shell =
        (await cache.match('/index.html')) ??
        (await cache.match(OFFLINE_URL)) ??
        (await cache.match(request));
      if (shell) return shell;
    }
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    // Nothing cached at all (first visit, never online): an honest
    // network error — the browser's own offline page.
    throw new Error('offline and no cached shell');
  }
}

async function networkOnly(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch (error) {
    // For navigations on network-only paths, offline.html is still the
    // honest answer (better than the browser's dinosaur).
    if (request.mode === 'navigate') {
      const cache = await caches.open(SHELL_CACHE);
      const offline = await cache.match(OFFLINE_URL);
      if (offline) return offline;
    }
    throw error;
  }
}

/** Cache-first for immutable hashed assets. */
async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) {
    await cache.put(request, response.clone());
  }
  return response;
}

/** SvelteKit's rule: a `no-store` response must never enter Cache
 *  Storage (it would defeat the header's contract). */
function isCacheable(response: Response): boolean {
  if (!response.ok && response.type !== 'opaque') return false;
  const control = response.headers.get('cache-control') ?? '';
  return !control.includes('no-store');
}

// ── the image cache (board card #51) — carried over unchanged ────────────
//
// The same avatar URL renders in the nav, boards, member lists, chats and
// cursors — without a cache each render re-fetches it. Strategy: cache-first
// with a background refresh (stale-while-revalidate, the same posture as
// the app's data cache, docs/performance.md):
//
//   * hit  → the cached bytes answer instantly; a fetch refreshes the
//     entry behind it, so an updated picture replaces itself even when
//     its URL didn't change
//   * miss → fetch, cache, respond
//   * an avatar UPLOAD changes the stored URL (a ?v= version param is
//     minted on upload), so a new picture is a new cache key — the old
//     entry ages out in the sweep
//
// Bounded like every cache here (docs/performance-rules.md, rule 11):
// TTL 7 days, at most MAX entries, swept every SWEEP_EVERY puts.
const IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_MAX_ENTRIES = 100;
const IMAGE_SWEEP_EVERY = 25;
let image_puts = 0;

/** Store a response with the cache's own recency stamp (Cache API entries
 *  carry no put time; a side header is the cheapest honest one). */
async function cacheImage(cache: Cache, request: Request, response: Response) {
  const headers = new Headers(response.headers);
  headers.set('x-fd-cached-at', String(Date.now()));
  await cache.put(
    request,
    new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }),
  );
  image_puts++;
  if (image_puts % IMAGE_SWEEP_EVERY === 0) await sweepImages(cache);
}

/** Drop TTL-aged entries and trim the store back to MAX (oldest first). */
async function sweepImages(cache: Cache) {
  const now = Date.now();
  const requests = await cache.keys();
  const entries: { request: Request; cachedAt: number }[] = [];
  for (const request of requests) {
    const hit = await cache.match(request);
    const cachedAt = hit ? Number(hit.headers.get('x-fd-cached-at') || 0) : now;
    if (now - cachedAt > IMAGE_TTL_MS) {
      await cache.delete(request);
    } else {
      entries.push({ request, cachedAt });
    }
  }
  if (entries.length > IMAGE_MAX_ENTRIES) {
    entries.sort((a, b) => a.cachedAt - b.cachedAt);
    for (const victim of entries.slice(0, entries.length - IMAGE_MAX_ENTRIES)) {
      await cache.delete(victim.request);
    }
  }
}

async function staleWhileRevalidateImage(request: Request): Promise<Response> {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    const age = Date.now() - Number(cached.headers.get('x-fd-cached-at') || 0);
    if (age > IMAGE_TTL_MS) {
      // Past its life: answer from cache anyway (never block on the
      // network), but let the refresh below replace it.
      void cache.delete(request);
    }
    // The background refresh — serve first, converge after.
    void fetch(request)
      .then(async (response) => {
        if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
          const stored = response.clone();
          await cacheImage(cache, request, stored);
        }
      })
      .catch(() => {});
    return cached;
  }
  // Miss: fetch, cache the good ones, answer either way. A network
  // failure here is an honest failure for the <img> (it renders its
  // alt/fallback like today) — no catch, the rejection is the answer.
  const response = await fetch(request);
  if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
    const stored = response.clone();
    await cacheImage(cache, request, stored);
  }
  return response;
}

// ── push — carried over unchanged (push shipped first) ───────────────────
self.addEventListener('push', (event) => {
  type PushPayload = { title?: string; body?: string; url?: string; tag?: string };
  let payload: PushPayload = {};
  try {
    payload = event.data ? (event.data.json() as PushPayload) : {};
  } catch {
    payload = {};
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Orbit', {
      body: payload.body || '',
      tag: payload.tag || 'orbit',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) {
          await client.focus();
          client.postMessage({ type: 'orbit-navigate', url });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// The push endpoint rotated (browser policy) — ask a live tab to
// re-subscribe and re-save the endpoint.
self.addEventListener('pushsubscriptionchange', () => {
  void self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    for (const client of windows) client.postMessage({ type: 'orbit-resubscribe' });
  });
});

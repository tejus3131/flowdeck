/* Flowdeck service worker — the notification half of the PWA.
 *
 * Three jobs:
 *  1. `push`: web-push payloads (sent by the server when a notification row
 *     is created) become real OS notifications, even with no tab open.
 *  2. `notificationclick`: focus an open window and navigate it to the
 *     notification's target, or open one at the right URL.
 *  3. `fetch`: a stale-while-revalidate cache for images (board card #51)
 *     — the same avatar rendered in a dozen places loads once, and a
 *     picture update refreshes the entry in the background.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  /** @type {{ title?: string, body?: string, url?: string, tag?: string }} */
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Flowdeck', {
      body: payload.body || '',
      tag: payload.tag || 'flowdeck',
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
          client.postMessage({ type: 'fd-navigate', url });
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
    for (const client of windows) client.postMessage({ type: 'fd-resubscribe' });
  });
});

// ── the image cache (board card #51) ──────────────────────────────────────
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
const IMAGE_CACHE = 'flowdeck-images-v1';
const IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_MAX_ENTRIES = 100;
const IMAGE_SWEEP_EVERY = 25;
let image_puts = 0;

/** Store a response with the cache's own recency stamp (Cache API entries
 *  carry no put time; a side header is the cheapest honest one). */
async function cacheImage(cache, request, response) {
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
async function sweepImages(cache) {
  const now = Date.now();
  const requests = await cache.keys();
  const entries = [];
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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Images only — <img> loads everywhere in the app (avatars, icons).
  // Everything else takes the default network path untouched.
  if (request.method !== 'GET' || request.destination !== 'image') return;
  event.respondWith(
    (async () => {
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
      // Miss: fetch, cache the good ones, answer either way.
      try {
        const response = await fetch(request);
        if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
          const stored = response.clone();
          await cacheImage(cache, request, stored);
        }
        return response;
      } catch (error) {
        // Nothing cached and the network is dead — an honest failure for
        // the <img> (it renders its alt/fallback like today).
        throw error;
      }
    })(),
  );
});

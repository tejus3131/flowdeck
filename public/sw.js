/* Flowdeck service worker — the notification half of the PWA.
 *
 * Two jobs:
 *  1. `push`: web-push payloads (sent by the server when a notification row
 *     is created) become real OS notifications, even with no tab open.
 *  2. `notificationclick`: focus an open window and navigate it to the
 *     notification's target, or open one at the right URL.
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

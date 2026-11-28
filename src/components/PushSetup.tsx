// Push setup: registers the service worker, offers the browser
// notification permission once (a small chip — the browser's own prompt
// does the asking), and keeps this browser's push subscription saved.
// With permission granted, notifications reach this machine even when
// Orbit isn't open.
import { Show, createSignal, onSettled } from 'solid-js';

import { getVapidPublicKey, savePushSubscription } from '../lib/push';
import { appName } from '../lib/brand';
import { wireSwUpdates } from '../lib/sw-update';

const PROMPT_KEY = 'orbit:push-prompt';

/** applicationServerKey: the VAPID public key as bytes. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(base64 + padding);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function PushSetup() {
  const [prompting, setPrompting] = createSignal(false);

  /** Subscribe (or re-confirm the existing subscription) with the server. */
  const syncSubscription = async (registration: ServiceWorkerRegistration) => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const key = await getVapidPublicKey().catch(() => null);
    if (!key) return; // push not configured — in-app only
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(key),
      }));
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;
    await savePushSubscription({
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    });
  };

  const enable = async () => {
    setPrompting(false);
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        const registration = await navigator.serviceWorker.register('/sw.js');
        await syncSubscription(registration);
      }
    } catch {
      // best effort — the chip returns on the next load if still 'default'
    }
  };

  const notNow = () => {
    try {
      localStorage.setItem(PROMPT_KEY, '1');
    } catch {
      // ignore
    }
    setPrompting(false);
  };

  onSettled(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // The update lifecycle (waiting worker → chip → guarded reload) wires
    // once per app load, alongside the registration this component owns.
    wireSwUpdates();
    // The worker reports endpoint rotation — re-subscribe and re-save.
    // Registered synchronously so onSettled can own the cleanup (the
    // async registration below can't use onCleanup).
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string };
      if (data?.type === 'orbit-resubscribe') {
        void navigator.serviceWorker
          .getRegistration()
          .then((registration) => (registration ? syncSubscription(registration) : undefined))
          .catch(() => {});
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js');
        if (typeof Notification !== 'undefined') {
          if (Notification.permission === 'granted') {
            await syncSubscription(registration);
          } else if (Notification.permission === 'default' && !localStorage.getItem(PROMPT_KEY)) {
            setPrompting(true);
          }
        }
      } catch {
        // registration failures never break the app
      }
    })();
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  });

  return (
    <Show when={prompting()}>
      <div class="fixed bottom-4 left-4 z-[60] flex w-72 flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-3 text-xs shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
        <p class="font-semibold">🔔 Stay in the loop</p>
        <p class="text-neutral-500 dark:text-neutral-400">
          Turn on notifications — mentions, assignments, and access requests find you even when
          {appName}
          is closed.
        </p>
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded-lg bg-indigo-600 px-2.5 py-1.5 font-semibold text-white hover:bg-indigo-500"
            onClick={() => void enable()}
          >
            Turn on
          </button>
          <button
            type="button"
            class="rounded-lg px-2.5 py-1.5 font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 dark:text-neutral-300"
            onClick={notNow}
          >
            Not now
          </button>
        </div>
      </div>
    </Show>
  );
}

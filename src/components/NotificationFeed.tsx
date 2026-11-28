// The notification feed: the live inbox that follows the user around.
// Fresh rows become toasts (with a chime) on whatever screen they're on;
// clicking navigates to the row's target and marks it read. When the tab
// is hidden they surface as service-worker notifications (OS level, with
// click-through); with the site fully closed the server's web push plays
// the same role. Access requests carry Grant/Deny actions right on the
// toast. The dashboard's Updates strip and /notifications read the same
// shared live query.
import { For, Show, createMemo, createSignal, onCleanup, onSettled } from 'solid-js';
import { liveQuery, useNavigate } from '@solidjs/router';

import {
  markNotificationSeen,
  notificationsStream,
  type NotificationRow,
} from '../lib/notifications';
import {
  isChatRow,
  hrefToPath,
  notificationHref,
  notificationLine,
} from '../lib/notification-text';
import { isScopeOpen } from '../lib/open-scopes';
import { resolveAccessRequest } from '../lib/access';
import { getMe } from '../lib/auth';
import { warmNotificationTarget } from '../lib/prefetch';
import { dndActive, insideWorkHours, refreshMyStatus } from '../lib/status';
import { appName } from '../lib/brand';

/** A short Slack-style chime via WebAudio (no assets, no network). */
function chime(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
    setTimeout(() => void ctx.close().catch(() => {}), 700);
  } catch {
    // sound is a nice-to-have; silence is fine
  }
}

/** Hidden tab: raise a service-worker notification (OS level, with the
 *  click-through the worker owns). Falls back to the page API when no
 *  worker is registered (dev without one, ancient browsers). */
async function systemNotification(row: NotificationRow, text: string): Promise<void> {
  const options: NotificationOptions & { data?: { url: string } } = {
    body: text,
    tag: row.id,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: notificationHref(row) },
  };
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) {
      await registration.showNotification(appName, options);
      return;
    }
  } catch {
    // fall through to the page API
  }
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const note = new Notification(appName, options);
      note.onclick = () => {
        window.focus();
        note.close();
      };
    }
  } catch {
    // best effort
  }
}

type Toast = NotificationRow & { key: string; text: string; busy?: boolean };

/** The toast stack — mounted once at the app level. */
export function NotificationFeed() {
  const navigate = useNavigate();
  const me = createMemo(() => getMe());
  const inboxLive = liveQuery(notificationsStream, 'inbox');

  const [toasts, setToasts] = createSignal<Toast[]>([]);
  let bootstrapped = false;
  let seen = new Set<string>();

  const dismiss = (key: string) =>
    setToasts((current) => current.filter((toast) => toast.key !== key));

  /** Click a toast: mark the row read and go where it points. */
  const open = (toast: Toast) => {
    void markNotificationSeen(toast.id).catch(() => {});
    navigate(hrefToPath(notificationHref(toast)));
    dismiss(toast.key);
  };

  /** An admin's quick action on an access request toast. */
  const resolve = async (toast: Toast, grant: boolean) => {
    setToasts((current) =>
      current.map((row) => (row.key === toast.key ? { ...row, busy: true } : row)),
    );
    try {
      await resolveAccessRequest({
        boardId: toast.board_id ?? '',
        userId: toast.subject_id ?? '',
        grant,
      });
    } catch {
      // the request is still on /notifications if this failed
    }
    dismiss(toast.key);
  };

  onSettled(() => {
    if (!me()?.id) return;
    // The status gates (DND / work hours) read this device's cache.
    void refreshMyStatus();
    // The service worker focused this tab for a notification click —
    // take the route it's carrying.
    let cleanup: (() => void) | undefined;
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      const onMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; url?: string };
        if (data?.type === 'fd-navigate' && data.url) navigate(hrefToPath(data.url));
      };
      navigator.serviceWorker.addEventListener('message', onMessage);
      // onCleanup is forbidden inside onSettled — the return value is the
      // cleanup (Solid 2's discipline; a throw here killed hydration).
      cleanup = () => navigator.serviceWorker?.removeEventListener('message', onMessage);
    }
    void (async () => {
      try {
        for await (const rows of await inboxLive()) {
          // The stream's first yield is history, not news — seed silently.
          if (!bootstrapped) {
            bootstrapped = true;
            seen = new Set(rows.map((row) => row.id));
            continue;
          }
          const fresh = rows.filter((row) => !seen.has(row.id) && !isChatRow(row));
          if (fresh.length === 0) continue;
          for (const row of fresh) seen.add(row.id);
          // Prefetch by journey (docs/performance.md, layer 3): every
          // fresh row warms its target before the click — board first,
          // then chat and the card's pages. Runs whether or not the row
          // toasts (DND/work-hours quiet the bell, not the cache).
          for (const row of fresh) warmNotificationTarget(row);
          // Looking at that chat already? No toast, no sound — the row
          // is quietly read (Slack's "you're already there").
          const visible = fresh.filter(
            (row) =>
              !(
                (row.kind === 'mention' || row.kind === 'chat' || row.kind === 'comment') &&
                isScopeOpen(row)
              ),
          );
          for (const row of fresh) {
            if (row.kind === 'mention' || row.kind === 'chat' || row.kind === 'comment') {
              if (isScopeOpen(row)) void markNotificationSeen(row.id).catch(() => {});
            }
          }
          if (visible.length === 0) continue;
          fresh.splice(0, fresh.length, ...visible);
          // Status gates (Slack-style): DND silences everything; outside
          // work hours only direct-level mentions toast. The rows are
          // still in the bell either way — nothing is lost, just quiet.
          if (dndActive()) continue;
          if (!insideWorkHours()) {
            const mentionsOnly = fresh.filter((row) => row.kind === 'mention');
            if (mentionsOnly.length === 0) continue;
            fresh.splice(0, fresh.length, ...mentionsOnly);
          }
          const meId = me()?.id ?? null;
          const texts = fresh.map((row) => notificationLine(row, meId).text);
          chime();
          // Visible tab: toasts. Hidden tab: OS-level notifications.
          if (document.visibilityState !== 'visible') {
            for (let i = 0; i < Math.min(fresh.length, 3); i++) {
              void systemNotification(fresh[i], texts[i]);
            }
          }
          setToasts((current) =>
            [
              ...fresh.map((row, index) => ({
                ...row,
                key: `${row.id}:${Date.now()}:${index}`,
                text: texts[index],
              })),
              ...current,
            ].slice(0, 4),
          );
          setTimeout(
            () =>
              setToasts((current) =>
                fresh.length ? current.slice(0, current.length - fresh.length) : current,
              ),
            6000,
          );
        }
      } catch {
        // the feed is best effort — the dashboard inbox still renders
      }
    })();
    return cleanup;
  });

  onCleanup(() => {
    seen.clear();
  });

  return (
    <div class="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-80 flex-col gap-2">
      <For each={toasts()}>
        {(toast) => (
          <div class="pointer-events-auto flex flex-col gap-0.5 rounded-xl border border-neutral-200 bg-white p-3 text-left shadow-2xl transition hover:border-indigo-300 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-indigo-700">
            <button type="button" class="text-left" onClick={() => open(toast)}>
              <span class="text-sm font-semibold">{toast.text}</span>
              <Show
                when={
                  notificationLine(toast, me()?.id ?? null).detail ||
                  (toast.card_title ?? toast.board_name)
                }
              >
                <span class="mt-0.5 block truncate text-xs text-neutral-400">
                  {[toast.card_title, toast.board_name].filter(Boolean).join(' · ')}
                </span>
              </Show>
            </button>
            {/* Access requests are actionable right here — grant or deny
                without leaving the screen you're on. */}
            <Show when={toast.kind === 'access_request'}>
              <div class="mt-1.5 flex gap-2">
                <button
                  type="button"
                  disabled={toast.busy}
                  class="rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                  onClick={() => void resolve(toast, true)}
                >
                  {toast.busy ? '…' : 'Grant access'}
                </button>
                <button
                  type="button"
                  disabled={toast.busy}
                  class="rounded-md border border-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800 dark:text-neutral-300"
                  onClick={() => void resolve(toast, false)}
                >
                  Deny
                </button>
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

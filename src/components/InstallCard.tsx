// The install UX (docs/pwa-seo-brand-plan.md, phase 6 deliverable 6):
// capture `beforeinstallprompt`, offer the install at an engagement
// moment, read `userChoice` for analytics, and render iOS manual
// instructions only in browser display-mode (installed PWAs never see
// them — there, the app is already "installed").
//
// The copy never promises persistence: `navigator.storage.persist()` can
// be denied (Chromium heuristics), so "keep your boards safe" is the
// honest framing, never "guaranteed offline storage".
import { Show, createSignal, onCleanup, onSettled } from 'solid-js';
import { isServer } from '@solidjs/web';

import { captureInstallChoice } from '../lib/telemetry';
import { isOnline } from '../lib/offline-state';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const DISMISS_KEY = 'orbit:install-dismissed';
const EDIT_THRESHOLD = 3;

let captured: InstallPromptEvent | null = null;

if (!isServer) {
  addEventListener('beforeinstallprompt', (event) => {
    // Capture and defer — the browser's own mini-infobar is a worse
    // moment than an engagement-timed in-app affordance.
    event.preventDefault();
    captured = event as InstallPromptEvent;
  });
}

function editCount(): number {
  try {
    return Number(sessionStorage.getItem('orbit:edit-count') ?? 0);
  } catch {
    return 0;
  }
}

/** The board route's mutation paths call this — the engagement signal
 *  (a user who edits is a user who benefits from installing). */
export function noteEngagementEdit(): void {
  try {
    sessionStorage.setItem('orbit:edit-count', String(editCount() + 1));
  } catch {
    // blocked storage — the affordance just never arms
  }
  for (const listener of engagementListeners) listener();
}

const engagementListeners = new Set<() => void>();

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function installAvailable(): boolean {
  return captured !== null && !dismissed() && editCount() >= EDIT_THRESHOLD;
}

export function InstallCard() {
  const [available, setAvailable] = createSignal(installAvailable());
  // iOS has no beforeinstallprompt — the manual instructions ARE the
  // affordance there (the fallback content the PR body promises).
  const isIos = !isServer && /iPad|iPhone|iPod/.test(navigator.userAgent);
  const [showIosHelp, setShowIosHelp] = createSignal(isIos);
  const [installed, setInstalled] = createSignal(
    isServer
      ? false
      : matchMedia('(display-mode: standalone)').matches ||
          // iOS Safari's standalone marker
          (navigator as unknown as { standalone?: boolean }).standalone === true,
  );

  // Event-driven: the capture and the edit threshold both re-run
  // installAvailable() — no polling timer (the perf rules' budget). The
  // board route's op effect calls noteEngagementEdit, which re-arms the
  // card through the hook below.
  onSettled(() => {
    setAvailable(installAvailable());
    const rearm = () => setAvailable(installAvailable());
    engagementListeners.add(rearm);
    const onInstalled = () => {
      setInstalled(true);
      setAvailable(false);
    };
    addEventListener('appinstalled', onInstalled);
    onCleanup(() => {
      engagementListeners.delete(rearm);
      removeEventListener('appinstalled', onInstalled);
    });
  });

  const install = async () => {
    const prompt = captured;
    if (!prompt) return;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    captureInstallChoice(outcome === 'accepted');
    captured = null;
    setAvailable(false);
  };

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // ignore
    }
    captureInstallChoice(false, true);
    setAvailable(false);
  };

  return (
    <Show
      when={!installed() && available()}
      fallback={
        <Show when={!installed() && showIosHelp()}>
          <div class="rounded-xl border border-neutral-200 bg-white p-3 text-xs dark:border-neutral-700 dark:bg-neutral-900">
            <p class="font-semibold">Add Orbit to your Home Screen</p>
            <p class="mt-1 text-neutral-500 dark:text-neutral-400">
              Safari → Share → "Add to Home Screen". Boards you've opened keep working offline, and
              edits sync when you reconnect.
            </p>
          </div>
        </Show>
      }
    >
      <div class="fixed bottom-4 right-4 z-[55] flex w-72 flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-3 text-xs shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
        <p class="font-semibold">📌 Install Orbit</p>{' '}
        <p class="text-neutral-500 dark:text-neutral-400">
          Keep your boards one tap away and working offline. Changes you make offline sync when
          you're back.
        </p>
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded-lg bg-indigo-600 px-2.5 py-1.5 font-semibold text-white hover:bg-indigo-500"
            onClick={() => void install()}
          >
            Install
          </button>
          <button
            type="button"
            class="rounded-lg px-2.5 py-1.5 font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 dark:text-neutral-300"
            onClick={dismiss}
          >
            Not now
          </button>
        </div>
        <Show when={!isOnline()}>
          <p class="text-[10px] text-neutral-400 dark:text-neutral-500">
            You're offline right now — installing can wait.
          </p>
        </Show>
      </div>
    </Show>
  );
}

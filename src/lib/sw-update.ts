// The page half of the outbox-aware service-worker update flow (the SW
// half is src/sw.ts's message handler). The contract:
//
//   * A new worker installs and WAITS — the SW never calls skipWaiting on
//     its own, because taking over mid-session can break lazily-loaded
//     chunks while the outbox holds unsynced edits.
//   * The page learns a waiting worker exists (updatefound on the
//     registration) and exposes it through `updateState` — the "Update
//     ready" chip reads it.
//   * APPLY rules: on the next navigation when the outbox is empty; after
//     the outbox drains, or on the user's explicit "Update now", when
//     edits are pending. Applying = `orbit-skip-waiting` message → the new
//     worker activates → `controllerchange` fires → ONE guarded reload.
//   * The reload guard is re-entrancy-safe across tabs: only the tab that
//     saw the controllerchange reloads, once, keyed by the applied
//     version in sessionStorage — a multi-tab controllerchange storm
//     cannot loop.
//
// SPA navigations never trigger the browser's SW update check (only full
// page loads do), so `registration.update()` also runs on client-side
// navigation — the router's path is the trigger.
import { isServer } from '@solidjs/web';

export type SwUpdateState = {
  /** A new version is installed and waiting to take over. */
  waiting: boolean;
};

type Listener = (state: SwUpdateState) => void;

const listeners = new Set<Listener>();
let state: SwUpdateState = { waiting: false };

function setState(next: SwUpdateState): void {
  state = next;
  for (const listener of listeners) listener(state);
}

/** Reactive-ish read for the chip (a Solid signal wraps this in the UI). */
export function swUpdateState(): SwUpdateState {
  return state;
}

export function onSwUpdate(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The app-route allowlist — the same list the SW's navigation fallback
 *  uses (src/sw.ts). Client-side navigations to these routes trigger a
 *  registration.update() check; other paths don't need one. */
const APP_ROUTE_PREFIXES = ['/b/', '/w/', '/u/', '/profile', '/search'];
const APP_ROUTE_EXACT = ['/'];

export function isAppRoute(path: string): boolean {
  return APP_ROUTE_EXACT.includes(path) || APP_ROUTE_PREFIXES.some((p) => path.startsWith(p));
}

// ── the applied-version guard (one reload per version, per tab) ──────────
const APPLIED_KEY = 'orbit:sw-applied-version';

/** The SW version this tab has already reloaded for. Null = none yet. */
function appliedVersion(): string | null {
  try {
    return sessionStorage.getItem(APPLIED_KEY);
  } catch {
    return null;
  }
}

function markApplied(version: string): void {
  try {
    sessionStorage.setItem(APPLIED_KEY, version);
  } catch {
    // blocked storage — the guard degrades to "reload once per tab"
    onceGuard = true;
  }
}

let onceGuard = false;

// ── wiring ───────────────────────────────────────────────────────────────

let wired = false;

/** Wire the update lifecycle. Called once per app load (PushSetup's
 *  settle — it already owns the registration). Idempotent. */
export function wireSwUpdates(): void {
  if (isServer || wired || !('serviceWorker' in navigator)) return;
  wired = true;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The new worker took control. Reload exactly once per VERSION: the
    // old page is running old chunks against a new SW. The version comes
    // from /sw-version.txt (the build stamps it) — the guard stores it
    // and only skips a reload for a version already applied, so a
    // SECOND update in the same session still reloads.
    if (onceGuard) return;
    void (async () => {
      let version: string | null = null;
      try {
        version = (
          await fetch('/sw-version.txt', { cache: 'no-store' }).then((r) => r.text())
        ).trim();
      } catch {
        version = null;
      }
      const applied = appliedVersion();
      if (version && applied === version) return; // already reloaded for this version
      if (version) markApplied(version);
      onceGuard = true;
      location.reload();
    })();
  });

  void (async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;
    // A worker may ALREADY be waiting (installed while the tab was
    // closed, or the chip was never shown).
    if (registration.waiting) setState({ waiting: true });
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          // `controller` non-null: this page is governed by an older
          // worker, so the install is an UPDATE (not the first install).
          setState({ waiting: true });
        }
      });
    });
  })();
}

/**
 * Apply the waiting update NOW: message the worker to skipWaiting; the
 * controllerchange handler above reloads once. Called by the chip's
 * "Update now" button, and by the outbox-drain watcher when the last
 * pending edit acks.
 */
export function applySwUpdate(): void {
  if (isServer || !('serviceWorker' in navigator)) return;
  void (async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    registration?.waiting?.postMessage({ type: 'orbit-skip-waiting' });
  })();
}

/**
 * The outbox hook: the sync engine calls this whenever its pending-op
 * count changes. While an update waits, the moment the outbox empties is
 * the safe moment to apply — the queued edits are all acked.
 */
export function swOutboxChanged(pendingCount: number): void {
  if (!state.waiting) return;
  if (pendingCount === 0) applySwUpdate();
}

/**
 * Client-side navigation hook: SPA route changes never trigger the
 * browser's SW update check, so the router calls this on every app-route
 * navigation (hourly checks would miss the in-between).
 */
export function swNavigated(path: string): void {
  if (isServer || !isAppRoute(path) || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.getRegistration()?.then((registration) => {
    void registration?.update().catch(() => {
      // best-effort — the next navigation checks again
    });
  });
}

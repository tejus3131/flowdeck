// The offline UX layer's shared state (docs/pwa-seo-brand-plan.md, phase 6
// deliverable 4): the app-wide connection banner and the per-board
// last-synced watermark both read from here.
//
// Two sources of truth, deliberately separate:
//   * connectivity — the browser's online/offline events (the banner is
//     about the DEVICE's network; the sync engine's status is about the
//     realtime wire, which can be down while the network is up)
//   * sync — the engine's own status + the durable revision it last
//     merged (the watermark is per-board, from the snapshot's revision
//     cursor; a board that never opened has no watermark)
//
// Neither blocks editing: the banner is a passive chip, the watermark a
// passive timestamp. The outbox makes offline edits safe — the UI says
// so, it never says "you can't".
import { isServer } from '@solidjs/web';

// ── connectivity ─────────────────────────────────────────────────────────

const listeners = new Set<() => void>();

let online = isServer ? true : navigator.onLine;

function setOnline(next: boolean): void {
  if (online === next) return;
  online = next;
  for (const listener of listeners) listener();
}

if (!isServer && typeof addEventListener === 'function') {
  addEventListener('online', () => setOnline(true));
  addEventListener('offline', () => setOnline(false));
}

/** Reactive-ish read (a Solid signal wraps this in the UI). */
export function isOnline(): boolean {
  return online;
}

export function onConnectivityChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── per-board last-synced watermark ──────────────────────────────────────

/** boardId → { revision, at } — the last durable snapshot each open board
 *  merged. Written by the board route's engine effect; read by the
 *  watermark chip. Bounded by the open-board set (a handful of entries). */
const watermarks = new Map<string, { revision: number; at: number }>();

const watermarkListeners = new Set<(boardId: string) => void>();

export function markBoardSynced(boardId: string, revision: number): void {
  const prev = watermarks.get(boardId);
  // Same revision → same state; only a NEW revision is a sync event.
  if (prev && prev.revision >= revision) return;
  watermarks.set(boardId, { revision, at: Date.now() });
  for (const listener of watermarkListeners) listener(boardId);
}

/** The watermark for one board, or null when it never synced. */
export function boardWatermark(boardId: string): { revision: number; at: number } | null {
  return watermarks.get(boardId) ?? null;
}

export function onWatermarkChange(listener: (boardId: string) => void): () => void {
  watermarkListeners.add(listener);
  return () => watermarkListeners.delete(listener);
}

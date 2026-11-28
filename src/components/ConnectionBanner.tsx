// The app-wide connection banner — a passive chip, never a modal, never
// blocking editing (the offline UX contract: the outbox makes offline
// edits safe, so the banner says "changes will sync", not "you can't").
// Reads the DEVICE's network (lib/offline-state), not the realtime wire —
// the wire's own state already has per-board pills on the board header.
import { Show, createSignal, onCleanup, onSettled } from 'solid-js';

import { isOnline, onConnectivityChange } from '../lib/offline-state';

export function ConnectionBanner() {
  const [online, setOnline] = createSignal(isOnline());

  onSettled(() => {
    const off = onConnectivityChange(() => setOnline(isOnline()));
    onCleanup(off);
  });

  return (
    <Show when={!online()}>
      <div
        role="status"
        class="fixed bottom-4 left-4 z-[55] flex items-center gap-2 rounded-full bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white shadow-lg dark:bg-neutral-100 dark:text-neutral-900"
      >
        <span class="h-1.5 w-1.5 rounded-full bg-amber-400" />
        Offline — changes will sync when you reconnect
      </div>
    </Show>
  );
}

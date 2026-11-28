// The per-board last-synced watermark (Google Docs' per-document status
// indicator, adapted): a quiet "Synced HH:MM" chip in the board header
// that stamps the last durable snapshot the engine merged. While ops are
// in flight the existing "Syncing" pill takes over; offline, the
// watermark is the honest "here's how fresh this is".
import { Show, createSignal, onCleanup, onSettled } from 'solid-js';

import { boardWatermark, onWatermarkChange } from '../lib/offline-state';

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function SyncWatermark(props: { boardId: string }) {
  const [syncedAt, setSyncedAt] = createSignal<number | null>(
    boardWatermark(props.boardId)?.at ?? null,
  );

  onSettled(() => {
    const off = onWatermarkChange((boardId) => {
      if (boardId !== props.boardId) return;
      setSyncedAt(boardWatermark(boardId)?.at ?? null);
    });
    onCleanup(off);
  });

  return (
    <Show when={syncedAt()}>
      {(at) => (
        <span class="text-neutral-400 dark:text-neutral-500" title="Last synced with the server">
          Synced {formatTime(at())}
        </span>
      )}
    </Show>
  );
}

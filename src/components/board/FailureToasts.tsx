// Extracted from the board route (phase 6): a panel is its own module
// so the route stays a wiring file (L5 rule 6).
const OP_LABELS: Record<string, string> = {
  addCard: 'Couldn\u2019t add that card',
  moveCard: 'Couldn\u2019t move that card',
  resolveCard: 'Couldn\u2019t resolve that card',
  'resolve-card': 'Couldn\u2019t resolve that card',
  // 'deleteCard' label kept for old in-flight ops (cards can't be deleted anymore).
  deleteCard: 'Couldn\u2019t delete that card',
  updateCard: 'Couldn\u2019t save that card',
  addList: 'Couldn\u2019t add that list',
  deleteList: 'Couldn\u2019t delete that list',
  renameList: 'Couldn\u2019t rename that list',
  renameBoard: 'Couldn\u2019t rename the board',
};
import { For } from 'solid-js';

/** Bottom-right stack of retryable failures — the engine's error surface. */
export function FailureToasts(props: {
  failures: { id: string; kind: string; error?: string }[];
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <div class="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      <For each={props.failures}>
        {(failure) => (
          <div class="flex items-start gap-3 rounded-xl border border-red-200 bg-white p-3 text-sm shadow-lg dark:border-red-900 dark:bg-neutral-900">
            <div class="flex-1">
              <p class="font-medium">{OP_LABELS[failure.kind] ?? 'Something went wrong'}</p>
              <p class="mt-0.5 text-xs text-neutral-400">{failure.error}</p>
            </div>
            <button
              type="button"
              class="rounded-md bg-indigo-600 px-2 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
              onClick={() => props.onRetry(failure.id)}
            >
              Retry
            </button>
            <button
              type="button"
              class="rounded-md px-1.5 py-1 text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
              title="Dismiss"
              onClick={() => props.onDismiss(failure.id)}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

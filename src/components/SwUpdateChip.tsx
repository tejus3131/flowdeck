// The "Update ready" chip — the visible half of the outbox-aware SW
// update flow (lib/sw-update.ts). A new worker version installs and
// waits; this chip appears (bottom-right, passive — never a modal) and
// offers "Update now". The outbox rule is enforced in sw-update.ts: with
// pending edits, the update applies when the outbox drains even if the
// user never clicks; the button is the explicit-consent path.
import { Show, createSignal, onSettled } from 'solid-js';

import { applySwUpdate, onSwUpdate, swUpdateState, type SwUpdateState } from '../lib/sw-update';

export function SwUpdateChip() {
  const [waiting, setWaiting] = createSignal(swUpdateState().waiting);
  const [applying, setApplying] = createSignal(false);

  onSettled(() => onSwUpdate((state: SwUpdateState) => setWaiting(state.waiting)));

  const updateNow = () => {
    setApplying(true);
    applySwUpdate(); // the guarded controllerchange reload follows
  };

  return (
    <Show when={waiting()}>
      <div class="fixed bottom-4 right-4 z-[60] flex items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-xs shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
        <span class="font-medium text-neutral-700 dark:text-neutral-200">Update ready</span>
        <button
          type="button"
          class="rounded-lg bg-indigo-600 px-2.5 py-1 font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
          disabled={applying()}
          onClick={updateNow}
        >
          {applying() ? 'Updating…' : 'Update now'}
        </button>
      </div>
    </Show>
  );
}

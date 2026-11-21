import { revalidate } from '@solidjs/router';
import { Show, createSignal } from 'solid-js';

import { MeProfile } from '../lib/auth';
import { addPasskey, dismissPasskeyPrompt, passkeyPromptDismissed } from '../lib/passkey';

/**
 * The "add a passkey" prompt, shown to signed-in users without one.
 * New accounts land here right after their first magic-link sign-in:
 * passkey is the default way back in, the link was the one-time door.
 */
export function PasskeyPrompt(props: { profile: () => MeProfile }) {
  const [dismissed, setDismissed] = createSignal(passkeyPromptDismissed());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);

  const register = async () => {
    setBusy(true);
    setError(null);
    const result = await addPasskey();
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'Passkey registration failed — try again.');
      return;
    }
    // The identities trigger flipped profiles.has_passkey; refetch `me`
    // so every consumer (this prompt included) sees it immediately.
    revalidate('me');
    setDone(true);
  };

  const hide = () => {
    dismissPasskeyPrompt();
    setDismissed(true);
  };

  return (
    <Show
      when={
        !dismissed() && !props.profile().has_passkey && !done()
      }
    >
      <div class="flex flex-col gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-4 sm:flex-row sm:items-center dark:border-indigo-800 dark:bg-indigo-950">
        <div class="flex-1">
          <p class="text-sm font-semibold text-indigo-900 dark:text-indigo-100">
            🔑 Sign in faster next time
          </p>
          <p class="mt-0.5 text-sm text-indigo-700 dark:text-indigo-300">
            Add a passkey — Face&nbsp;ID, Touch&nbsp;ID, Windows&nbsp;Hello, or a security key.
            Next visit, no email link needed.
          </p>
          <Show when={error()}>
            <p role="alert" class="mt-1 text-sm text-red-600 dark:text-red-400">
              {error()}
            </p>
          </Show>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            disabled={busy()}
            class="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
            onClick={() => void register()}
          >
            {busy() ? 'Waiting for your device…' : 'Add passkey'}
          </button>
          <button
            type="button"
            class="rounded-lg px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 dark:text-indigo-300 dark:hover:bg-indigo-900"
            onClick={hide}
          >
            Maybe later
          </button>
        </div>
      </div>
    </Show>
  );
}

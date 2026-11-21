import { Title } from '@solidjs/meta';
import { useSearchParams } from '@solidjs/router';
import { Show } from 'solid-js';

import { signIn } from '../lib/auth';

export default function SignIn() {
  // ?sent=1 → the email is on its way; ?error=… → something went wrong.
  const [search] = useSearchParams<{ sent?: string; error?: string }>();

  return (
    <main class="mx-auto flex min-h-[80vh] max-w-sm flex-col justify-center px-4">
      <Title>Sign in - Flowdeck</Title>
      <div class="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h1 class="text-xl font-semibold tracking-tight">Welcome to Flowdeck</h1>
        <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          No passwords — we email you a one-time sign-in link.
        </p>

        <div class="mt-6">
          <Show when={search.error}>
            {(error) => (
              <p
                class="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950 dark:text-red-400"
                role="alert"
              >
                {error()}
              </p>
            )}
          </Show>

          <Show
            when={search.sent}
            fallback={
              <form action={signIn} method="post" class="flex flex-col gap-3">
                <label class="text-sm font-medium" for="email">
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autocomplete="email"
                  placeholder="you@example.com"
                />
                <button
                  type="submit"
                  class="mt-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
                >
                  Send magic link
                </button>
              </form>
            }
          >
            <div class="rounded-lg bg-indigo-50 px-3 py-3 text-sm text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
              <p class="font-medium">Check your inbox</p>
              <p class="mt-1">We sent a sign-in link. It's valid for one hour.</p>
            </div>
          </Show>
        </div>
      </div>
      <p class="mt-4 text-center text-xs text-neutral-400">
        Sessions persist — you won't need a new link every visit.
      </p>
    </main>
  );
}

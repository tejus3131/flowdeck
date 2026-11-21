import { Title } from '@solidjs/meta';
import { useSearchParams } from '@solidjs/router';
import { Show } from 'solid-js';

import { signIn } from '../lib/auth';

export default function SignIn() {
  // ?sent=1 → the email is on its way; ?error=… → something went wrong.
  const [search] = useSearchParams<{ sent?: string; error?: string }>();

  return (
    <main class="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center gap-6 px-4">
      <Title>Sign in - Flowdeck</Title>
      <div class="space-y-2">
        <h1 class="text-2xl font-semibold tracking-tight">Sign in to Flowdeck</h1>
        <p class="text-sm text-neutral-500 dark:text-neutral-400">
          No passwords — we email you a one-time sign-in link.
        </p>
      </div>

      <Show when={search.error}>
        {(error) => (
          <p
            class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
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
              class="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              type="submit"
              class="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Send magic link
            </button>
          </form>
        }
      >
        <p class="rounded-md bg-neutral-50 px-3 py-2 text-sm text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
          Check your inbox — we sent a sign-in link. It's valid for one hour.
        </p>
      </Show>
    </main>
  );
}

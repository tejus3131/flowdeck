import { Title } from '@solidjs/meta';
import { Show, createMemo } from 'solid-js';

import { getMe } from '../lib/auth';

export default function Home() {
  const me = createMemo(() => getMe());

  return (
    <main class="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-start justify-center gap-4 px-4">
      <Title>Flowdeck</Title>
      <h1 class="text-3xl font-semibold tracking-tight">Flowdeck</h1>
      <p class="text-neutral-600 dark:text-neutral-400">
        Realtime kanban boards for you, your team — and your agents.
      </p>
      <Show when={me()} fallback={
        <p class="text-sm text-neutral-500 dark:text-neutral-400">
          <a href="/sign-in" class="underline">Sign in</a> with a magic link to
          get started.
        </p>
      }>
        {(profile) => (
          <p class="text-sm text-neutral-500 dark:text-neutral-400">
            Welcome back, {profile().display_name || profile().email}. Your
            boards dashboard is coming next.
          </p>
        )}
      </Show>
    </main>
  );
}

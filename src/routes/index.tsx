import { Title } from '@solidjs/meta';
import { useNavigate } from '@solidjs/router';
import { For, Loading, Show, action, createMemo } from 'solid-js';

import { getMe } from '../lib/auth';
import { createBoard, getBoards } from '../lib/boards';

export default function Home() {
  const me = createMemo(() => getMe());
  const boards = createMemo(() => getBoards());
  const navigate = useNavigate();

  const create = action(function* (name: string) {
    const boardId = yield createBoard(name);
    navigate(`/b/${boardId}`);
  });

  return (
    <main class="mx-auto max-w-4xl px-4 py-8">
      <Title>Flowdeck</Title>
      <h1 class="text-2xl font-semibold tracking-tight">Flowdeck</h1>
      <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Realtime kanban boards for you, your team — and your agents.
      </p>

      <Show
        when={me()}
        fallback={
          <p class="mt-6 text-sm text-neutral-500 dark:text-neutral-400">
            <a href="/sign-in" class="underline">
              Sign in
            </a>{' '}
            with a magic link to get started.
          </p>
        }
      >
        {(profile) => (
          <div class="mt-8 space-y-8">
            <form
              class="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
                if (name) create(name);
              }}
            >
              <input
                name="name"
                placeholder="New board name…"
                class="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              <button
                type="submit"
                class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
              >
                Create board
              </button>
            </form>

            <Loading fallback={<p class="text-sm text-neutral-400">Loading boards…</p>}>
              <section>
                <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-400">
                  Your boards
                </h2>
                <Show
                  when={boards().length > 0}
                  fallback={
                    <p class="text-sm text-neutral-400">
                      No boards yet — create your first one above.
                    </p>
                  }
                >
                  <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <For each={boards()}>
                      {(board) => (
                        <li>
                          <a
                            href={`/b/${board.id}`}
                            class="block rounded-xl border border-neutral-200 p-4 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
                          >
                            <p class="font-medium">{board.name}</p>
                            <p class="mt-1 text-xs text-neutral-400">
                              updated{' '}
                              {new Date(board.updated_at).toLocaleDateString(undefined, {
                                month: 'short',
                                day: 'numeric',
                              })}
                            </p>
                          </a>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>
            </Loading>

            <p class="text-xs text-neutral-400">
              Signed in as {profile().email}.
            </p>
          </div>
        )}
      </Show>
    </main>
  );
}

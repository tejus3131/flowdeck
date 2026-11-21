import { Title } from '@solidjs/meta';
import { useNavigate } from '@solidjs/router';
import { For, Loading, Show, action, createMemo, createSignal } from 'solid-js';

import { getMe } from '../lib/auth';
import { createBoard, deleteBoard, getBoards } from '../lib/boards';
import { PasskeyPrompt } from '../components/PasskeyPrompt';

export default function Home() {
  const me = createMemo(() => getMe());
  const boards = createMemo(() => getBoards());
  const navigate = useNavigate();
  const [confirmingDelete, setConfirmingDelete] = createSignal<string | null>(null);

  const create = action(function* (name: string) {
    const boardId = yield createBoard(name);
    navigate(`/b/${boardId}`);
  });

  // The router revalidates the boards query when the call settles, so the
  // list refreshes on its own.
  const remove = action(function* (boardId: string) {
    yield deleteBoard(boardId);
    setConfirmingDelete(null);
  });

  return (
    <main class="mx-auto max-w-4xl px-4 py-10">
      <Title>Flowdeck</Title>
      <h1 class="text-2xl font-semibold tracking-tight">Flowdeck</h1>
      <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Realtime kanban boards for you, your team — and your agents.
      </p>

      <Show
        when={me()}
        fallback={
          <p class="mt-8 text-sm text-neutral-500 dark:text-neutral-400">
            <a href="/sign-in" class="font-medium text-indigo-600 underline dark:text-indigo-400">
              Sign in
            </a>{' '}
            with a magic link to get started.
          </p>
        }
      >
        {(profile) => (
          <div class="mt-8 space-y-10">
            <PasskeyPrompt profile={profile} />
            <form
              class="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const name = String(new FormData(form).get('name') ?? '').trim();
                if (name) {
                  create(name);
                  form.reset();
                }
              }}
            >
              <input name="name" placeholder="New board name…" class="flex-1" />
              <button
                type="submit"
                class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
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
                        <li class="group relative rounded-2xl border border-neutral-200 bg-white p-4 transition hover:border-indigo-300 hover:shadow-sm dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-indigo-700">
                          <a href={`/b/${board.id}`} class="block">
                            <p class="font-medium">{board.name}</p>
                            <p class="mt-1 text-xs text-neutral-400">
                              updated{' '}
                              {new Date(board.updated_at).toLocaleDateString(undefined, {
                                month: 'short',
                                day: 'numeric',
                              })}
                            </p>
                          </a>
                          <Show
                            when={confirmingDelete() === board.id}
                            fallback={
                              <button
                                type="button"
                                title="Delete board"
                                class="absolute right-3 top-3 hidden rounded-md px-1.5 text-neutral-300 hover:text-red-500 group-hover:block dark:text-neutral-600"
                                onClick={() => setConfirmingDelete(board.id)}
                              >
                                ×
                              </button>
                            }
                          >
                            <button
                              type="button"
                              class="absolute right-3 top-3 rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-600 dark:bg-red-950 dark:text-red-400"
                              onClick={() => remove(board.id)}
                            >
                              Delete?
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>
            </Loading>

            <p class="text-xs text-neutral-400">Signed in as {profile().email}.</p>
          </div>
        )}
      </Show>
    </main>
  );
}

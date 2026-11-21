import { Title } from '@solidjs/meta';
import { useNavigate } from '@solidjs/router';
import { liveQuery } from '@solidjs/router';
import { For, Show, createMemo, createSignal } from 'solid-js';

import { PasskeyPrompt } from '../components/PasskeyPrompt';
import { getMe } from '../lib/auth';
import {
  boardsStream,
  createBoard,
  deleteBoard,
  EMPTY_BOARDS,
  type BoardsSnapshot,
  type BoardSummary,
} from '../lib/boards';
import { createEngine } from '../lib/sync';
import { getMyWorkspaces } from '../lib/workspaces';

const OP_LABELS: Record<string, string> = {
  'create-board': "Couldn't create that board",
  'delete-board': "Couldn't delete that board",
};

/**
 * The dashboard on the sync engine: board create/delete apply instantly
 * (shimmer placeholder, instant removal), the list is a live view of the
 * workspace's boards (teammates' changes appear on their own), and failures
 * surface as retryable toasts. Switching workspaces is instant — the list
 * just re-filters, no resubscribe.
 */
function BoardsDashboard(props: { profile: () => import('../lib/auth').MeProfile }) {
  const navigate = useNavigate();
  const me = createMemo(() => getMe());
  const workspaces = createMemo(() => getMyWorkspaces());

  // One shared channel for the board list, request-scoped under SSR.
  const boardsLive = liveQuery(boardsStream, 'boards');

  const engine = createEngine<BoardsSnapshot>({
    streamSource: () => boardsLive(),
    key: () => 'boards',
    empty: EMPTY_BOARDS,
    clone: (snapshot) => ({ boards: snapshot.boards.slice() }),
    merge: (draft, snapshot, keep) => {
      // Server rows first, guarded locals preserved; newest activity on top.
      const kept = draft.boards.filter((row) => keep.has(row.id));
      const keptIds = new Set(kept.map((row) => row.id));
      const merged = [
        ...snapshot.boards.filter((row) => !keptIds.has(row.id)),
        ...kept,
      ].sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at));
      draft.boards = merged;
    },
    status: () => boardsLive.status(),
  });

  const currentWorkspaceId = () => workspaces().find((w) => w.current)?.id;
  const boards = () =>
    engine
      .view()
      .boards.filter((board) => board.workspace_id === currentWorkspaceId());

  // Dev-only introspection hook (e2e suites + browser debugging).
  (globalThis as Record<string, unknown>).__flowdeck = { engine, boardsLive, boards };

  const addBoard = (name: string) => {
    const tempId = crypto.randomUUID();
    engine.mutate({
      kind: 'create-board',
      guards: [tempId],
      tempIds: [tempId],
      apply: (draft) => {
        draft.boards.unshift({
          id: tempId,
          name,
          owner_id: me()?.id ?? '',
          workspace_id: currentWorkspaceId() ?? '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      },
      send: () =>
        createBoard(name).then((boardId) => {
          // Straight into the new board once its id is real.
          navigate(`/b/${boardId}`);
        }),
      echo: (durable) => durable.boards.some((board) => board.name === name && board.id !== tempId),
    });
  };

  const [confirmingDelete, setConfirmingDelete] = createSignal<string | null>(null);

  const removeBoard = (boardId: string) => {
    setConfirmingDelete(null);
    engine.mutate({
      kind: 'delete-board',
      guards: [boardId],
      apply: (draft) => {
        draft.boards = draft.boards.filter((board) => board.id !== boardId);
      },
      send: () => deleteBoard(boardId),
      echo: (durable) => !durable.boards.some((board) => board.id === boardId),
    });
  };

  return (
    <div class="mt-8 space-y-10">
      <PasskeyPrompt profile={props.profile} />

      <form
        class="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          if (!(form instanceof HTMLFormElement)) return;
          const name = String(new FormData(form).get('name') ?? '').trim();
          if (name) {
            addBoard(name);
            form.reset();
          }
        }}
      >
        <input name="name" placeholder="New board name…" class="flex-1" maxlength="80" />
        <button
          type="submit"
          class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          Create board
        </button>
      </form>

      <section>
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Boards · {workspaces().find((w) => w.current)?.name ?? 'Workspace'}
          </h2>
          <Show when={engine.failed().length > 0 || engine.ops().some((op) => op.status === 'inFlight')}>
            <span class="flex items-center gap-1.5 text-xs text-neutral-400">
              <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" />
              Syncing
            </span>
          </Show>
        </div>

        <Show
          when={boards().length > 0}
          fallback={
            <p class="text-sm text-neutral-400">
              No boards in this workspace yet — create your first one above.
            </p>
          }
        >
          <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <For each={boards()}>
              {(board) => (
                <BoardCard
                  board={board}
                  isTemp={engine.isTemp(board.id)}
                  confirming={confirmingDelete() === board.id}
                  onAskDelete={() => setConfirmingDelete(board.id)}
                  onDelete={() => removeBoard(board.id)}
                />
              )}
            </For>
          </ul>
        </Show>
      </section>

      {/* Retryable failure toasts — the engine's revert already ran. */}
      <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        <For each={engine.failed()}>
          {(op) => (
            <div class="flex items-center gap-3 rounded-xl border border-red-200 bg-white px-4 py-3 text-sm shadow-lg dark:border-red-900 dark:bg-neutral-900">
              <span class="text-red-600 dark:text-red-400">
                {OP_LABELS[op.kind] ?? "Couldn't do that"} — {op.error}
              </span>
              <button
                type="button"
                class="rounded-lg bg-red-50 px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-100 dark:bg-red-950 dark:text-red-400"
                onClick={() => engine.retry(op.id)}
              >
                Retry
              </button>
              <button
                type="button"
                class="rounded-lg px-1 text-neutral-400 hover:text-neutral-600"
                onClick={() => engine.dismiss(op.id)}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

function BoardCard(props: {
  board: BoardSummary;
  isTemp: boolean;
  confirming: boolean;
  onAskDelete: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      class={[
        'group relative rounded-2xl border border-neutral-200 bg-white p-4 transition dark:border-neutral-800 dark:bg-neutral-900',
        {
          'animate-pulse opacity-70': props.isTemp,
          'hover:border-indigo-300 hover:shadow-sm dark:hover:border-indigo-700': !props.isTemp,
        },
      ]}
    >
      <Show when={!props.isTemp} fallback={<p class="font-medium text-neutral-400">{props.board.name}</p>}>
        <a href={`/b/${props.board.id}`} class="block">
          <p class="font-medium">{props.board.name}</p>
          <p class="mt-1 text-xs text-neutral-400">
            updated{' '}
            {new Date(props.board.updated_at).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            })}
          </p>
        </a>
      </Show>
      <Show
        when={props.confirming}
        fallback={
          <button
            type="button"
            title="Delete board"
            class="absolute right-3 top-3 hidden rounded-md px-1.5 text-neutral-300 hover:text-red-500 group-hover:block dark:text-neutral-600"
            onClick={() => props.onAskDelete()}
          >
            ×
          </button>
        }
      >
        <button
          type="button"
          class="absolute right-3 top-3 rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-600 dark:bg-red-950 dark:text-red-400"
          onClick={() => props.onDelete()}
        >
          Delete?
        </button>
      </Show>
    </li>
  );
}

export default function Home() {
  const me = createMemo(() => getMe());

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
            with a passkey or a one-time email link to get started.
          </p>
        }
      >
        {(profile) => <BoardsDashboard profile={profile} />}
      </Show>
    </main>
  );
}

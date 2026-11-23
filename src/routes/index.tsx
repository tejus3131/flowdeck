import { Title } from '@solidjs/meta';
import { liveQuery, revalidate } from '@solidjs/router';
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';

import { PasskeyPrompt } from '../components/PasskeyPrompt';
import { Avatar } from '../components/Avatar';
import { getMe } from '../lib/auth';
import {
  boardsStream,
  createBoard,
  deleteBoard,
  getBoardsSnapshot,
  EMPTY_BOARDS,
  type BoardAccessInfo,
  type BoardsSnapshot,
  type BoardSummary,
} from '../lib/boards';
import { createEngine } from '../lib/sync';
import { getMyWorkspaces, createWorkspace, enterWorkspaceOrdered, getWorkspaceSnapshot, switchWorkspaceOrdered } from '../lib/workspaces';
import { createWorkspaceRelay } from '../lib/workspace-relay';
import { MembershipWatch } from '../components/MembershipWatch';
import {
  applyBoardsOp,
  echoBoardsOp,
  guardsForBoardsOp,
  tempIdsForBoardsOp,
  type BoardCreatedOp,
  type BoardDeletedOp,
  type WorkspaceOpPayload,
} from '../lib/workspace-ops';

type BoardOpBoards = BoardCreatedOp | BoardDeletedOp;

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
  const me = createMemo(() => getMe());
  const workspaces = createMemo(() => getMyWorkspaces());

  // One shared channel for the board list, request-scoped under SSR.
  const boardsLive = liveQuery(boardsStream, 'boards');

  const engine = createEngine<BoardsSnapshot>({
    streamSource: () => boardsLive(),
    key: () => 'boards',
    empty: EMPTY_BOARDS,
    clone: (snapshot) => ({ boards: snapshot.boards.slice(), access: snapshot.access }),
    merge: (draft, snapshot, keep) => {
      // Server rows first, guarded locals preserved; newest activity on top.
      // Rows entering the view are copies (snapshot isolation — see
      // mergeRows) and unchanged rows keep their identity (no churn).
      const kept = draft.boards.filter((row) => keep.has(row.id));
      const keptIds = new Set(kept.map((row) => row.id));
      const prev = new Map(draft.boards.map((row) => [row.id, row]));
      const merged = [
        ...snapshot.boards
          .filter((row) => !keptIds.has(row.id))
          .map((row) => {
            const old = prev.get(row.id);
            return old && JSON.stringify(old) === JSON.stringify(row) ? old : { ...row };
          }),
        ...kept,
      ].sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at));
      if (draft.boards.length !== merged.length || draft.boards.some((row, i) => row !== merged[i])) {
        draft.boards = merged;
      }
      draft.access = snapshot.access;
    },
    status: () => boardsLive.status(),
    refresh: async () => await getBoardsSnapshot(),
  });

  const currentWorkspaceId = () => workspaces().find((w) => w.current)?.id;
  /** The current workspace's members — board cards resolve avatars. */
  const [wsMembers, setWsMembers] = createSignal<
    { user_id: string; display_name: string | null; email: string | null; avatar_url: string | null }[]
  >([]);
  createEffect(
    () => currentWorkspaceId(),
    (id) => {
      if (!id) {
        setWsMembers([]);
        return;
      }
      void getWorkspaceSnapshot(id)
        .then((detail) => setWsMembers(detail?.members ?? []))
        .catch(() => setWsMembers([]));
    },
  );

  // ── the workspace relay: board create/delete reaches peers instantly ──
  const relay = createWorkspaceRelay(currentWorkspaceId, () => me(), (op) => {
    if ('payload' in op && op.payload && typeof op.payload === 'object') {
      const raw = op.payload as WorkspaceOpPayload;
      // A policy change (who can create boards / invite allowlist) flips
      // the create button's visibility — the workspaces query is the
      // source of that, so revalidate it live.
      if (raw.kind === 'ws-policy-changed') {
        revalidate('workspaces');
        return;
      }
      if (raw.kind !== 'board-created' && raw.kind !== 'board-deleted') return;
      // board-created is deliberately NOT applied from the relay: the
      // receiver may have no access to the new board, and a provisional
      // ghost they can never see in the database would shimmer on their
      // list until the TTL. The durable stream (RLS-filtered) delivers it
      // to exactly the people who can see it, in a few hundred ms.
      if (raw.kind === 'board-deleted') {
        const payload: BoardOpBoards = raw;
        engine.applyRemote(
          {
            kind: payload.kind,
            guards: guardsForBoardsOp(payload),
            tempIds: tempIdsForBoardsOp(payload),
            apply: (draft) => applyBoardsOp(draft, payload),
            echo: (durable) => echoBoardsOp(durable, payload),
          },
          op.opId,
        );
      }
    } else if ('opId' in op) {
      engine.failRemote(op.opId);
    }
  });

  const addBoard = (name: string, description: string, teamTarget?: string | null) => {
    const payload: BoardCreatedOp = {
      kind: 'board-created',
      board: {
        id: crypto.randomUUID(),
        name,
        owner_id: me()?.id ?? '',
        workspace_id: currentWorkspaceId() ?? '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        client_op: crypto.randomUUID(),
        access_delegation: false,
        description,
      },
    };
    const opId = crypto.randomUUID();
    engine.mutate({
      kind: payload.kind,
      guards: guardsForBoardsOp(payload),
      tempIds: tempIdsForBoardsOp(payload),
      apply: (draft) => applyBoardsOp(draft, payload),
      send: () =>
        createBoard(name, payload.board.client_op ?? null, description, teamTarget ?? null).catch((error) => {
          relay.broadcastOpFail(opId);
          throw error;
        }),
      echo: (durable) => echoBoardsOp(durable, payload),
    });
    relay.broadcastOp({ opId, payload });
  };

  const [confirmingDelete, setConfirmingDelete] = createSignal<string | null>(null);

  const removeBoard = (boardId: string) => {
    setConfirmingDelete(null);
    const payload: WorkspaceOpPayload = { kind: 'board-deleted', boardId };
    const opId = crypto.randomUUID();
    engine.mutate({
      kind: payload.kind,
      guards: guardsForBoardsOp(payload),
      apply: (draft) => applyBoardsOp(draft, payload),
      send: () =>
        deleteBoard(boardId).catch((error) => {
          relay.broadcastOpFail(opId);
          throw error;
        }),
      echo: (durable) => echoBoardsOp(durable, payload),
    });
    relay.broadcastOp({ opId, payload });
  };

  // ── search + new-board modal ───────────────────────────────────────
  const [query, setQuery] = createSignal('');
  const [showNewBoard, setShowNewBoard] = createSignal(false);
  const [newName, setNewName] = createSignal('');
  const [newDescription, setNewDescription] = createSignal('');

  const createFromModal = () => {
    const name = newName().trim();
    if (!name) return;
    const teamId = createTeamId() || null;
    addBoard(name, newDescription().trim(), teamId);
    setNewName('');
    setNewDescription('');
    setCreateTeamId('');
    setShowNewBoard(false);
  };

  const allBoards = () => engine.view().boards;
  /** The workspace's creation policy decides who sees the button —
   *  owners/admins always; team admins and members per the setting. */
  const currentWs = () => workspaces().find((w) => w.current);
  const canCreateBoard = () => {
    const ws = currentWs();
    if (!ws) return false;
    if (ws.role === 'owner' || ws.role === 'admin') return true;
    if (ws.board_creation === 'everyone') return true;
    return ws.board_creation === 'team_admins' && ws.team_admin_of.length > 0;
  };
  /** Team admins create FOR one of their teams (the board gets access). */
  const [createTeamId, setCreateTeamId] = createSignal<string>('');
  const myTeams = () => currentWs()?.team_admin_of ?? [];
  const boards = () => {
    const q = query().trim().toLowerCase();
    const current = currentWorkspaceId();
    const inWorkspace = allBoards().filter((board) => board.workspace_id === current);
    if (!q) return inWorkspace;
    return inWorkspace.filter(
      (board) =>
        board.name.toLowerCase().includes(q) ||
        (board.description ?? '').toLowerCase().includes(q),
    );
  };
  // Dev-only introspection hook (e2e suites + browser debugging).
  (globalThis as Record<string, unknown>).__flowdeck = { engine, boardsLive, boards };

  return (
    <div class="mt-8 space-y-10">
      <MembershipWatch />
      <PasskeyPrompt profile={props.profile} />

      <Show when={workspaces().length > 0} fallback={<CreateWorkspaceCard />}>
      <Show when={currentWorkspaceId()} fallback={<WorkspacePickerCard />}>
      <div class="flex gap-2">
        <input
          type="search"
          placeholder="Search boards…"
          class="flex-1"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <a
          href="/search"
          class="shrink-0 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-600 hover:border-indigo-400 hover:text-indigo-600 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-indigo-600"
        >
          🔍 Search cards
        </a>
        <Show when={canCreateBoard()}>
          <button
            type="button"
            class="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
            onClick={() => setShowNewBoard(true)}
          >
            + New board
          </button>
        </Show>
      </div>

      <Show when={showNewBoard()}>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/40 p-4"
          onClick={() => setShowNewBoard(false)}
        >
          <form
            class="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              createFromModal();
            }}
          >
            <h3 class="text-lg font-semibold">New board</h3>
            <Show when={myTeams().length > 0 && currentWs()?.role !== 'owner' && currentWs()?.role !== 'admin'}>
              <label class="mt-4 block text-xs font-semibold uppercase tracking-wider text-neutral-400">
                Team (its members get access)
              </label>
              <select
                class="mt-1 w-full text-sm"
                value={createTeamId()}
                onChange={(event) => setCreateTeamId(event.currentTarget.value)}
              >
                <option value="">Just me — no team</option>
                <For each={myTeams()}>
                  {(team) => <option value={team.id}>@{team.name}</option>}
                </For>
              </select>
            </Show>
            <label class="mt-4 block text-xs font-semibold uppercase tracking-wider text-neutral-400">
              Name
            </label>
            <input
              class="mt-1 w-full"
              maxlength="80"
              placeholder="Q4 launch, Bug triage…"
              value={newName()}
              onInput={(event) => setNewName(event.currentTarget.value)}
              autofocus
            />
            <label class="mt-3 block text-xs font-semibold uppercase tracking-wider text-neutral-400">
              Description <span class="font-normal normal-case">(optional — what this board is for)</span>
            </label>
            <textarea
              class="mt-1 w-full"
              rows={3}
              maxlength="4000"
              placeholder="Scope, goals, links…"
              value={newDescription()}
              onInput={(event) => setNewDescription(event.currentTarget.value)}
            />
            <div class="mt-4 flex justify-end gap-2">
              <button
                type="button"
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                onClick={() => setShowNewBoard(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!newName().trim()}
                class="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Create board
              </button>
            </div>
          </form>
        </div>
      </Show>

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
          {/* Masonry: cards flow into columns, each as tall as its content. */}
          <ul class="columns-1 gap-3 sm:columns-2 lg:columns-3">
            <For each={boards()}>
              {(board) => (
                <BoardCard
                  board={board}
                  isTemp={engine.isTemp(board.id)}
                  access={engine.view().access[board.id]}
                  members={wsMembers()}
                  canDelete={
                    board.owner_id === (me()?.id ?? '') ||
                    workspaces().find((w) => w.current)?.role === 'owner' ||
                    workspaces().find((w) => w.current)?.role === 'admin'
                  }
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
      </Show>
      </Show>
    </div>
  );
}

/** The no-current-workspace state: pick one (or create) — leaving or
 *  deleting a workspace lands here instead of a dead dashboard. */
function WorkspacePickerCard() {
  const workspaces = createMemo(() => getMyWorkspaces());
  const [busy, setBusy] = createSignal<string | null>(null);
  const [pickError, setPickError] = createSignal<string | null>(null);
  const pick = async (id: string) => {
    if (busy()) return;
    setBusy(id);
    setPickError(null);
    try {
      const outcome = await switchWorkspaceOrdered(id);
      // A superseded pick means a newer selection owns the outcome —
      // don't refresh on its behalf.
      if (outcome === 'superseded') return;
      revalidate('workspaces');
      revalidate('boards');
    } catch (cause) {
      setPickError(cause instanceof Error ? cause.message : 'Could not open that workspace');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section class="mt-10">
      <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
        Your workspaces
      </h2>
      <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        You're not in a workspace right now — pick one to open its boards.
      </p>
      <Show when={pickError()}>
        <p class="mt-1 text-sm text-red-500">{pickError()}</p>
      </Show>
      <ul class="mt-4 grid gap-3 sm:grid-cols-2">
        <For each={workspaces()}>
          {(workspace) => (
            <li>
              <button
                type="button"
                disabled={busy() !== null}
                class="w-full rounded-2xl border border-neutral-200 bg-white p-4 text-left transition hover:border-indigo-300 hover:shadow-sm disabled:opacity-60 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-indigo-700"
                onClick={() => void pick(workspace.id)}
              >
                <p class="font-medium">{workspace.name}</p>
                <p class="mt-1 text-xs capitalize text-neutral-400">
                  {workspace.role}
                  {workspace.team_admin_of.length > 0 ? ` · admin of ${workspace.team_admin_of.length} team${workspace.team_admin_of.length === 1 ? '' : 's'}` : ''}
                </p>
                <p class="mt-2 text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                  {busy() === workspace.id ? 'Opening…' : 'Open →'}
                </p>
              </button>
            </li>
          )}
        </For>
        <li>
          <CreateWorkspaceCard />
        </li>
      </ul>
    </section>
  );
}

/** The zero-workspace state: new accounts land here (no pre-created
 *  workspace anymore) — a single CTA to start one. */
function CreateWorkspaceCard() {
  const [name, setName] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const create = async () => {
    const submitted = name().trim();
    if (!submitted || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await enterWorkspaceOrdered(() => createWorkspace(submitted));
      if (outcome !== 'superseded') {
        revalidate('workspaces');
        revalidate('boards');
      } else {
        // A newer intent owns the outcome and this card stays mounted —
        // become usable again instead of stranding on "Creating…".
        setBusy(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the workspace');
      setBusy(false);
    }
  };

  return (
    <section class="mt-10 rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-900">
      <p class="text-3xl">🗂️</p>
      <h2 class="mt-3 text-lg font-semibold tracking-tight">Create your workspace</h2>
      <p class="mx-auto mt-1 max-w-md text-sm text-neutral-500 dark:text-neutral-400">
        A workspace holds your boards, teammates, and teams. If you were invited to one, accept
        the invite from your email instead — you'll join exactly that.
      </p>
      <form
        class="mx-auto mt-5 flex max-w-sm gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <input
          class="flex-1"
          placeholder="e.g. Acme"
          value={name()}
          onInput={(event) => setName(event.currentTarget.value)}
        />
        <button
          type="submit"
          disabled={!name().trim() || busy()}
          class="shrink-0 rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy() ? 'Creating…' : 'Create workspace'}
        </button>
      </form>
      <Show when={error()}>
        <p class="mt-2 text-sm text-red-500">{error()}</p>
      </Show>
    </section>
  );
}

function BoardCard(props: {
  board: BoardSummary;
  isTemp: boolean;
  /** The board's owner + explicit members + teams (what the viewer sees). */
  access: BoardAccessInfo | undefined;
  members: { user_id: string; display_name: string | null; email: string | null; avatar_url: string | null }[];
  /** The × only exists for the board's owner and workspace admins. */
  canDelete: boolean;
  confirming: boolean;
  onAskDelete: () => void;
  onDelete: () => void;
}) {
  const people = () =>
    (props.access?.users ?? [])
      .map((entry) => props.members.find((m) => m.user_id === entry.userId))
      .filter((member): member is NonNullable<typeof member> => Boolean(member));
  return (
    <li
      class={[
        'group relative mb-3 break-inside-avoid rounded-2xl border border-neutral-200 bg-white p-4 transition dark:border-neutral-800 dark:bg-neutral-900',
        {
          'animate-pulse opacity-70': props.isTemp,
          'hover:border-indigo-300 hover:shadow-sm dark:hover:border-indigo-700': !props.isTemp,
        },
      ]}
    >
      <Show when={!props.isTemp} fallback={<p class="font-medium text-neutral-400">{props.board.name}</p>}>
        <a href={`/b/${props.board.id}`} class="block">
          <p class="font-medium leading-snug">{props.board.name}</p>
          <Show when={props.board.description}>
            <p class="mt-1.5 line-clamp-3 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
              {props.board.description}
            </p>
          </Show>
          {/* Who's on this board: teams first, then people (avatars). */}
          <div class="mt-3 flex flex-wrap items-center gap-1.5">
            <For each={(props.access?.teams ?? []).slice(0, 3)}>
              {(team) => (
                <span class="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                  @{team.name}
                </span>
              )}
            </For>
            <Show when={(props.access?.teams.length ?? 0) > 3}>
              <span class="text-[10px] text-neutral-400">+{(props.access?.teams.length ?? 0) - 3}</span>
            </Show>
            <span class="flex -space-x-1.5">
              <For each={people().slice(0, 5)}>
                {(member) => (
                  <span class="rounded-full ring-2 ring-white dark:ring-neutral-900" title={member.display_name ?? member.email ?? 'member'}>
                    <Avatar src={member.avatar_url} name={member.display_name} email={member.email} size="sm" />
                  </span>
                )}
              </For>
              <Show when={people().length > 5}>
                <span class="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-200 text-[10px] font-semibold text-neutral-600 ring-2 ring-white dark:bg-neutral-700 dark:text-neutral-200 dark:ring-neutral-900">
                  +{people().length - 5}
                </span>
              </Show>
            </span>
          </div>
          <p class="mt-2 text-[11px] text-neutral-400">
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
          <Show when={props.canDelete}>
            <button
              type="button"
              title="Delete board"
              class="absolute right-3 top-3 hidden rounded-md px-1.5 text-neutral-300 hover:text-red-500 group-hover:block dark:text-neutral-600"
              onClick={() => props.onAskDelete()}
            >
              ×
            </button>
          </Show>
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

// The tags hub — one page per workspace: the vocabulary at a glance.
// Listing, counting, and creating (any member — the composer's # menu
// does the same); every kind of EDITING lives on the per-tag page.
import { Title } from '@solidjs/meta';
import { type RouteProps, liveQuery } from '@solidjs/router';
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';

import { createEngine } from '../../../../lib/sync';
import { mergeWorkspaceDetail } from '../../../../lib/workspace-ops';
import { findOrCreateTag } from '../../../../lib/boards';
import { getTagCardCounts } from '../../../../lib/tags';
import {
  getWorkspaceSnapshot,
  workspaceStream,
  type WorkspaceDetail,
} from '../../../../lib/workspaces';
import { errorMessage } from '../../../../lib/error-message';
import { cachedStream, cachePut } from '../../../../lib/cache';
import { useEntities } from '../../../../lib/entity-store';
import { perfFirstValue } from '../../../../lib/perf';

const EMPTY_DETAIL: WorkspaceDetail = {
  workspace: { id: '', name: '', invite_domains: [], board_creation: 'team_admins' },
  myRole: null,
  members: [],
  invites: [],
  boards: [],
  access: {},
  tags: [],
  teams: [],
  deactivatedTeams: [],
  teamAccess: {},
};

export default function TagsPage(props: RouteProps<'/w/:workspaceId/tags'>) {
  const workspaceLive = liveQuery(workspaceStream, 'workspace');
  // Declared before the engine: its ingest closure references the store.
  const entities = useEntities();
  const engine = createEngine<WorkspaceDetail>({
    streamSource: (key) =>
      perfFirstValue(
        cachedStream(`ws-detail:${key}`, () => workspaceLive(key), 'ws-detail-revalidate'),
        'ws-detail-open',
      ),
    key: () => props.params.workspaceId,
    empty: EMPTY_DETAIL,
    clone: (snapshot) => ({
      workspace: { ...snapshot.workspace },
      myRole: snapshot.myRole,
      members: snapshot.members.slice(),
      invites: snapshot.invites.slice(),
      boards: snapshot.boards.slice(),
      access: { ...snapshot.access },
      tags: snapshot.tags.slice(),
      teams: snapshot.teams.map((team) => ({ ...team, members: team.members.slice() })),
      deactivatedTeams: snapshot.deactivatedTeams.slice(),
      teamAccess: Object.fromEntries(
        Object.entries(snapshot.teamAccess).map(([key, value]) => [key, value.slice()]),
      ),
    }),
    merge: mergeWorkspaceDetail,
    // The vocabulary lands in the entity store with every snapshot —
    // the list below reads it through the tagsOfWorkspace selector.
    ingest: (detail) => entities.ingestWorkspaceDetail(detail),
    status: () => workspaceLive.status(props.params.workspaceId),
    refresh: async () => {
      const snapshot = await getWorkspaceSnapshot(props.params.workspaceId);
      if (snapshot) cachePut(`ws-detail:${props.params.workspaceId}`, snapshot);
      return snapshot ?? EMPTY_DETAIL;
    },
  });
  const detail = createMemo(() => {
    const view = engine.view();
    return view.workspace.id ? view : null;
  });

  // The vocabulary reads through the entity store (phase 1, ADR-1): the
  // detail gate below keeps the Loading state honest, and every row —
  // name, description — resolves from the one store reference.
  const tags = createMemo(() => entities.tagsOfWorkspace(props.params.workspaceId));

  // Card counts per tag — visible cards only (RLS on card_tags).
  const [counts, setCounts] = createSignal<Record<string, number>>({});
  createEffect(
    () =>
      tags()
        .map((tag) => tag.id)
        .join(','),
    (ids) => {
      if (!ids) return;
      getTagCardCounts(ids.split(',').filter(Boolean))
        .then(setCounts)
        .catch(() => {});
    },
  );

  // ── create ────────────────────────────────────────────────────────────
  const [newName, setNewName] = createSignal('');
  const [creating, setCreating] = createSignal(false);
  const [createError, setCreateError] = createSignal<string | null>(null);
  const create = async () => {
    if (creating() || !newName().trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await findOrCreateTag(props.params.workspaceId, newName());
      setNewName('');
      await engine.refresh();
    } catch (err) {
      setCreateError(errorMessage(err));
    }
    setCreating(false);
  };

  return (
    <main class="mx-auto max-w-3xl px-4 py-10">
      <Title>Tags - Flowdeck</Title>
      <Show when={detail()} fallback={<p class="mt-8 text-sm text-neutral-400">Loading…</p>}>
        {(data) => (
          <>
            <div class="flex items-center justify-between">
              <div>
                <h1 class="text-2xl font-semibold tracking-tight">Tags</h1>
                <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {data().workspace.name} · the workspace's shared vocabulary
                </p>
              </div>
              <a
                href={`/w/${props.params.workspaceId}/members`}
                class="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Members →
              </a>
            </div>

            {/* Create: any member (the composer's # menu does the same). */}
            <form
              class="mt-6 flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <input
                class="w-44 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm shadow-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-indigo-700 dark:focus:ring-indigo-900"
                placeholder="New tag name…"
                value={newName()}
                maxlength={24}
                onInput={(event) => setNewName(event.currentTarget.value)}
              />
              <button
                type="submit"
                disabled={creating() || !newName().trim()}
                class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Create tag
              </button>
            </form>
            <Show when={createError()}>
              <p class="mt-1 text-xs text-rose-600 dark:text-rose-400">{createError()}</p>
            </Show>

            {/* The vocabulary. */}
            <Show
              when={tags().length > 0}
              fallback={
                <p class="mt-8 text-sm text-neutral-400">
                  No tags yet — create one above, or type <span class="font-medium">#</span> in any
                  composer.
                </p>
              }
            >
              <ul class="mt-4 flex flex-col gap-1.5">
                <For each={tags()}>
                  {(tag) => (
                    <li>
                      <a
                        href={`/w/${props.params.workspaceId}/tags/${tag.id}`}
                        class="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                      >
                        <span class="rounded-md bg-sky-100 px-1.5 py-0.5 text-xs font-semibold text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">
                          #{tag.name}
                        </span>
                        <span class="text-xs text-neutral-400">
                          {counts()[tag.id] ?? 0} card{(counts()[tag.id] ?? 0) === 1 ? '' : 's'}
                        </span>
                        <Show when={tag.description}>
                          <span class="truncate text-xs text-neutral-400">{tag.description}</span>
                        </Show>
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </main>
  );
}

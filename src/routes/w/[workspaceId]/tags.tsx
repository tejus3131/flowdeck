// The tags hub — one page per workspace: every tag in the vocabulary,
// how many cards carry it, and the lifecycle (create for anyone, rename
// and delete for owners/admins — the same rules the MCP ops run under).
// Each tag click-throughs to its own page: the cards and the mention feed.
import { Title } from '@solidjs/meta';
import { type RouteProps, liveQuery } from '@solidjs/router';
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';

import { createEngine } from '../../../lib/sync';
import { mergeWorkspaceDetail } from '../../../lib/workspace-ops';
import { findOrCreateTag } from '../../../lib/boards';
import { deleteTag, getTagCardCounts, renameTag } from '../../../lib/tags';
import {
  getWorkspaceSnapshot,
  workspaceStream,
  type WorkspaceDetail,
} from '../../../lib/workspaces';
import { errorMessage } from '../../../lib/error-message';
import { cachedStream, cachePut } from '../../../lib/cache';
import { perfFirstValue } from '../../../lib/perf';

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

  const isAdmin = () => detail()?.myRole === 'owner' || detail()?.myRole === 'admin';

  // Card counts per tag — visible cards only (RLS on card_tags).
  const [counts, setCounts] = createSignal<Record<string, number>>({});
  createEffect(
    () => (detail()?.tags ?? []).map((tag) => tag.id).join(','),
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

  // ── rename (admins) ───────────────────────────────────────────────────
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameDraft, setRenameDraft] = createSignal('');
  const [renameError, setRenameError] = createSignal<string | null>(null);
  const rename = async (tagId: string) => {
    if (!renameDraft().trim()) return;
    setRenameError(null);
    try {
      await renameTag(tagId, renameDraft());
      setRenamingId(null);
      await engine.refresh();
    } catch (err) {
      setRenameError(errorMessage(err));
    }
  };

  // ── delete (admins): arm then fire ────────────────────────────────────
  const [armId, setArmId] = createSignal<string | null>(null);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);
  const remove = async (tagId: string) => {
    if (armId() !== tagId) {
      setArmId(tagId);
      setTimeout(() => setArmId((current) => (current === tagId ? null : current)), 3000);
      return;
    }
    setArmId(null);
    setDeleteError(null);
    try {
      await deleteTag(tagId);
      await engine.refresh();
    } catch (err) {
      setDeleteError(errorMessage(err));
    }
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
              when={(data().tags ?? []).length > 0}
              fallback={
                <p class="mt-8 text-sm text-neutral-400">
                  No tags yet — create one above, or type <span class="font-medium">#</span>{' '}
                  in any composer.
                </p>
              }
            >
              <ul class="mt-4 flex flex-col gap-1.5">
                <For each={data().tags}>
                  {(tag) => (
                    <li class="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-900">
                      <a
                        href={`/w/${props.params.workspaceId}/tags/${tag.id}`}
                        class="flex min-w-0 flex-1 items-center gap-2"
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
                      <span class="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <Show when={isAdmin()}>
                          <Show
                            when={renamingId() === tag.id}
                            fallback={
                              <button
                                type="button"
                                title="Rename tag"
                                class="rounded-md px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                                onClick={() => {
                                  setRenamingId(tag.id);
                                  setRenameDraft(tag.name);
                                  setRenameError(null);
                                }}
                              >
                                ✎
                              </button>
                            }
                          >
                            <form
                              class="flex items-center gap-1"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void rename(tag.id);
                              }}
                            >
                              <input
                                class="w-32 rounded-md border border-neutral-200 bg-white px-2 py-0.5 text-xs outline-none focus:border-indigo-300 dark:border-neutral-700 dark:bg-neutral-900"
                                value={renameDraft()}
                                maxlength={24}
                                autofocus
                                onInput={(event) => setRenameDraft(event.currentTarget.value)}
                              />
                              <button type="submit" class="text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                                Save
                              </button>
                              <button
                                type="button"
                                class="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                                onClick={() => setRenamingId(null)}
                              >
                                ✕
                              </button>
                            </form>
                          </Show>
                          <button
                            type="button"
                            class={[
                              'rounded-md px-1.5 py-0.5 text-xs',
                              armId() === tag.id
                                ? 'bg-rose-100 font-semibold text-rose-700 dark:bg-rose-500/20 dark:text-rose-300'
                                : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200',
                            ]}
                            onClick={() => void remove(tag.id)}
                          >
                            {armId() === tag.id ? 'Delete?' : '🗑'}
                          </button>
                        </Show>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={renameError() || deleteError()}>
              <p class="mt-2 text-xs text-rose-600 dark:text-rose-400">{renameError() ?? deleteError()}</p>
            </Show>
          </>
        )}
      </Show>
    </main>
  );
}

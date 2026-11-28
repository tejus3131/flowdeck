import { Title } from '@solidjs/meta';
import { liveQuery, useSearchParams } from '@solidjs/router';
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';

import { Avatar } from '../components/Avatar';
import { FilterDropdown } from '../components/FilterDropdown';
import { MembershipWatch } from '../components/MembershipWatch';
import { searchCards, type SearchHit } from '../lib/boards';
import { brand } from '../lib/brand';
import { PriorityPill } from '../components/PriorityPill';
import {
  getMyWorkspaces,
  getWorkspaceSnapshot,
  workspaceStream,
  type WorkspaceDetail,
} from '../lib/workspaces';
import { cacheGet, cachePut, cachedStream } from '../lib/cache';

const PRIORITIES = ['', 'urgent', 'high', 'medium', 'low'];

/**
 * Workspace-wide card search — the GitHub-issues view: any card on any
 * board the viewer can see, filtered by text (title, description, #number),
 * tags, priority, assignee, creator, or board. Clicking a hit deep-links
 * to the card's board with the drawer open.
 */
export default function SearchPage() {
  const workspaces = createMemo(() => getMyWorkspaces());
  const workspaceId = () => workspaces().find((w) => w.current)?.id ?? '';

  // Members + tags for the filter bar — LIVE: access changes (grants,
  // revokes, invites) reshape the filter options and the results without
  // a refresh (the stream re-yields, the search re-runs).
  const [detail, setDetail] = createSignal<WorkspaceDetail | null>(null);
  const workspaceLive = liveQuery(workspaceStream, 'ws-search');
  createEffect(
    () => workspaceId(),
    (id, prev) => {
      if (!id) return;
      if (id !== prev) {
        setDetail(null);
        setDirty(true);
      }
      void (async () => {
        // Roster cache first (any board/members/team/search visit warms
        // the same key): the filter bar paints its people instantly, the
        // fetches behind revalidate and write back.
        const cached = await cacheGet<WorkspaceDetail>(`ws-detail:${id}`);
        if (cached) setDetail(cached);
        const first = await getWorkspaceSnapshot(id).catch(() => null);
        if (first) {
          setDetail(first);
          cachePut(`ws-detail:${id}`, first);
        }
        try {
          for await (const next of cachedStream(`ws-detail:${id}`, () => workspaceLive(id))) {
            setDetail(next);
            setDirty(true);
          }
        } catch {
          // the live feed is a nice-to-have; the snapshot stands alone
        }
      })();
    },
  );

  const [searchParams, setSearchParams] = useSearchParams<{
    tag?: string;
    q?: string;
    priority?: string;
    resolved?: string;
    board?: string;
  }>();
  const [query, setQuery] = createSignal('');
  const [selectedTags, setSelectedTags] = createSignal<string[]>([]);
  const [priorities, setPriorities] = createSignal<string[]>([]);
  const [assignees, setAssignees] = createSignal<string[]>([]);
  const [creators, setCreators] = createSignal<string[]>([]);
  const [untagged, setUntagged] = createSignal(false);
  // The time capsule (0059): the default search view is unresolved cards;
  // the resolved shelf (board settings) deep-links in with resolved ones.
  const [resolved, setResolved] = createSignal<'unresolved' | 'resolved' | 'both'>('unresolved');
  const [boards, setBoards] = createSignal<string[]>([]);
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [dirty, setDirty] = createSignal(true);

  // Deep link: /search?tag=backend preselects that tag.
  createEffect(
    () => (detail()?.tags.length ?? 0) > 0 && searchParams.tag,
    (tag) => {
      if (!tag) return;
      const match = detail()?.tags.find((t) => t.name === tag);
      if (match && !selectedTags().includes(match.id)) {
        setSelectedTags([match.id]);
        setDirty(true);
      }
    },
  );
  createEffect(
    () => (detail()?.tags.length ?? 0) > 0 && searchParams.q,
    (q) => {
      if (q) setQuery(q);
    },
  );
  // Deep link: /search?priority=high preselects that priority (the
  // activity timeline's priority chips route here).
  createEffect(
    () => searchParams.priority,
    (priority) => {
      if (priority && !priorities().includes(priority)) {
        setPriorities([priority]);
        setDirty(true);
      }
    },
  );
  // Deep link: ?resolved=resolved|both (the board settings resolved
  // shelf routes here).
  createEffect(
    () => searchParams.resolved,
    (value) => {
      if ((value === 'resolved' || value === 'both') && resolved() !== value) {
        setResolved(value);
        setDirty(true);
      }
    },
  );
  // Deep link: ?board=<id> preselects that board.
  createEffect(
    () => (detail()?.boards.length ?? 0) > 0 && searchParams.board,
    (boardId) => {
      if (
        boardId &&
        detail()?.boards.some((b) => b.id === boardId) &&
        !boards().includes(boardId)
      ) {
        setBoards([boardId]);
        setDirty(true);
      }
    },
  );

  // Run the search when filters change. The compute returns the filter
  // bundle itself (a fresh object every change) — Solid 2 skips the apply
  // when the computed value is identical, so a constant `true` would fire
  // exactly once.
  createEffect(
    () => ({
      q: query(),
      tags: selectedTags(),
      priorities: priorities(),
      assignees: assignees(),
      creators: creators(),
      untagged: untagged(),
      resolved: resolved(),
      boards: boards(),
      ws: workspaceId(),
      dirty: dirty(),
    }),
    (filters) => {
      // dirty is only consumed once the workspace id is known — otherwise
      // the very first search is swallowed while the query loads and never
      // re-runs.
      if (!filters.dirty || !filters.ws) return;
      setDirty(false);
      setBusy(true);
      // Only set keys cross the wire — undefined values make the server
      // function codec reject the call before it ever leaves the page.
      void searchCards({
        ...(filters.q.trim() ? { query: filters.q.trim() } : {}),
        resolved: filters.resolved,
        ...(filters.boards.length > 0 ? { boardIds: filters.boards } : {}),
        ...(filters.tags.length > 0 ? { tagIds: filters.tags } : {}),
        ...(filters.priorities.length > 0 ? { priorities: filters.priorities } : {}),
        ...(filters.assignees.length > 0 ? { assigneeIds: filters.assignees } : {}),
        ...(filters.creators.length > 0 ? { creatorIds: filters.creators } : {}),
        ...(filters.untagged ? { untagged: true } : {}),
      })
        .then(setHits)
        .catch(() => setHits([]))
        .finally(() => setBusy(false));
    },
  );

  const memberName = (id: string | null) =>
    detail()?.members.find((m) => m.user_id === id)?.display_name ?? null;

  const reset = () => {
    setQuery('');
    setSelectedTags([]);
    setPriorities([]);
    setAssignees([]);
    setCreators([]);
    setUntagged(false);
    setSearchParams({ tag: '' }, { replace: true });
    setDirty(true);
  };

  return (
    <main class="mx-auto max-w-4xl px-4 py-8">
      <MembershipWatch />
      <Title>Search - {brand.name}</Title>
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">Search cards</h1>
          <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Every card across {workspaces().find((w) => w.current)?.name ?? 'your workspace'} —
            text, tags, priority, assignee, or creator.
          </p>
        </div>
        <a href="/" class="text-sm text-indigo-600 underline dark:text-indigo-400">
          ← Boards
        </a>
      </div>

      {/* ── filter bar ─────────────────────────────────────────────────── */}
      <div class="mt-6 flex flex-col gap-3">
        <input
          type="search"
          placeholder="Search title, description, or #number…"
          class="w-full"
          value={query()}
          onInput={(event) => {
            setQuery(event.currentTarget.value);
            setDirty(true);
          }}
        />
        <div class="flex flex-wrap items-center gap-2">
          <FilterDropdown
            label="Tags"
            items={(detail()?.tags ?? []).map((tag) => ({ value: tag.id, label: `#${tag.name}` }))}
            selected={selectedTags()}
            onChange={(next) => {
              setSelectedTags(next);
              setDirty(true);
            }}
            searchable
          />
          <FilterDropdown
            label="Priority"
            items={PRIORITIES.filter(Boolean).map((value) => ({ value, label: value }))}
            leading={[{ value: '__none', label: 'No priority' }]}
            selected={priorities()}
            onChange={(next) => {
              setPriorities(next);
              setDirty(true);
            }}
          />
          <FilterDropdown
            label="Status"
            items={[
              { value: 'unresolved', label: 'Unresolved' },
              { value: 'resolved', label: 'Resolved' },
              { value: 'both', label: 'Both' },
            ]}
            leading={[]}
            selected={[resolved()]}
            onChange={(next) => {
              setResolved((next[0] as 'unresolved' | 'resolved' | 'both') ?? 'unresolved');
              setDirty(true);
            }}
          />
          <FilterDropdown
            label="Board"
            items={(detail()?.boards ?? []).map((board) => ({
              value: board.id,
              label: board.name,
            }))}
            selected={boards()}
            onChange={(next) => {
              setBoards(next);
              setDirty(true);
            }}
            searchable
          />
          <FilterDropdown
            label="Assignee"
            items={(detail()?.members ?? []).map((member) => ({
              value: member.user_id,
              label: member.display_name ?? member.email ?? 'member',
            }))}
            leading={[{ value: '__none', label: 'Unassigned' }]}
            selected={assignees()}
            onChange={(next) => {
              setAssignees(next);
              setDirty(true);
            }}
            searchable
          />
          <FilterDropdown
            label="Creator"
            items={(detail()?.members ?? []).map((member) => ({
              value: member.user_id,
              label: member.display_name ?? member.email ?? 'member',
            }))}
            selected={creators()}
            onChange={(next) => {
              setCreators(next);
              setDirty(true);
            }}
            searchable
          />
          <Show
            when={
              untagged() ||
              selectedTags().length > 0 ||
              priorities().length > 0 ||
              assignees().length > 0 ||
              creators().length > 0 ||
              boards().length > 0 ||
              resolved() !== 'unresolved'
            }
          >
            <button
              type="button"
              class="text-xs font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
              onClick={reset}
            >
              Reset
            </button>
          </Show>
        </div>
      </div>

      {/* ── results ────────────────────────────────────────────────────── */}
      {/* No unmount-remount while re-searching: stale results stay on
          screen (the flash fix) — the loader only shows a cold start. */}
      <Show
        when={hits().length > 0 || !busy()}
        fallback={<p class="mt-8 text-sm text-neutral-400">Searching…</p>}
      >
        <p class="mt-6 text-xs text-neutral-400">
          {hits().length} card{hits().length === 1 ? '' : 's'}
        </p>
        <ul class="mt-3 flex flex-col gap-2">
          <For each={hits()}>
            {(hit) => (
              <li>
                <a
                  href={`/b/${hit.board_id}?card=${hit.id}`}
                  class="block rounded-xl border border-neutral-200 bg-white p-3.5 transition hover:border-indigo-300 hover:shadow-sm dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-indigo-700"
                >
                  <div class="flex items-start gap-2.5">
                    <span class="mt-0.5 shrink-0 rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                      {hit.number !== null ? `#${hit.number}` : '—'}
                    </span>
                    <div class="min-w-0 flex-1">
                      <p class="break-words text-sm font-semibold">{hit.title}</p>
                      <p class="mt-0.5 text-xs text-neutral-400">
                        on{' '}
                        <span class="font-medium text-neutral-500 dark:text-neutral-300">
                          {hit.board_name}
                        </span>{' '}
                        · by {memberName(hit.created_by) ?? 'a former member'} ·{' '}
                        {new Date(hit.updated_at).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </p>
                      <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Show when={hit.resolved_at}>
                          <span class="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                            Resolved
                          </span>
                        </Show>
                        <Show when={hit.priority}>
                          <PriorityPill priority={hit.priority!} />
                        </Show>
                        <For each={hit.tags}>
                          {(tag) => (
                            <span class="rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
                              #{tag.name}
                            </span>
                          )}
                        </For>
                        <For each={hit.assignees}>
                          {(userId) => {
                            const person = () =>
                              detail()?.members.find((m) => m.user_id === userId);
                            return (
                              <Avatar
                                src={person()?.avatar_url}
                                name={person()?.display_name}
                                email={person()?.email}
                                size="sm"
                              />
                            );
                          }}
                        </For>
                      </div>
                    </div>
                  </div>
                </a>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </main>
  );
}

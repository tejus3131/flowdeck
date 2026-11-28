// One tag's page — the tag's TIME CAPSULE. Everything that happened to
// the tag, newest first, as one infinite-scroll event feed: cited in
// board chat, in a card comment, in a card description; added to a
// card; removed from a card. A search box and a time window filter the
// entries. The tagged-cards list lives on the search page (?tag=) —
// this page links out instead of duplicating it.
import { Title } from '@solidjs/meta';
import { type RouteProps, liveQuery } from '@solidjs/router';
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onSettled } from 'solid-js';

import { Avatar } from '../../../../components/Avatar';
import { browserClient } from '../../../../lib/supabase-client';
import { getTagEvents, pageSlices, updateTag, type TagEventRow } from '../../../../lib/tags';
import { createEngine } from '../../../../lib/sync';
import { mergeWorkspaceDetail } from '../../../../lib/workspace-ops';
import {
  getWorkspaceSnapshot,
  workspaceStream,
  type WorkspaceDetail,
} from '../../../../lib/workspaces';
import { errorMessage } from '../../../../lib/error-message';
import { cachedStream, cachePut } from '../../../../lib/cache';
import { useEntities } from '../../../../lib/entity-store';
import { perfFirstValue } from '../../../../lib/perf';
import { brand } from '../../../../lib/brand';

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

const PAGE = 30;

const TIME_WINDOWS: Array<{ id: string; label: string; days: number | null }> = [
  { id: 'any', label: 'Any time', days: null },
  { id: '7', label: 'Past week', days: 7 },
  { id: '30', label: 'Past month', days: 30 },
  { id: '90', label: 'Past 3 months', days: 90 },
];

export default function TagPage(props: RouteProps<'/w/:workspaceId/tags/:tagId'>) {
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
    // The vocabulary lands in the entity store with every snapshot.
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
  // The tag row resolves from the entity store (phase 1, ADR-1): a rename
  // on ANY surface — here, the board, another tab — lands as one store
  // write and this page's heading, chips, and links move in that frame.
  const tag = createMemo(() => entities.tagById(props.params.tagId) ?? null);
  const isAdmin = () => detail()?.myRole === 'owner' || detail()?.myRole === 'admin';

  // ── filters: search through the entries + a time window ─────────────
  // The input is debounced: the feed resets on the settled value, not on
  // every keystroke — typing 'design' is one fetch, not six.
  const [queryInput, setQueryInput] = createSignal('');
  const [query, setQuery] = createSignal('');
  let queryTimer: ReturnType<typeof setTimeout> | undefined;
  const onQueryInput = (value: string) => {
    setQueryInput(value);
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => setQuery(value), 300);
  };
  onCleanup(() => clearTimeout(queryTimer));
  const [windowDays, setWindowDays] = createSignal<number | null>(null);
  const windowFrom = () => {
    const days = windowDays();
    return days === null ? undefined : new Date(Date.now() - days * 86400_000).toISOString();
  };

  // ── the event feed: infinite scroll over the RPC's pages ────────────
  const [events, setEvents] = createSignal<TagEventRow[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal(false);
  const [feedError, setFeedError] = createSignal<string | null>(null);
  const loadMore = async () => {
    if (busy() || done() || !tag()) return;
    const gen = feedGen;
    setBusy(true);
    try {
      const from = windowFrom();
      const page = await getTagEvents(props.params.tagId, {
        offset: events().length,
        limit: PAGE,
        query: query(),
        ...(from ? { from } : {}),
      });
      if (gen !== feedGen) return; // a filter/tag change happened mid-flight
      setEvents([...events(), ...page]);
      if (page.length < PAGE) setDone(true);
    } catch (err) {
      if (gen === feedGen) {
        setFeedError(errorMessage(err));
        setDone(true);
      }
    } finally {
      setBusy(false);
      // A change raced this page: its own first page still needs loading
      // (the reset's call returned early on busy).
      if (gen !== feedGen) void loadMore();
    }
  };
  // A stale in-flight page must never append rows for the previous
  // filter/tag: each reset bumps the generation, late results discard
  // themselves.
  let feedGen = 0;
  const resetFeed = () => {
    feedGen++;
    setEvents([]);
    setDone(false);
    setFeedError(null);
    // Solid 2.0's reads lag writes: loadMore must see the reset's
    // setDone(false) — the microtask boundary lets the flush land first.
    // oxlint-disable-next-line solid/reactivity -- deferred on purpose: the write flush must land before loadMore reads the reset state
    queueMicrotask(() => void loadMore());
  };
  createEffect(
    () => [props.params.tagId, tag()?.id] as const,
    ([tagId, id]) => {
      if (tagId && id) resetFeed();
    },
  );
  // Filter changes reset the feed (tag identity didn't change).
  createEffect(
    () => [query(), windowDays()] as const,
    () => {
      if (tag()) resetFeed();
    },
  );
  // The sentinel: attach on every mount — the observer outlives re-mounts.
  let observer: IntersectionObserver | undefined;
  const ensureObserver = () => {
    if (!observer) {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      });
    }
    return observer;
  };
  onCleanup(() => observer?.disconnect());
  const attachSentinel = (el: HTMLDivElement) => {
    if (el) ensureObserver().observe(el);
  };

  // ── live: new events arrive without a reload ─────────────────────────
  // The feed is a union over several surfaces, so there is no single
  // table to filter by tag — the page watches board_messages,
  // card_comments, and card_tags (add/remove) broadly (RLS limits
  // events to boards this viewer can see) and re-runs the loaded
  // window, debounced. Renames arrive through the workspace engine's
  // tags stream.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshWindow = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      const gen = feedGen;
      if (busy()) {
        refreshWindow();
        return;
      }
      setBusy(true);
      const tagId = props.params.tagId;
      // New events land at the TOP (newest first): refreshing the loaded
      // depth plus one page keeps the tail row from dropping off. The
      // RPC caps a single call at 100, so the window walks consecutive
      // slices — an infinite-scrolled feed keeps its depth.
      const target = events().length + PAGE;
      try {
        const rows: TagEventRow[] = [];
        const from = windowFrom();
        for (const { offset, limit } of pageSlices(target)) {
          const slice = await getTagEvents(tagId, {
            offset,
            limit,
            query: query(),
            ...(from ? { from } : {}),
          });
          rows.push(...slice);
          if (slice.length < limit) break; // the feed ran out
        }
        // A filter/tag change raced this fetch: the reset's own load wins.
        if (gen !== feedGen || tagId !== props.params.tagId) return;
        setEvents(rows);
        if (rows.length < target) setDone(true);
      } catch {
        // Best-effort live refresh — the next event (or a reload) retries.
      } finally {
        setBusy(false);
      }
    }, 500);
  };
  onSettled(() => {
    const client = browserClient();
    if (!client) return () => undefined;
    // card_tags covers add/remove events; cards UPDATEs (drags) are
    // deliberately not watched — a colleague rearranging a board would
    // keep resetting the debounce.
    const channel = client
      .channel(`tag-events:${props.params.workspaceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'board_messages' },
        refreshWindow,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'card_comments' },
        refreshWindow,
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'card_tags' }, refreshWindow)
      .subscribe();
    return () => {
      clearTimeout(refreshTimer);
      void client.removeChannel(channel);
    };
  });

  // ── editing (owners/admins): name and description. Tags are never
  // deleted — links in messages, comments, and descriptions would
  // dangle; a rename keeps every link alive.
  const [renaming, setRenaming] = createSignal(false);
  const [renameDraft, setRenameDraft] = createSignal('');
  const [renameError, setRenameError] = createSignal<string | null>(null);
  const rename = async () => {
    if (!renameDraft().trim()) return;
    setRenameError(null);
    try {
      await updateTag(props.params.tagId, { name: renameDraft() });
      setRenaming(false);
      await engine.refresh();
    } catch (err) {
      setRenameError(errorMessage(err));
    }
  };
  const [editingDescription, setEditingDescription] = createSignal(false);
  const [descriptionDraft, setDescriptionDraft] = createSignal('');
  const [descriptionError, setDescriptionError] = createSignal<string | null>(null);
  const saveDescription = async () => {
    setEditingDescription(false);
    setDescriptionError(null);
    try {
      await updateTag(props.params.tagId, { description: descriptionDraft() });
      await engine.refresh();
    } catch (err) {
      setDescriptionError(errorMessage(err));
    }
  };

  const kindLabel: Record<TagEventRow['kind'], string> = {
    chat: 'chat',
    comment: 'comment',
    description: 'description',
    tagged: 'added to card',
    untagged: 'removed from card',
  };
  const eventHref = (row: TagEventRow) =>
    row.kind === 'chat'
      ? `/b/${row.board_id}?chat=${row.message_id ?? ''}`
      : row.kind === 'comment'
        ? `/b/${row.board_id}?card=${row.card_id ?? ''}&comment=${row.comment_id ?? ''}`
        : row.kind === 'description'
          ? `/b/${row.board_id}?card=${row.card_id ?? ''}&event=description`
          : `/b/${row.board_id}?card=${row.card_id ?? ''}`;
  const eventWhere = (row: TagEventRow) =>
    row.kind === 'chat'
      ? `in #${row.board_name}`
      : row.kind === 'tagged'
        ? `added this tag to #${row.card_title}`
        : row.kind === 'untagged'
          ? `removed this tag from #${row.card_title}`
          : row.kind === 'description'
            ? `in #${row.card_title}'s description`
            : `on #${row.card_title} · ${row.board_name}`;

  return (
    <main class="mx-auto max-w-3xl px-4 py-10">
      <Title>{tag() ? `#${tag()?.name} - ${brand.name}` : `Tag - ${brand.name}`}</Title>
      <Show when={detail()} fallback={<p class="mt-8 text-sm text-neutral-400">Loading…</p>}>
        {(data) => (
          <>
            <div class="flex items-center justify-between">
              <div class="min-w-0">
                <Show
                  when={tag()}
                  fallback={<h1 class="text-2xl font-semibold tracking-tight">Tag not found</h1>}
                >
                  {(t) => (
                    <Show
                      when={!renaming()}
                      fallback={
                        <form
                          class="flex items-center gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void rename();
                          }}
                        >
                          <input
                            class="text-2xl font-semibold tracking-tight"
                            value={renameDraft()}
                            maxlength={24}
                            autofocus
                            onInput={(event) => setRenameDraft(event.currentTarget.value)}
                          />
                          <button
                            type="submit"
                            class="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            class="text-xs font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                            onClick={() => setRenaming(false)}
                          >
                            Cancel
                          </button>
                        </form>
                      }
                    >
                      <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                        <span class="rounded-md bg-sky-100 px-2 py-0.5 text-xl font-semibold text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">
                          #{t().name}
                        </span>
                        <Show when={isAdmin()}>
                          <button
                            type="button"
                            title="Rename tag"
                            class="rounded-md px-1.5 py-0.5 text-sm text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                            onClick={() => {
                              setRenameDraft(t().name);
                              setRenaming(true);
                            }}
                          >
                            ✎
                          </button>
                        </Show>
                      </h1>
                    </Show>
                  )}
                </Show>
                <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {data().workspace.name}
                  <Show when={tag()?.description}> · {tag()?.description}</Show>
                </p>
              </div>
              <div class="flex flex-col items-end gap-1">
                <a
                  href={`/w/${props.params.workspaceId}/tags`}
                  class="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  All tags →
                </a>
                <Show when={tag()}>
                  <a
                    href={`/search?tag=${encodeURIComponent(tag()?.name ?? '')}`}
                    class="text-xs font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                  >
                    Cards with this tag →
                  </a>
                </Show>
              </div>
            </div>
            <Show when={renameError()}>
              <p class="mt-1 text-xs text-rose-600 dark:text-rose-400">{renameError()}</p>
            </Show>

            {/* Description: display prose, admins edit in place. */}
            <div class="mt-4">
              <div class="flex items-center justify-between">
                <span class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                  Description
                </span>
                <Show when={isAdmin() && !editingDescription()}>
                  <button
                    type="button"
                    class="rounded-md px-1.5 py-0.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950"
                    onClick={() => {
                      setDescriptionDraft(tag()?.description ?? '');
                      setEditingDescription(true);
                    }}
                  >
                    {tag()?.description ? 'Edit' : 'Add description'}
                  </button>
                </Show>
              </div>
              <Show
                when={!editingDescription()}
                fallback={
                  <div class="mt-1 flex flex-col gap-1.5">
                    <textarea
                      class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-indigo-700 dark:focus:ring-indigo-900"
                      rows={3}
                      maxlength={500}
                      value={descriptionDraft()}
                      onInput={(event) => setDescriptionDraft(event.currentTarget.value)}
                    />
                    <div class="flex justify-end gap-2">
                      <button
                        type="button"
                        class="rounded-lg px-2.5 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        onClick={() => setEditingDescription(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        class="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
                        onClick={() => void saveDescription()}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                }
              >
                <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
                  {tag()?.description || (
                    <span class="text-neutral-400">
                      What this tag means — scope, conventions, when to use it.
                    </span>
                  )}
                </p>
              </Show>
              <Show when={descriptionError()}>
                <p class="mt-1 text-xs text-rose-600 dark:text-rose-400">{descriptionError()}</p>
              </Show>
            </div>

            {/* The event capsule: filters + one infinite feed. */}
            <section class="mt-8">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h2 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                  Everything about this tag
                </h2>
                <div class="flex items-center gap-2">
                  <input
                    class="w-44 rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs shadow-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-indigo-700 dark:focus:ring-indigo-900"
                    placeholder="Search these entries…"
                    value={queryInput()}
                    onInput={(event) => onQueryInput(event.currentTarget.value)}
                  />
                  <select
                    class="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs shadow-sm outline-none focus:border-indigo-300 dark:border-neutral-700 dark:bg-neutral-900"
                    value={windowDays() ?? 'any'}
                    onChange={(event) => {
                      const found = TIME_WINDOWS.find((w) => w.id === event.currentTarget.value);
                      setWindowDays(found?.days ?? null);
                    }}
                  >
                    <For each={TIME_WINDOWS}>{(w) => <option value={w.id}>{w.label}</option>}</For>
                  </select>
                </div>
              </div>
              <Show
                when={events().length > 0 || done()}
                fallback={<p class="mt-2 text-sm text-neutral-400">Loading…</p>}
              >
                <ul class="mt-2 flex flex-col gap-2">
                  <For each={events()}>
                    {(row) => (
                      <li>
                        <a
                          href={eventHref(row)}
                          class="flex items-start gap-2.5 rounded-xl px-2 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                        >
                          <Avatar src={row.avatar_url} name={row.author} size="sm" />
                          <span class="min-w-0 flex-1">
                            <span class="flex items-center gap-2 text-[11px] text-neutral-400">
                              <span class="font-semibold text-neutral-500 dark:text-neutral-300">
                                {row.author}
                              </span>
                              <span class="rounded bg-neutral-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                                {kindLabel[row.kind]}
                              </span>
                              <time>
                                {new Date(row.created_at).toLocaleString(undefined, {
                                  month: 'short',
                                  day: 'numeric',
                                  hour: 'numeric',
                                  minute: '2-digit',
                                })}
                              </time>
                            </span>
                            <span class="mt-0.5 block text-sm text-neutral-700 dark:text-neutral-300">
                              {eventWhere(row)}
                            </span>
                            <span class="mt-0.5 block truncate text-xs text-neutral-400">
                              {row.snippet}
                            </span>
                          </span>
                        </a>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={feedError()}>
                  <p class="mt-2 text-xs text-rose-600 dark:text-rose-400">{feedError()}</p>
                </Show>
                <Show
                  when={!done() && !feedError()}
                  fallback={
                    <Show when={done() && events().length === 0}>
                      <p class="mt-3 text-sm text-neutral-400">
                        {query() || windowDays() !== null
                          ? 'Nothing matches these filters.'
                          : 'Nothing has cited this tag yet — no chat messages, comments, descriptions, or cards.'}
                      </p>
                    </Show>
                  }
                >
                  <div ref={attachSentinel} class="py-3 text-center text-xs text-neutral-400">
                    {busy() ? 'Loading…' : ''}
                  </div>
                </Show>
              </Show>
            </section>
          </>
        )}
      </Show>
    </main>
  );
}

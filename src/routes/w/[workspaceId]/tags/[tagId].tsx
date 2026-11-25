// One tag's page — where a #tag chip lands. The vocabulary entry itself,
// the cards carrying it, and every mention of it across the workspace
// (board chat, card comments, descriptions) as one infinite-scroll feed.
import { Title } from '@solidjs/meta';
import { type RouteProps, liveQuery } from '@solidjs/router';
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onSettled } from 'solid-js';

import { Avatar } from '../../../../components/Avatar';
import { browserClient } from '../../../../lib/supabase-client';
import { createEngine } from '../../../../lib/sync';
import { mergeWorkspaceDetail } from '../../../../lib/workspace-ops';
import {
  getTagMentions,
  getTaggedCards,
  updateTag,
  type TagMentionRow,
  type TaggedCard,
} from '../../../../lib/tags';
import {
  getWorkspaceSnapshot,
  workspaceStream,
  type WorkspaceDetail,
} from '../../../../lib/workspaces';
import { errorMessage } from '../../../../lib/error-message';
import { cachedStream, cachePut } from '../../../../lib/cache';
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

const PAGE = 30;

export default function TagPage(props: RouteProps<'/w/:workspaceId/tags/:tagId'>) {
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
  const tag = createMemo(() => (detail()?.tags ?? []).find((t) => t.id === props.params.tagId) ?? null);
  const isAdmin = () => detail()?.myRole === 'owner' || detail()?.myRole === 'admin';

  // Cards carrying the tag (RLS: visible boards only). Same-route
  // navigation (tag A → tag B) re-runs the read for the new tag.
  const [cards, setCards] = createSignal<TaggedCard[]>([]);
  createEffect(
    () => props.params.tagId,
    (tagId) => {
      if (tagId) getTaggedCards(tagId).then(setCards).catch(() => {});
    },
  );

  // ── the mention feed: infinite scroll over the RPC's pages ───────────
  const [mentions, setMentions] = createSignal<TagMentionRow[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal(false);
  const [feedError, setFeedError] = createSignal<string | null>(null);
  // A stale in-flight page must never append rows for the previous tag:
  // each reset bumps the generation, late results discard themselves.
  let feedGen = 0;
  const loadMore = async () => {
    if (busy() || done() || !tag()) return;
    const gen = feedGen;
    setBusy(true);
    try {
      const page = await getTagMentions(props.params.tagId, mentions().length, PAGE);
      if (gen !== feedGen) return; // a tag switch happened mid-flight
      setMentions([...mentions(), ...page]);
      if (page.length < PAGE) setDone(true);
    } catch (err) {
      if (gen === feedGen) {
        setFeedError(errorMessage(err));
        setDone(true);
      }
    } finally {
      setBusy(false);
      // A switch raced this page: its own first page still needs loading
      // (the reset's call returned early on busy).
      if (gen !== feedGen) void loadMore();
    }
  };
  // The feed resets with the tag: navigating tag A → tag B refetches from
  // page 0 for the new id. The sentinel mounts AFTER the first page (it
  // sits inside the feed's Show), so observation happens in the ref
  // callback — the observer outlives Show re-mounts and each mount
  // re-attaches to whatever element the ref hands it.
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
  createEffect(
    () => [props.params.tagId, tag()?.id] as const,
    ([tagId, id]) => {
      if (!tagId || !id) return;
      feedGen++;
      setMentions([]);
      setDone(false);
      setFeedError(null);
      void loadMore();
    },
  );

  // ── live: mentions arrive without a reload ───────────────────────────
  // The feed is a union over three surfaces, so there is no single table
  // to filter by tag — the page watches board_messages, card_comments,
  // and cards (description edits) broadly (RLS limits events to boards
  // this viewer can see) and re-runs the loaded window, debounced. The
  // header (name/description) is already live through the workspace
  // engine's tags stream.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshWindow = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (busy()) {
        refreshWindow();
        return;
      }
      const tagId = props.params.tagId;
      // Keep the loaded depth (infinite scroll keeps its place); cap at
      // the RPC's page ceiling.
      const size = Math.min(Math.max(PAGE, mentions().length), 100);
      try {
        const rows = await getTagMentions(tagId, 0, size);
        // A tag switch raced this fetch: the reset's own load wins.
        if (tagId !== props.params.tagId) return;
        setMentions(rows);
        if (rows.length < size) setDone(true);
      } catch {
        // Best-effort live refresh — the next event (or a reload) retries.
      }
    }, 500);
  };
  onSettled(() => {
    const client = browserClient();
    if (!client) return () => undefined;
    const channel = client
      .channel(`tag-mentions:${props.params.workspaceId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'board_messages' }, refreshWindow)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'card_comments' }, refreshWindow)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, refreshWindow)
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

  const mentionHref = (row: TagMentionRow) =>
    row.kind === 'chat'
      ? `/b/${row.board_id}?chat=${row.message_id ?? ''}`
      : `/b/${row.board_id}?card=${row.card_id ?? ''}`;

  return (
    <main class="mx-auto max-w-3xl px-4 py-10">
      <Title>{tag() ? `#${tag()?.name} - Flowdeck` : 'Tag - Flowdeck'}</Title>
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
                </p>
              </div>
              <a
                href={`/w/${props.params.workspaceId}/tags`}
                class="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                All tags →
              </a>
            </div>
            <Show when={renameError()}>
              <p class="mt-1 text-xs text-rose-600 dark:text-rose-400">{renameError()}</p>
            </Show>

            {/* Description: display prose, admins edit in place. Tags are
                never deleted — this is the whole maintenance surface. */}
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

            {/* Cards carrying the tag. */}
            <section class="mt-6">
              <h2 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Cards ({cards().length})
              </h2>
              <Show
                when={cards().length > 0}
                fallback={<p class="mt-2 text-sm text-neutral-400">No cards carry this tag.</p>}
              >
                <ul class="mt-2 flex flex-wrap gap-1.5">
                  <For each={cards()}>
                    {(card) => (
                      <li>
                        <a
                          href={`/b/${card.board_id}?card=${card.card_id}`}
                          class="inline-flex items-center gap-1 rounded-lg border border-neutral-200 px-2 py-1 text-xs hover:border-indigo-300 hover:bg-indigo-50 dark:border-neutral-700 dark:hover:border-indigo-700 dark:hover:bg-indigo-950"
                        >
                          <span class="font-medium">{card.card_title}</span>
                          <span class="text-neutral-400">#{card.card_number ?? '—'}</span>
                          <span class="text-neutral-400">· {card.board_name}</span>
                        </a>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>

            {/* The mention feed: chat, comments, descriptions — newest first. */}
            <section class="mt-8">
              <h2 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Mentions
              </h2>
              <Show
                when={mentions().length > 0 || done()}
                fallback={<p class="mt-2 text-sm text-neutral-400">Loading…</p>}
              >
                <ul class="mt-2 flex flex-col gap-2">
                  <For each={mentions()}>
                    {(row) => (
                      <li>
                        <a
                          href={mentionHref(row)}
                          class="flex items-start gap-2.5 rounded-xl px-2 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                        >
                          <Avatar src={row.avatar_url} name={row.author} size="sm" />
                          <span class="min-w-0 flex-1">
                            <span class="flex items-center gap-2 text-[11px] text-neutral-400">
                              <span class="font-semibold text-neutral-500 dark:text-neutral-300">
                                {row.author}
                              </span>
                              <span class="rounded bg-neutral-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                                {row.kind === 'chat'
                                  ? 'chat'
                                  : row.kind === 'comment'
                                    ? 'comment'
                                    : 'description'}
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
                              {row.kind === 'chat' ? (
                                <>in #{row.board_name}</>
                              ) : (
                                <>on #{row.card_title} · {row.board_name}</>
                              )}
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
                    <Show when={done() && mentions().length === 0}>
                      <p class="mt-3 text-sm text-neutral-400">
                        Nothing cites this tag yet — no chat messages, comments, or descriptions.
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

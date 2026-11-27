// Extracted from the board route (phase 6): a panel is its own module
// so the route stays a wiring file (L5 rule 6).
import { liveQuery, useNavigate, useSearchParams } from '@solidjs/router';
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onSettled } from 'solid-js';

import { Avatar } from '../Avatar';
import { PriorityPill } from '../PriorityPill';
import { TagChip } from '../TagChip';
import { ChatPrefMenu } from './ChatPrefMenu';
import { DescriptionDiffEvent } from './DescriptionDiffEvent';
import { SmartTextarea } from './SmartTextarea';
import { TagInput } from './TagInput';
import { tombstoneLine } from './lines';
import { createEngine } from '../../lib/sync';
import { perfFirstValue } from '../../lib/perf';
import { cachedStream } from '../../lib/cache';
import { type BoardOpPayload } from '../../lib/board-ops';
import { renderMarkdown } from '../../lib/markdown';
import { mentionIds, mentionTeamIds } from '../../lib/notification-text';
import { markSeen } from '../../lib/seen';
import { openCardScope } from '../../lib/open-scopes';
import { markCardNotificationsSeen } from '../../lib/notifications';
import {
  checkMentionAccess,
  grantMentionAccess,
  requestMentionAccess,
  type BlockedMention,
} from '../../lib/access';
import {
  addComment,
  boardStream,
  chatSeq,
  deleteComment,
  editComment,
  getCardComments,
  getCardEvents,
  type CardEventRow,
  type CardView,
  type CommentRow,
  type CrossCard,
} from '../../lib/boards';
import {
  commentsSlice as commentsSliceOver,
  timelineSlice as timelineSliceOver,
} from '../../lib/board-slices';

import { type Member, type TeamView } from '../../lib/workspaces';
import {
  checkTeamMentionAccess,
  grantTeamMentionAccess,
  requestTeamMentionAccess,
  type BlockedTeam,
} from '../../lib/access';
import { errorMessage } from '../../lib/error-message';
import type { CommentBusEvent, CommentOp } from './comment-bus';

export function CardDrawer(props: {
  cardId: string;
  /** The board's id — the TOPIC's key. The drawer's slices subscribe to
   *  the board stream by THIS id and filter per-card digests client-side;
   *  keying the topic by the card id would spin a phantom, denied board
   *  topic whose digests never arrive (the poll would mask it at 20s). */
  boardId: string;
  /** The card's client_op — lets the drawer survive the provisional→
   *  durable id swap (a relayed card's temp id differs from its echo). */
  clientOp: string | null;
  cards: CardView[];
  members: Member[];
  /** The board's workspace (tag creation is workspace-scoped). */
  workspaceId: string;
  /** The workspace's existing tag vocabulary (chips + suggestions). */
  workspaceTags: { id: string; name: string }[];
  /** Cross-board card targets for # references. */
  crossCards: CrossCard[];
  /** The workspace's boards — the # menu offers cross-board citations
   *  (chips serialize as [name](board:<uuid>) → board backlinks). */
  workspaceBoards?: { id: string; name: string }[];
  canEdit: boolean;
  /** The board's name — citation chips read "Board #12". */
  boardName: string;
  /** May editors grant board access themselves (the board's setting)? */
  accessDelegation: boolean;
  /** Workspace owners/admins can always grant — the panel adapts. */
  isWsAdmin: boolean;
  /** The viewer's workspace role when it can delete others' comments
   *  (0057: owners/admins delete, they no longer edit others'). */
  myWsRole: 'owner' | 'admin' | null;
  /** Team admin of a team with edit access to this board — may delete. */
  myTeamAdmin: { teamId: string; teamName: string } | null;
  /** A mention-grant landed: mirror it on the workspace relay. */
  onAccessGranted: (userIds: string[]) => void;
  /** A TEAM mention-grant landed: mirror it on the workspace relay. */
  onTeamAccessGranted: (teamIds: string[]) => void;
  myId: string | null;
  myAvatar: string | null;
  /** The workspace's teams — @autocomplete offers them too. */
  teams: TeamView[];
  myName: string;
  onClose: () => void;
  /** Resolve/unresolve the card with this (swap-resolved) id — the time
   *  capsule's hide/unhide (0059); nothing is ever deleted. */
  onResolve: (cardId: string, resolved: boolean) => void;
  onUpdate: (patch: {
    title?: string;
    description?: string;
    priority?: string | null;
    tags?: { id: string; name: string }[];
    assignees?: string[];
  }) => void;
  /** Board-side half of a post: stats bump + relay under the given id. */
  onPostComment: (
    payload: Extract<BoardOpPayload, { kind: 'comment-created' }>,
    relayOpId: string,
  ) => void;
  /** The insert failed: the board page reverts + relays the failure. */
  onCommentFail: (relayOpId: string) => void;
  /** The board page's relay feed — received ops append here, failures drop. */
  onCommentArrived: (listener: (event: CommentBusEvent) => void) => () => void;
  onOpenCardRef: (num: number) => void;
  /** Detail hover cards: a user id or a card number under the pointer. */
  onHover: (
    target: { kind: 'user' | 'card' | 'tag' | 'team'; id: string; rect: DOMRect } | null,
  ) => void;
  /** The shared panel width helper (resize handle + width style). */
  panelWidth: {
    width: () => number | null;
    dragging: () => boolean;
    startDrag: (event: MouseEvent) => void;
  };
  /** A cross-board reference was clicked — route to that board's card,
   *  optionally landing ON the citing comment / description event (the
   *  board-backlink chip carries the anchor). */
  onOpenCrossCard: (cardId: string, anchor?: { commentId?: string; event?: string }) => void;
  /** A tag chip was clicked — jump to search filtered by it. */
  onOpenTag: (tagId: string) => void;
}) {
  // Swap-safe resolution: a card clicked mid-provisional carries a temp id;
  // the durable echo swaps it (same client_op, new id). Resolve by id first,
  // then by client_op — every server call and stream key uses the result.
  const card = createMemo(
    () =>
      props.cards.find((c) => c.id === props.cardId) ??
      (props.clientOp ? props.cards.find((c) => c.client_op === props.clientOp) : undefined),
  );
  const cardIdNow = () => card()?.id ?? props.cardId;

  /** What counts as REAL in this card's markdown: board members (mentions)
   *  and the card numbers that exist (#citations). */
  const markdownContext = () => ({
    members: props.members,
    // Boards the viewer can reach — board chips resolve current names and
    // render locked for the rest (same privacy the card gate has).
    boards: props.workspaceBoards ?? [],
    // Org-wide numbers (#N is unique across the workspace now): the union
    // of this board's cards and every card reachable cross-board.
    cardNumbers: [
      ...props.cards.map((c) => c.number).filter((number): number is number => number !== null),
      ...props.crossCards
        .map((c) => c.number)
        .filter((number): number is number => number !== null),
    ],
    // Citations always name the board ("Board #12") so they can't be
    // confused with #tags of the same name.
    cardRefs: new Map<number, { title: string | null; board: string }>(
      [
        ...props.cards.map((c) => [c.number, { title: c.title, board: props.boardName }]),
        ...props.crossCards.map((c) => [c.number, { title: c.title, board: c.board_name }]),
      ].filter(([num]) => num !== null) as [number, { title: string | null; board: string }][],
    ),
    // Everything this viewer can reach: this board's cards + cross-board
    // cards. References beyond the set render as private.
    accessibleCardIds: new Set<string>([
      ...props.cards.map((c) => c.id),
      ...props.crossCards.map((c) => c.id),
    ]),
    // Cross-board chips read "Board › Card title".
    crossCards: new Map(
      props.crossCards.map((c) => [c.id, { title: c.title, board: c.board_name }]),
    ),
    // Team chips resolve to the team's current name.
    teams: props.teams,
    // Tag chips too — renames update every rendered body live.
    tags: props.workspaceTags,
  });

  // Escape closes (the same affordance the settings drawer has).
  const onDrawerKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') props.onClose();
  };
  document.addEventListener('keydown', onDrawerKey);
  onCleanup(() => document.removeEventListener('keydown', onDrawerKey));

  // The assignee picker closes on click-away (document-level listener;
  // the picker's own subtree stops propagation).
  const onPickerAway = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (pickerOpen() && !target?.closest?.('[data-assign-picker]')) setPickerOpen(false);
  };
  document.addEventListener('mousedown', onPickerAway);
  onCleanup(() => document.removeEventListener('mousedown', onPickerAway));

  const [titleDraft, setTitleDraft] = createSignal(card()?.title ?? '');
  createEffect(
    () => card()?.title,
    (title) => {
      if (title !== undefined && !titleDraft()) setTitleDraft(title);
    },
  );

  // Description: rendered markdown by default, textarea when editing.
  const [editingBody, setEditingBody] = createSignal(false);
  const [pickerOpen, setPickerOpen] = createSignal(false);

  // One drawer, two tabs — chat (comments) and settings, each full height.
  const [tab, setTab] = createSignal<'chat' | 'settings'>('chat');
  // An open drawer is an open scope (its fresh rows don't toast); it
  // re-keys when the provisional id swaps for the durable echo.
  let releaseScope: (() => void) | undefined;
  createEffect(
    () => cardIdNow(),
    (id) => {
      releaseScope?.();
      releaseScope = openCardScope(id);
    },
  );
  onCleanup(() => releaseScope?.());

  // ── comments pagination: latest page first, older on demand ──────────
  const [older, setOlder] = createSignal<CommentRow[]>([]);
  const [loadingEarlier, setLoadingEarlier] = createSignal(false);
  const [noMoreEarlier, setNoMoreEarlier] = createSignal(false);
  const dedup = (rows: CommentRow[]) => {
    const seen = new Set<string>();
    return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
  };
  const loadEarlier = async () => {
    const list = comments();
    const oldest = list[0]?.seq;
    if (!oldest) {
      setNoMoreEarlier(true);
      return;
    }
    setLoadingEarlier(true);
    try {
      const page = await getCardComments(cardIdNow(), props.clientOp ?? null, oldest, 30);
      setOlder(dedup([...(page.length < 30 ? [] : page), ...older()]));
      if (page.length < 30) setNoMoreEarlier(true);
    } catch {
      // best effort — the button stays for another try
    } finally {
      setLoadingEarlier(false);
    }
  };

  const [bodyDraft, setBodyDraft] = createSignal('');
  const startEditing = () => {
    setBodyDraft(card()?.description ?? '');
    setEditingBody(true);
  };
  const saveBody = () => {
    const description = bodyDraft();
    if (description !== card()?.description) {
      props.onUpdate({ description });
      checkBlocked(description);
    }
    setEditingBody(false);
  };

  // ── the activity timeline: every change to this card ────────────────
  // LIVE (phase 3, ADR-4): the events log streams its own rows and the
  // 10s poll is gone. The engine rides only the settings tab — the key
  // empties when it closes and the source idles without a channel.
  // The open mark keeps its old contract (ends at the first paint —
  // the cached page on a warm open, the live page cold).
  type TimelineSnapshot = { list: CardEventRow[] };
  // Phase 4 (ADR-3): the timeline rides the board TOPIC's event digest —
  // liveQuery dedupes by (name + args), so the drawer adds zero sockets.
  // The slice accumulates: the cold page from one fetch, then the topic's
  // new event rows append through foldTimelineBurst.
  // The slice (lib/board-slices, test-pinned): the topic by the BOARD
  // id, the page by the CARD id — the wrong key would spin a phantom
  // topic whose digests never arrive, masked only by the 20s poll.
  const topicLive = liveQuery(boardStream, 'board');
  const timelineSlice = (cardId: string) =>
    timelineSliceOver({
      boardId: props.boardId,
      cardId,
      topic: (boardId) => topicLive(boardId),
      fetchPage: (id) => getCardEvents(id),
    });
  const timelineEngine = createEngine<TimelineSnapshot>({
    streamSource: (key) =>
      (async function* (): AsyncGenerator<TimelineSnapshot> {
        if (!key) {
          yield { list: [] };
          return;
        }
        for await (const list of await perfFirstValue(
          cachedStream(
            `card-timeline:${key}`,
            () => timelineSlice(key),
            'card-timeline-revalidate',
          ),
          'card-timeline-open',
        )) {
          yield { list };
        }
      })(),
    key: () => (tab() === 'settings' ? cardIdNow() : ''),
    empty: { list: [] },
    clone: (snapshot) => ({ list: snapshot.list.slice() }),
    merge: (draft, snapshot) => {
      // Read-only trail: the durable list wins outright; the rows are
      // identity-stable (the stream reuses row objects), so unchanged
      // emissions write nothing.
      if (
        draft.list.length !== snapshot.list.length ||
        draft.list.some((row, i) => row !== snapshot.list[i])
      ) {
        draft.list = snapshot.list;
      }
    },
    status: () => topicLive.status(props.boardId),
    refresh: async () => ({ list: await getCardEvents(cardIdNow()) }),
  });
  const events = () => timelineEngine.view().list;
  // The timeline's rows re-slice when the workspace's tag vocabulary
  // changes: <For>'s callback is an untracked scope, so the chips' name
  // lookups inside eventLine never re-run on a rename by themselves. A
  // fresh array makes For rebuild the rows, and the rebuild resolves
  // the CURRENT names (renamed tags update the trail live).
  const timelineRows = createMemo(() => {
    void props.workspaceTags.length;
    return events().slice();
  });
  /** The actor's display name — the workspace roster first (members can
   *  vanish; the trail must keep naming them), falling back gracefully. */
  const actorName = (actorId: string | null) => {
    if (!actorId) return 'Someone';
    const member = props.members.find((entry) => entry.user_id === actorId);
    return member?.display_name ?? member?.email?.split('@')[0] ?? 'Someone';
  };
  /** One referenced entity in an event's detail — NEW rows (0058) carry
   *  {id, name}; OLD rows carry bare name strings, normalized here to
   *  {name} so they keep rendering with their real names, as plain text. */
  type EventRef = { id?: string; name?: string | null };
  const refItems = (value: unknown): EventRef[] =>
    (Array.isArray(value) ? value : [])
      .filter((item) => item != null)
      .map((item) => (typeof item === 'string' ? { name: item } : (item as EventRef)));

  /** A person chip: the CURRENT display name (renames can't stale it),
   *  hover raises the profile card, click opens the profile. */
  const personChip = (item: EventRef) => {
    const member = item.id ? props.members.find((m) => m.user_id === item.id) : undefined;
    const label = member?.display_name ?? member?.email?.split('@')[0] ?? item.name ?? 'someone';
    if (!item.id) return <span class="font-medium">{label}</span>;
    return (
      <span class="fd-mention" data-user-id={item.id}>
        {label}
      </span>
    );
  };
  /** A tag chip: current name + hover info, click → the tag's search. */
  const tagChip = (item: EventRef) => {
    const tag = item.id ? props.workspaceTags.find((t) => t.id === item.id) : undefined;
    const label = tag?.name ?? item.name ?? 'tag';
    if (!item.id) return <span class="font-medium">#{label}</span>;
    return (
      <span class="fd-tag-ref" data-tag-id={item.id}>
        #{label}
      </span>
    );
  };

  const eventLine = (row: CardEventRow) => {
    const detail = row.detail ?? {};
    const added = refItems(detail.added);
    const removed = refItems(detail.removed);
    switch (row.kind) {
      case 'created':
        return 'created this card';
      case 'resolved':
        return 'marked this resolved';
      case 'unresolved':
        return 'marked this unresolved';
      case 'moved':
        if (detail.reason === 'previous list deleted') {
          return `moved to ${String(detail.to ?? 'a list')} — the previous list no longer exists`;
        }
        return `moved this from ${String(detail.from ?? 'a list')} to ${String(detail.to ?? 'a list')}`;
      case 'renamed':
        return `renamed this from “${String(detail.from ?? '')}” to “${String(detail.to ?? '')}”`;
      case 'priority': {
        const to = detail.to as string | null | undefined;
        return to ? (
          <>
            set priority to{' '}
            <span class="fd-prio-ref" data-priority={to} title={`All cards with ${to} priority`}>
              {to}
            </span>
          </>
        ) : (
          'cleared the priority'
        );
      }
      case 'tags': {
        const addedPart =
          added.length > 0 ? (
            <>
              added <For each={added}>{(item) => tagChip(item)}</For>
            </>
          ) : null;
        const removedPart =
          removed.length > 0 ? (
            <>
              removed <For each={removed}>{(item) => tagChip(item)}</For>
            </>
          ) : null;
        return addedPart || removedPart ? (
          <>
            {addedPart}
            {addedPart && removedPart ? ' · ' : ''}
            {removedPart}
          </>
        ) : (
          'changed tags'
        );
      }
      case 'assignees': {
        const addedPart =
          added.length > 0 ? (
            <>
              assigned <For each={added}>{(item) => personChip(item)}</For>
            </>
          ) : null;
        const removedPart =
          removed.length > 0 ? (
            <>
              unassigned <For each={removed}>{(item) => personChip(item)}</For>
            </>
          ) : null;
        return addedPart || removedPart ? (
          <>
            {addedPart}
            {addedPart && removedPart ? ' · ' : ''}
            {removedPart}
          </>
        ) : (
          'changed assignees'
        );
      }
      case 'description':
        return typeof detail.from === 'string' && typeof detail.to === 'string' ? (
          <DescriptionDiffEvent from={detail.from} to={detail.to} />
        ) : (
          'updated the description'
        );
      case 'mentioned': {
        // A chat message or comment cited this card — the trail links
        // back to the exact message (mention backlinks, 0062).
        const snippet = String(detail.snippet ?? '');
        if (String(detail.where ?? '') === 'chat') {
          return (
            <>
              mentioned this in the{' '}
              <a
                class="fd-backlink"
                href={`/b/${String(detail.board_id ?? '')}?chat=${String(detail.message_id ?? '')}`}
                title={snippet}
              >
                #{String(detail.board_name ?? 'a board')} chat
              </a>
            </>
          );
        }
        if (String(detail.where ?? '') === 'description') {
          return (
            <>
              mentioned this in{' '}
              <a
                class="fd-backlink"
                href={`/b/${String(detail.board_id ?? '')}?card=${String(detail.card_id ?? '')}&event=description`}
                title={snippet}
              >
                #{String(detail.card_title ?? 'a card')}'s description
              </a>
            </>
          );
        }
        return (
          <>
            mentioned this in a comment on{' '}
            <a
              class="fd-backlink"
              href={`/b/${String(detail.board_id ?? '')}?card=${String(detail.card_id ?? '')}&comment=${String(detail.comment_id ?? '')}`}
              title={snippet}
            >
              #{String(detail.card_title ?? 'a card')}
            </a>
          </>
        );
      }
      default:
        return row.kind;
    }
  };
  const timeAgo = (iso: string) => {
    const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  // ── live comments: a small engine over the card's comment stream ────
  type CommentsSnapshot = { list: CommentRow[] };
  // Phase 4 (ADR-3): the comments ride the board TOPIC's digest — the
  // drawer adds zero sockets (liveQuery dedupes by name+args). The slice
  // accumulates: the cold page from one fetch (the same query the old
  // producer's first value ran), then the digest's pages replace it as
  // the card's comments change.
  // The slice (lib/board-slices, test-pinned): topic by the BOARD id,
  // digest pages replaced for this card only.
  const commentsTopic = liveQuery(boardStream, 'board');
  const commentsSlice = (cardId: string) =>
    commentsSliceOver({
      boardId: props.boardId,
      cardId,
      topic: (boardId) => commentsTopic(boardId),
      fetchPage: (id) => getCardComments(id, props.clientOp ?? null),
    });
  const commentsEngine = createEngine<CommentsSnapshot>({
    streamSource: (key) =>
      (async function* (): AsyncGenerator<CommentsSnapshot> {
        // The card's client_op rides along: the server resolves a
        // mid-provisional (temp) key to the durable card before binding.
        // Perf mark: drawer open → first comments page. Warm opens paint
        // the cached page instantly; the live value revalidates and
        // refreshes the cache.
        for await (const list of await perfFirstValue(
          cachedStream(
            `card-comments:${key}`,
            () => commentsSlice(key),
            'card-comments-revalidate',
          ),
          'card-comments-open',
        )) {
          yield { list };
        }
      })(),
    key: () => cardIdNow(),
    empty: { list: [] },
    clone: (snapshot) => ({ list: snapshot.list.slice() }),
    merge: (draft, snapshot, keep) => {
      const kept = draft.list.filter((row) => keep.has(row.id));
      const keptIds = new Set(kept.map((row) => row.id));
      const prev = new Map(draft.list.map((row) => [row.id, row]));
      const merged = [
        ...snapshot.list
          .filter((row) => !keptIds.has(row.id))
          .map((row) => {
            const old = prev.get(row.id);
            return old && JSON.stringify(old) === JSON.stringify(row) ? old : { ...row };
          }),
        ...kept,
      ].sort(
        (a, b) => chatSeq(a) - chatSeq(b) || +new Date(a.created_at) - +new Date(b.created_at),
      );
      if (draft.list.length !== merged.length || draft.list.some((row, i) => row !== merged[i])) {
        draft.list = merged;
      }
    },
    status: () => commentsTopic.status(props.boardId),
    refresh: async () => ({ list: await getCardComments(cardIdNow(), props.clientOp ?? null) }),
  });

  const comments = () => dedup([...older(), ...commentsEngine.view().list]);

  // ── backlink anchors ─────────────────────────────────────────────────
  // The trail's links land somewhere concrete: a cited comment scrolls
  // to + flashes that comment; the description backlink lands on the
  // SETTINGS tab at the card's latest description event (the diff that
  // shows WHERE the citation lives — not the description body itself).
  const [drawerParams, setDrawerParams] = useSearchParams<{ comment?: string; event?: string }>();
  // The comment anchor arrives in two steps: the param switches the
  // drawer to the CHAT tab (the comment lives there), and the flash
  // effect scrolls + highlights once the row exists. Splitting them
  // keeps each effect's inputs free of its own writes.
  createEffect(
    () => drawerParams.comment ?? null,
    (commentId) => {
      if (commentId && tab() !== 'chat') setTab('chat');
    },
  );
  let anchoredComment: string | null = null;
  createEffect(
    // The card id rides along: switching cards with the SAME comment
    // count must still retry the anchor (the rows are new).
    () => [drawerParams.comment ?? null, comments().length, card()?.id, tab()] as const,
    ([commentId]) => {
      if (!commentId || anchoredComment === commentId) return;
      queueMicrotask(() => {
        const row = document.querySelector(`[data-comment-id="${commentId}"]`);
        if (!row) return; // the tab switch / comments load re-fires this effect
        anchoredComment = commentId;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.add('fd-chat-anchor');
        // The param clears from the timer — a write from the effect's own
        // apply would feed back into its inputs.
        setTimeout(() => {
          row.classList.remove('fd-chat-anchor');
          setDrawerParams({ comment: '' }, { replace: true });
        }, 2400);
      });
    },
  );
  // The description anchor follows the same two-step split as the comment
  // one: the param switches the drawer to the SETTINGS tab (where the
  // trail lives), and the flash effect scrolls + highlights the card's
  // LATEST description event — re-queried after the switch, so it can
  // never hold a node the tab change detached.
  createEffect(
    () => drawerParams.event ?? null,
    (event) => {
      if (event === 'description' && tab() !== 'settings') setTab('settings');
    },
  );
  // The flash must survive the timeline RE-RENDERING: the first row it
  // lands on can be replaced moments later (card() resolves and Solid
  // recreates the rows). So the effect re-checks on every key change —
  // a live, flashing node stops it; a replaced (detached) one re-flashes
  // the current last row.
  let anchoredEventRow: Element | null = null;
  // The param leaving 'description' closes an anchor session — the next
  // one starts clean, even when it lands on the same card + same row.
  createEffect(
    () => drawerParams.event ?? null,
    (event) => {
      if (event !== 'description') anchoredEventRow = null;
    },
  );
  createEffect(
    // Same card-id keying as the comment anchor; the tab rides along so
    // the flash retries when the settings tab mounts its rows.
    () => [drawerParams.event ?? null, events().length, card()?.id, tab()] as const,
    ([event]) => {
      if (event !== 'description') return;
      if (anchoredEventRow?.isConnected && anchoredEventRow.classList.contains('fd-chat-anchor'))
        return;
      queueMicrotask(() => {
        const rows = document.querySelectorAll('[data-event-kind="description"]');
        const row = rows[rows.length - 1];
        if (!row) return; // the tab switch / events load re-fires this effect
        if (anchoredEventRow === row) return;
        anchoredEventRow?.classList.remove('fd-chat-anchor');
        anchoredEventRow = row;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.add('fd-chat-anchor');
        // A timer per anchor: each cleans up the row it flashed and
        // clears the param (idempotent when timers overlap). A
        // once-per-session flag never re-armed, so a later anchor's
        // highlight stuck forever — no flag.
        const target = row;
        setTimeout(() => {
          target.classList.remove('fd-chat-anchor');
          setDrawerParams({ event: '' }, { replace: true });
        }, 2400);
      });
    },
  );

  // The scroller: latest at the bottom; auto-follow new comments.
  let commentsScroll: HTMLDivElement | undefined;
  createEffect(
    () => comments().length,
    () => {
      queueMicrotask(() => {
        if (commentsScroll) commentsScroll.scrollTop = commentsScroll.scrollHeight;
      });
    },
  );

  // Relayed comments for THIS card append to the drawer's engine; a
  // relayed failure drops the matching prediction (same op id).
  onCleanup(
    props.onCommentArrived((event) => {
      if (event.type === 'fail') {
        commentsEngine.failRemote(event.opId);
        return;
      }
      const payload = event.payload;
      if (payload.cardId !== cardIdNow()) return;
      commentsEngine.applyRemote(
        {
          kind: payload.kind,
          guards: [payload.tempId],
          tempIds: [payload.tempId],
          apply: (draft) => {
            if (!draft.list.some((row) => row.id === payload.tempId)) {
              draft.list.push({
                id: payload.tempId,
                body: payload.body,
                author: payload.author,
                author_id: payload.authorId,
                avatar_url: payload.avatarUrl,
                created_at: payload.createdAt,
                edited_at: null,
                client_op: payload.clientOp,
              });
              draft.list = [...draft.list].sort(
                (a, b) =>
                  chatSeq(a) - chatSeq(b) || +new Date(a.created_at) - +new Date(b.created_at),
              );
            }
          },
          echo: (durable) => durable.list.some((row) => row.client_op === payload.clientOp),
        },
        event.opId,
      );
    }),
  );

  // Mark seen: on open, as new activity lands, AND when the resolved id
  // swaps (a card opened mid-provisional changes id when its durable echo
  // lands). The client_op is the card's STABLE identity — marking under it
  // means the badge clears no matter which row id the store held.
  onSettled(() => {
    markSeen(props.cardId, 0, props.clientOp);
  });
  // Opening a card = seeing its mentions/comments/assignments: the
  // server-side inbox rows auto-mark read too (id-swap safe).
  createEffect(
    () => cardIdNow(),
    (id) => {
      if (id) void markCardNotificationsSeen(id).catch(() => {});
    },
  );
  // Seen = the card's comment count (the badge tracks the same number).
  createEffect(
    () => {
      const list = comments();
      const count = Math.max(list.length, card()?.comment_count ?? 0);
      return { id: cardIdNow(), count };
    },
    ({ id, count }) => {
      if (!id) return;
      markSeen(id, count, props.clientOp);
    },
  );
  const [commentDraft, setCommentDraft] = createSignal('');

  // ── blocked mentions: people who can't see this board ─────────────────
  // The server never notifies someone who can't see the board; the moment
  // a comment/description mentions such a person, this panel offers the
  // author the board's configured path: grant directly (delegation ON or
  // an owner/admin author) or ask the workspace admins (delegation OFF).
  const [blocked, setBlocked] = createSignal<BlockedMention[]>([]);
  const [blockedTeams, setBlockedTeams] = createSignal<BlockedTeam[]>([]);
  const [accessNote, setAccessNote] = createSignal<string | null>(null);
  const [accessBusy, setAccessBusy] = createSignal(false);
  const [accessBody, setAccessBody] = createSignal('');

  /** Confirmations fade themselves out — no lingering strip. */
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  const showAccessNote = (text: string) => {
    setAccessNote(text);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => setAccessNote(null), 4500);
  };
  onCleanup(() => clearTimeout(noteTimer));

  /** Did the text we just sent mention someone (or a team) without
   *  board access? Either lands in the access panel. */
  const checkBlocked = (text: string) => {
    const ids = mentionIds(text);
    const teamIds = mentionTeamIds(text);
    const boardId = card()?.board_id;
    if ((ids.length === 0 && teamIds.length === 0) || !boardId) return;
    setAccessBody(text.slice(0, 200));
    if (ids.length > 0) {
      void checkMentionAccess(boardId, ids)
        .then((people) => {
          if (people.length > 0) setBlocked(people);
        })
        .catch(() => {});
    }
    if (teamIds.length > 0) {
      void checkTeamMentionAccess(boardId, teamIds)
        .then((teams) => {
          if (teams.length > 0) setBlockedTeams(teams);
        })
        .catch(() => {});
    }
  };
  const blockedNames = () =>
    blocked()
      .map((person) => person.name)
      .join(', ');
  const grantAccess = async () => {
    if (accessBusy() || (blocked().length === 0 && blockedTeams().length === 0)) return;
    setAccessBusy(true);
    try {
      if (blocked().length === 0) {
        // Only teams are blocked — the team grant is the whole flow.
        await grantTeamMentionAccess({
          boardId: card()?.board_id ?? '',
          teamIds: blockedTeams().map((team) => team.teamId),
          cardId: cardIdNow(),
          body: accessBody(),
        });
        props.onTeamAccessGranted(blockedTeams().map((team) => team.teamId));
        showAccessNote(
          `Access granted — ${blockedTeams()
            .map((team) => `@${team.name}`)
            .join(', ')} can now see this board and just got your mention.`,
        );
        setBlockedTeams([]);
        return;
      }
      await grantMentionAccess({
        boardId: card()?.board_id ?? '',
        userIds: blocked().map((person) => person.userId),
        cardId: cardIdNow(),
        body: accessBody(),
      });
      props.onAccessGranted(blocked().map((person) => person.userId));
      showAccessNote(
        `Access granted — ${blockedNames()} can now see this board and just got your mention.`,
      );
      setBlocked([]);
    } catch (error) {
      setAccessNote(errorMessage(error, 'Could not grant access'));
    } finally {
      setAccessBusy(false);
    }
  };
  const askAdmins = async () => {
    if (accessBusy() || (blocked().length === 0 && blockedTeams().length === 0)) return;
    setAccessBusy(true);
    try {
      if (blocked().length > 0) {
        await requestMentionAccess({
          boardId: card()?.board_id ?? '',
          userIds: blocked().map((person) => person.userId),
          cardId: cardIdNow(),
          body: accessBody(),
        });
      }
      if (blockedTeams().length > 0) {
        await requestTeamMentionAccess({
          boardId: card()?.board_id ?? '',
          teamIds: blockedTeams().map((team) => team.teamId),
          cardId: cardIdNow(),
          body: accessBody(),
        });
      }
      const names = [
        ...blocked().map((person) => person.name),
        ...blockedTeams().map((team) => `@${team.name}`),
      ].join(', ');
      showAccessNote(
        `Asked the workspace admins to give ${names} access — you'll be notified when they decide.`,
      );
      setBlocked([]);
      setBlockedTeams([]);
    } catch (error) {
      showAccessNote(errorMessage(error, 'Could not ask the admins'));
    } finally {
      setAccessBusy(false);
    }
  };
  /** Grant blocked TEAMS access (the same flow as people). */
  const grantTeams = async () => {
    if (accessBusy() || blockedTeams().length === 0) return;
    setAccessBusy(true);
    try {
      await grantTeamMentionAccess({
        boardId: card()?.board_id ?? '',
        teamIds: blockedTeams().map((team) => team.teamId),
        cardId: cardIdNow(),
        body: accessBody(),
      });
      props.onTeamAccessGranted(blockedTeams().map((team) => team.teamId));
      showAccessNote(
        `Access granted — ${blockedTeams()
          .map((team) => `@${team.name}`)
          .join(', ')} can now see this board and just got your mention.`,
      );
      setBlockedTeams([]);
    } catch (error) {
      showAccessNote(errorMessage(error, 'Could not grant access'));
    } finally {
      setAccessBusy(false);
    }
  };

  const saveTitle = () => {
    const title = titleDraft().trim();
    if (title && title !== card()?.title) props.onUpdate({ title });
  };

  const post = () => {
    const body = commentDraft().trim();
    if (!body) return;
    setCommentDraft('');
    // ONE relay op id everywhere: the drawer's engine owns the WRITE (the
    // only insert), the board page applies the stats bump under the same
    // id, and a failure reverts both — author and peers — via onCommentFail.
    const relayOpId = crypto.randomUUID();
    const payload: Extract<BoardOpPayload, { kind: 'comment-created' }> = {
      kind: 'comment-created',
      tempId: crypto.randomUUID(),
      cardId: cardIdNow(),
      body,
      author: props.myName,
      authorId: props.myId,
      avatarUrl: props.myAvatar,
      createdAt: new Date().toISOString(),
      clientOp: crypto.randomUUID(),
      countBefore: card()?.comment_count ?? 0,
    };
    // The comment's row applies through THIS engine (guarded until the
    // echo retires it); the card's stats + relay go through the board's.
    commentsEngine.mutate({
      kind: payload.kind,
      guards: [payload.tempId],
      tempIds: [payload.tempId],
      apply: (draft) => {
        draft.list.push({
          id: payload.tempId,
          body: payload.body,
          author: payload.author,
          author_id: payload.authorId,
          avatar_url: payload.avatarUrl,
          created_at: payload.createdAt,
          edited_at: null,
          client_op: payload.clientOp,
        });
        draft.list = [...draft.list].sort(
          (a, b) => chatSeq(a) - chatSeq(b) || +new Date(a.created_at) - +new Date(b.created_at),
        );
      },
      send: () =>
        addComment(cardIdNow(), body, payload.clientOp, props.clientOp ?? null).catch((error) => {
          props.onCommentFail(relayOpId);
          throw error;
        }),
      echo: (durable) => durable.list.some((row) => row.client_op === payload.clientOp),
    });
    props.onPostComment(payload, relayOpId);
    checkBlocked(body);
  };

  // ── edit + delete (0057): EDIT is the author's alone. DELETE is
  // role-scoped — author, workspace owners/admins, and team admins of a
  // team with edit access to this board. Older pages live outside the
  // engine's snapshot (loadEarlier keeps them in the `older` signal), so
  // those rows are applied + reverted there.
  const canEditComment = (comment: CommentRow) =>
    props.canEdit && !comment.deleted_at && comment.author_id === props.myId;
  const canDeleteComment = (comment: CommentRow) =>
    props.canEdit &&
    !comment.deleted_at &&
    (comment.author_id === props.myId || Boolean(props.myWsRole) || Boolean(props.myTeamAdmin));
  /** The role this viewer deletes under (optimistic tombstone stamp; the
   *  RPC's value wins on echo). */
  const deleteAsFor = (
    comment: CommentRow,
  ): {
    role: 'author' | 'owner' | 'admin' | 'team_admin';
    teamId: string | null;
  } => {
    if (comment.author_id === props.myId) return { role: 'author', teamId: null };
    if (props.myWsRole) return { role: props.myWsRole, teamId: null };
    return { role: 'team_admin', teamId: props.myTeamAdmin?.teamId ?? null };
  };
  const [editingCommentId, setEditingCommentId] = createSignal<string | null>(null);
  const [commentEditDraft, setCommentEditDraft] = createSignal('');
  const [confirmCommentId, setConfirmCommentId] = createSignal<string | null>(null);
  let confirmCommentTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(confirmCommentTimer));

  let commentEditOriginal = '';
  const startCommentEdit = (comment: CommentRow) => {
    setEditingCommentId(comment.id);
    setCommentEditDraft(comment.body);
    commentEditOriginal = comment.body;
  };
  /** Optimistic edit: the bubble swaps instantly, the guard holds until
   *  the live echo carries the new body (or the older-page row shows it).
   *  An unchanged body closes the editor without stamping an edit. */
  const saveCommentEdit = () => {
    const id = editingCommentId();
    const body = commentEditDraft().trim();
    if (!id || !body) return;
    if (body === commentEditOriginal) {
      setEditingCommentId(null);
      return;
    }
    const editedAt = new Date().toISOString();
    const prev = older().find((row) => row.id === id) ?? null;
    setEditingCommentId(null);
    setOlder((rows) =>
      rows.map((row) => (row.id === id ? { ...row, body, edited_at: editedAt } : row)),
    );
    commentsEngine.mutate({
      kind: 'comment-edited',
      guards: [id],
      apply: (draft) => {
        const row = draft.list.find((entry) => entry.id === id);
        if (row) {
          row.body = body;
          row.edited_at = editedAt;
        }
      },
      send: () =>
        editComment(id, body).catch((error) => {
          if (prev) {
            setOlder((rows) =>
              rows.map((row) =>
                row.id === id ? { ...row, body: prev.body, edited_at: prev.edited_at } : row,
              ),
            );
          }
          throw error;
        }),
      echo: (durable) =>
        durable.list.some((row) => row.id === id && row.body === body) ||
        (prev ? older().some((row) => row.id === id && row.body === body) : false),
    });
  };
  /** Optimistic delete: the row becomes a tombstone in place (who deleted
   *  it, in what role) — in the engine's list AND the older-pages list;
   *  the guard holds until the echo carries the server-stamped trail. */
  const removeComment = (comment: CommentRow) => {
    const as = deleteAsFor(comment);
    const at = new Date().toISOString();
    const prevOlder = older();
    const hadOlder = prevOlder.some((row) => row.id === comment.id);
    const tombstone = (row: CommentRow): CommentRow => ({
      ...row,
      body: '',
      deleted_at: at,
      deleted_by: props.myId,
      deleted_as: as.role,
      deleted_as_team_id: as.teamId,
    });
    setOlder((rows) => rows.map((row) => (row.id === comment.id ? tombstone(row) : row)));
    commentsEngine.mutate({
      kind: 'comment-deleted',
      guards: [comment.id],
      apply: (draft) => {
        const row = draft.list.find((entry) => entry.id === comment.id);
        if (row) {
          row.deleted_at = at;
          row.deleted_by = props.myId;
          row.deleted_as = as.role;
          row.deleted_as_team_id = as.teamId;
          row.body = '';
        }
      },
      send: () =>
        deleteComment(comment.id).catch((error) => {
          if (hadOlder) setOlder(prevOlder);
          throw error;
        }),
      echo: (durable) =>
        durable.list.some((row) => row.id === comment.id && Boolean(row.deleted_at)) ||
        (hadOlder
          ? older().some((row) => row.id === comment.id && Boolean(row.deleted_at))
          : false),
    });
  };
  /** Two-step delete: the first click arms ("Delete?"), the second fires. */
  const askDeleteComment = (comment: CommentRow) => {
    if (confirmCommentId() === comment.id) {
      clearTimeout(confirmCommentTimer);
      setConfirmCommentId(null);
      removeComment(comment);
    } else {
      setConfirmCommentId(comment.id);
      clearTimeout(confirmCommentTimer);
      confirmCommentTimer = setTimeout(() => setConfirmCommentId(null), 3000);
    }
  };

  /** Citations ([data-card-ref="#12"]) open that card — this device knows
   *  how, the drawer only sees the number. */
  /** Team chips route to the team page — this drawer knows the workspace. */
  const navigate = useNavigate();

  /** Citations open cards, tag chips jump to search — and any click
   *  clears the hover card (it must never stick around after acting). */
  const onBodyClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const user = target?.closest?.('[data-user-id]');
    if (user) {
      event.preventDefault();
      props.onHover(null);
      navigate(`/u/${user.getAttribute('data-user-id') ?? ''}`);
      return;
    }
    const ref = target?.closest?.('[data-card-ref]');
    if (ref) {
      event.preventDefault();
      props.onHover(null);
      props.onOpenCardRef(Number(ref.getAttribute('data-card-ref')));
      return;
    }
    const cross = target?.closest?.('[data-card-id]');
    if (cross) {
      event.preventDefault();
      props.onHover(null);
      // Backlink anchors ride on the chip: open the citing comment /
      // description event, not just the card.
      props.onOpenCrossCard(cross.getAttribute('data-card-id') ?? '', {
        commentId: cross.getAttribute('data-comment-id') ?? undefined,
        event: cross.getAttribute('data-event') ?? undefined,
      });
      return;
    }
    const tag = target?.closest?.('[data-tag-id]');
    if (tag) {
      event.preventDefault();
      props.onHover(null);
      props.onOpenTag(tag.getAttribute('data-tag-id') ?? '');
      return;
    }
    const teamChip = target?.closest?.('[data-team-id]');
    if (teamChip) {
      event.preventDefault();
      props.onHover(null);
      if (props.workspaceId) {
        navigate(`/w/${props.workspaceId}/t/${teamChip.getAttribute('data-team-id') ?? ''}`);
      }
      return;
    }
    const boardChip = target?.closest?.('[data-board-id]');
    if (boardChip) {
      event.preventDefault();
      props.onHover(null);
      // A backlink chip carries the citing message: land ON it, not just
      // on the board.
      const anchor = boardChip.getAttribute('data-message-id');
      navigate(
        `/b/${boardChip.getAttribute('data-board-id') ?? ''}${anchor ? `?chat=${anchor}` : ''}`,
      );
      return;
    }
    const prio = target?.closest?.('[data-priority]');
    if (prio) {
      event.preventDefault();
      props.onHover(null);
      navigate(`/search?priority=${encodeURIComponent(prio.getAttribute('data-priority') ?? '')}`);
    }
  };

  /** Hovering a mention, citation, cross-board ref, tag, or TEAM chip
   *  raises a detail card; moving off any of them clears it. */
  const onBodyHover = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const around = target?.closest?.(
      '[data-user-id], [data-card-ref], [data-card-id], [data-tag-id], [data-team-id]',
    );
    if (!around) {
      props.onHover(null);
      return;
    }
    const rect = around.getBoundingClientRect();
    const userId = around.getAttribute('data-user-id');
    if (userId) {
      props.onHover({ kind: 'user', id: userId, rect });
      return;
    }
    const tagId = around.getAttribute('data-tag-id');
    if (tagId) {
      props.onHover({ kind: 'tag', id: tagId, rect });
      return;
    }
    const cardRef =
      around.getAttribute('data-card-ref') ?? around.getAttribute('data-card-id') ?? '';
    if (cardRef) props.onHover({ kind: 'card', id: cardRef, rect });
    const teamId = around.getAttribute('data-team-id');
    if (teamId) props.onHover({ kind: 'team', id: teamId, rect });
  };

  return (
    <div
      class="fixed inset-0 z-50 flex justify-end bg-neutral-950/30 backdrop-blur-[1px]"
      onClick={props.onClose}
    >
      <aside
        class="relative flex h-full w-[26rem] max-w-full flex-col border-l border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
        style={props.panelWidth.width() === null ? {} : { width: `${props.panelWidth.width()}px` }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          class={`absolute -left-1 top-0 z-10 hidden h-full w-2 cursor-col-resize md:block ${props.panelWidth.dragging() ? 'bg-indigo-500/40' : 'hover:bg-indigo-500/20'}`}
          title="Drag to resize"
          onMouseDown={props.panelWidth.startDrag}
        />
        {/* ── header (fixed) ─────────────────────────────────────────── */}
        <div class="flex shrink-0 items-start justify-between gap-2 border-b border-neutral-100 px-5 pb-3 pt-4 dark:border-neutral-800">
          <div class="flex min-w-0 flex-1 items-baseline gap-2">
            <Show when={card()?.number}>
              {(num) => (
                <span class="rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  #{num()}
                </span>
              )}
            </Show>
            {/* The title is a plain label here — editing lives in the
                Settings tab. Reads the live store, so a rename by anyone
                (this device included) shows up instantly. The container
                must be allowed to shrink (min-w-0) or a long title pushes
                the close button out of the panel instead of truncating. */}
            <span
              class="min-w-0 flex-1 truncate text-lg font-semibold text-neutral-900 dark:text-white"
              title={card()?.title ?? ''}
            >
              {card()?.title ?? '…'}
            </span>
            <Show when={card()?.resolved_at}>
              <span
                class="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                title="Hidden from the board — unresolve to bring it back"
              >
                Resolved
              </span>
            </Show>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-md px-2 py-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            onClick={props.onClose}
          >
            ×
          </button>
        </div>

        {/* ── tabs: chat + settings, one at a time, full height ────────── */}
        <div class="flex shrink-0 items-center justify-between border-b border-neutral-100 px-5 py-1.5 dark:border-neutral-800">
          <div class="flex rounded-lg border border-neutral-200 p-0.5 dark:border-neutral-700">
            <button
              type="button"
              class={`rounded-md px-3 py-1 text-xs font-semibold ${
                tab() === 'chat'
                  ? 'bg-indigo-600 text-white'
                  : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'
              }`}
              onClick={() => setTab('chat')}
            >
              💬 Chat · {comments().length}
            </button>
            <button
              type="button"
              class={`rounded-md px-3 py-1 text-xs font-semibold ${
                tab() === 'settings'
                  ? 'bg-indigo-600 text-white'
                  : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'
              }`}
              onClick={() => {
                // The Settings tab is the title's edit surface — seed the
                // draft from the live title on every entry (no stale draft
                // after someone else renamed the card).
                setTitleDraft(card()?.title ?? '');
                setTab('settings');
              }}
            >
              ⚙ Settings
            </button>
          </div>
          <Show when={tab() === 'chat'}>
            <ChatPrefMenu scopeType="card" scopeId={cardIdNow()} />
          </Show>
          <Show when={props.canEdit}>
            <button
              type="button"
              class={[
                'rounded-lg px-2.5 py-1 text-xs font-semibold',
                card()?.resolved_at
                  ? 'text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950'
                  : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200',
              ]}
              title={
                card()?.resolved_at
                  ? 'Bring this card back to the board'
                  : 'Hide this card from the board — nothing is deleted'
              }
              onClick={() => props.onResolve(cardIdNow(), !card()?.resolved_at)}
            >
              {card()?.resolved_at ? '↩ Unresolve' : '✓ Resolve'}
            </button>
          </Show>
        </div>

        {/* ── settings tab ─────────────────────────────────────────────── */}
        <Show when={tab() === 'settings'}>
          <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-3">
            {/* title — the card's name is edited here, not in the header */}
            <div class="flex flex-col gap-1.5">
              <span class="text-xs font-medium text-neutral-400">Title</span>
              <Show
                when={props.canEdit}
                fallback={
                  <span class="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-300">
                    {card()?.title ?? '…'}
                  </span>
                }
              >
                <input
                  value={titleDraft()}
                  class="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-semibold text-neutral-900 focus:border-indigo-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-white"
                  onInput={(event) => setTitleDraft(event.currentTarget.value)}
                  onBlur={() => saveTitle()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
              </Show>
            </div>
            {/* assignment block */}
            <div class="flex flex-col gap-2">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="w-16 shrink-0 text-xs font-medium text-neutral-400">Assigned</span>
                <span class="flex -space-x-1.5">
                  <For each={card()?.assignees ?? []}>
                    {(userId) => {
                      const member = () => props.members.find((m) => m.user_id === userId);
                      return (
                        <Show
                          when={props.canEdit}
                          fallback={
                            <span class="rounded-full ring-1 ring-white dark:ring-neutral-900">
                              <Avatar
                                src={member()?.avatar_url}
                                name={member()?.display_name}
                                email={member()?.email}
                                size="sm"
                              />
                            </span>
                          }
                        >
                          <button
                            type="button"
                            title={`Unassign ${member()?.display_name ?? userId}`}
                            class="rounded-full ring-1 ring-white transition hover:opacity-60 dark:ring-neutral-900"
                            onClick={() =>
                              props.onUpdate({
                                assignees: (card()?.assignees ?? []).filter((id) => id !== userId),
                              })
                            }
                          >
                            <Avatar
                              src={member()?.avatar_url}
                              name={member()?.display_name}
                              email={member()?.email}
                              size="sm"
                            />
                          </button>
                        </Show>
                      );
                    }}
                  </For>
                </span>
                <Show when={props.canEdit}>
                  <div
                    data-assign-picker
                    class="relative"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      class="rounded-full border border-dashed border-neutral-300 px-2 py-0.5 text-[11px] font-medium text-neutral-500 hover:border-indigo-400 hover:text-indigo-600 dark:border-neutral-700 dark:hover:border-indigo-600"
                      onClick={() => setPickerOpen(!pickerOpen())}
                    >
                      + Assign
                    </button>
                    <Show when={pickerOpen()}>
                      <div class="absolute left-0 top-full z-30 mt-1 max-h-56 w-56 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
                        <For each={props.members}>
                          {(member) => {
                            const assigned = () =>
                              (card()?.assignees ?? []).includes(member.user_id);
                            return (
                              <button
                                type="button"
                                class={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                                  assigned()
                                    ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                                    : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                                }`}
                                onClick={() => {
                                  const current = card()?.assignees ?? [];
                                  props.onUpdate({
                                    assignees: assigned()
                                      ? current.filter((id) => id !== member.user_id)
                                      : [...current, member.user_id],
                                  });
                                }}
                              >
                                <Avatar
                                  src={member.avatar_url}
                                  name={member.display_name}
                                  email={member.email}
                                  size="sm"
                                />
                                <span class="min-w-0 flex-1 truncate">
                                  {member.display_name ?? member.email}
                                </span>
                                <Show when={assigned()}>✓</Show>
                              </button>
                            );
                          }}
                        </For>
                        <Show when={props.members.length === 0}>
                          <p class="px-2 py-1.5 text-xs text-neutral-400">No members yet</p>
                        </Show>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>

              <div class="flex flex-wrap items-center gap-1.5">
                <span class="w-16 shrink-0 text-xs font-medium text-neutral-400">Priority</span>
                <Show
                  when={props.canEdit}
                  fallback={
                    <Show
                      when={card()?.priority}
                      fallback={<span class="text-xs text-neutral-400">None</span>}
                    >
                      {(priority) => <PriorityPill priority={priority()} />}
                    </Show>
                  }
                >
                  <select
                    class="w-28 py-1 text-xs"
                    value={card()?.priority ?? ''}
                    onChange={(event) =>
                      props.onUpdate({
                        priority: (event.currentTarget.value || null) as string | null,
                      })
                    }
                  >
                    <option value="">None</option>
                    <option value="urgent">Urgent</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </Show>
              </div>

              <div class="flex flex-wrap items-center gap-1.5">
                <span class="w-16 shrink-0 text-xs font-medium text-neutral-400">Tags</span>
                <For each={card()?.tags ?? []}>
                  {(tag) => (
                    <TagChip tagId={tag.id} fallbackName={tag.name} variant="drawer">
                      <Show when={props.canEdit}>
                        <button
                          type="button"
                          class="text-sky-400 hover:text-sky-700 dark:hover:text-sky-100"
                          title={`Remove #${tag.name}`}
                          onClick={() =>
                            props.onUpdate({
                              tags: (card()?.tags ?? []).filter((t) => t.id !== tag.id),
                            })
                          }
                        >
                          ×
                        </button>
                      </Show>
                    </TagChip>
                  )}
                </For>
                <Show when={props.canEdit}>
                  <TagInput
                    workspaceTags={props.workspaceTags}
                    workspaceId={props.workspaceId}
                    onAdd={(tag) => {
                      if (!(card()?.tags ?? []).some((t) => t.id === tag.id))
                        props.onUpdate({ tags: [...(card()?.tags ?? []), tag] });
                    }}
                  />
                </Show>
              </div>
            </div>

            {/* provenance: who created the card and when */}
            <p class="text-[11px] text-neutral-400">
              Created by{' '}
              <span class="font-medium text-neutral-500 dark:text-neutral-300">
                {props.members.find((m) => m.user_id === card()?.created_by)?.display_name ??
                  'a former member'}
              </span>
              <Show when={card()?.created_at}>
                {' '}
                ·{' '}
                {new Date(card()!.created_at).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </Show>
            </p>

            {/* description */}
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between">
                <label class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
                  Description
                </label>
                <Show
                  when={!editingBody()}
                  fallback={
                    <span class="flex gap-2 text-xs">
                      <button
                        type="button"
                        class="rounded-md px-2 py-0.5 font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950"
                        onClick={() => saveBody()}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        class="rounded-md px-2 py-0.5 font-medium text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        onClick={() => setEditingBody(false)}
                      >
                        Cancel
                      </button>
                    </span>
                  }
                >
                  <Show when={props.canEdit}>
                    <button
                      type="button"
                      class="rounded-md px-2 py-0.5 font-medium text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                      onClick={startEditing}
                    >
                      {card()?.description ? 'Edit' : 'Add description'}
                    </button>
                  </Show>
                </Show>
              </div>
              <Show
                when={!editingBody()}
                fallback={
                  <SmartTextarea
                    value={bodyDraft()}
                    onInput={setBodyDraft}
                    members={props.members}
                    teams={props.teams}
                    cards={props.cards}
                    workspaceTags={props.workspaceTags}
                    crossCards={props.crossCards}
                    workspaceBoards={props.workspaceBoards}
                    boardName={props.boardName}
                    board={{ id: card()?.board_id ?? '', name: props.boardName }}
                    rows={8}
                    onSend={() => saveBody()}
                    placeholder={
                      'Describe the task — **markdown**, image links, #12 references, @name mentions'
                    }
                  />
                }
              >
                <Show
                  when={card()?.description}
                  fallback={
                    <p class="rounded-lg border border-dashed border-neutral-200 p-3 text-sm text-neutral-400 dark:border-neutral-700">
                      No description yet — that's the full task: markdown, images, video links, #12
                      citations.
                    </p>
                  }
                >
                  <div
                    // markdown-rendered card body; clicks on #citations open that card
                    class="prose-card text-sm leading-relaxed"
                    onClick={onBodyClick}
                    onMouseOver={onBodyHover}
                    // oxlint-disable-next-line solid/no-innerhtml -- renderMarkdown() sanitizes (DOMPurify) and re-whitelists iframe hosts
                    innerHTML={renderMarkdown(card()?.description ?? '', markdownContext())}
                  />
                </Show>
              </Show>
            </div>

            {/* ── activity timeline: every change, by whom ───────────────── */}
            <div class="flex flex-col gap-1.5">
              <span class="text-xs font-medium text-neutral-400">Activity</span>
              <Show
                when={events().length > 0}
                fallback={
                  <p class="text-xs text-neutral-400">
                    Everything that happens to this card — moves, renames, tags, assignments — lands
                    here.
                  </p>
                }
              >
                <ol
                  class="fd-timeline flex flex-col gap-1 border-l border-neutral-200 pl-3 dark:border-neutral-700"
                  onClick={onBodyClick}
                  onMouseOver={onBodyHover}
                >
                  <For each={timelineRows()}>
                    {(row) => (
                      <li
                        data-event-kind={row.kind}
                        class="relative text-xs leading-relaxed text-neutral-500 dark:text-neutral-400"
                      >
                        <span class="absolute -left-[17px] top-1.5 h-1.5 w-1.5 rounded-full bg-neutral-300 dark:bg-neutral-600" />
                        <Show
                          when={row.actor_id}
                          fallback={
                            <span class="font-medium text-neutral-700 dark:text-neutral-200">
                              {actorName(row.actor_id)}
                            </span>
                          }
                        >
                          <span class="fd-mention" data-user-id={row.actor_id}>
                            {actorName(row.actor_id)}
                          </span>
                        </Show>{' '}
                        {eventLine(row)}
                        <Show when={row.agent}>
                          <span class="ml-0.5 rounded bg-indigo-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-300">
                            via agent
                          </span>
                        </Show>
                        <span class="ml-1 text-[10px] text-neutral-400">
                          {timeAgo(row.created_at)}
                        </span>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
            </div>
          </div>
        </Show>

        {/* ── chat tab ──────────────────────────────────────────────────── */}
        <Show when={tab() === 'chat'}>
          {/* ── comments label ──────────────────────────────────────────── */}
          <div class="flex shrink-0 items-center justify-between border-t border-neutral-100 px-5 pb-1 pt-2 dark:border-neutral-800">
            <span class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
              Comments · {comments().length}
            </span>
            <Show when={!loadingEarlier() && !noMoreEarlier()}>
              <button
                type="button"
                class="text-[11px] font-medium text-indigo-500 hover:text-indigo-600 dark:text-indigo-400"
                onClick={() => void loadEarlier()}
              >
                ↑ Load earlier
              </button>
            </Show>
            <Show when={loadingEarlier()}>
              <span class="text-[11px] text-neutral-400">Loading…</span>
            </Show>
          </div>

          {/* ── comments: the ONLY scrollable region, latest at the bottom ── */}
          <div ref={commentsScroll} class="min-h-0 flex-1 overflow-y-auto px-5 py-1">
            <Show
              when={comments().length > 0}
              fallback={
                <p class="py-6 text-center text-xs text-neutral-400">
                  No comments yet — mention cards as #12, people as @name, use markdown.
                </p>
              }
            >
              <ul class="flex flex-col gap-3 py-1">
                <For each={comments()}>
                  {(comment) => {
                    const mine = () =>
                      comment.author_id !== null && comment.author_id === props.myId;
                    return (
                      <li
                        data-comment-id={comment.id}
                        class={`group flex items-start gap-2 ${mine() ? 'flex-row-reverse' : ''}`}
                      >
                        <Avatar src={comment.avatar_url} name={comment.author} size="sm" />
                        <div
                          class={`flex min-w-0 max-w-[85%] flex-col ${mine() ? 'items-end text-right' : ''}`}
                        >
                          <p
                            class={`flex items-center gap-2 text-[11px] text-neutral-400 ${mine() ? 'flex-row-reverse' : ''}`}
                          >
                            <span class="font-semibold text-neutral-500 dark:text-neutral-300">
                              {mine() ? 'You' : comment.author}
                            </span>
                            <Show when={comment.agent}>
                              {
                                <span
                                  class="rounded bg-indigo-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-300"
                                  title="Sent through an MCP connection"
                                >
                                  Agent
                                </span>
                              }
                            </Show>
                            <time>
                              {new Date(comment.created_at).toLocaleString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                              })}
                            </time>
                            <Show when={comment.edited_at && !comment.deleted_at}>
                              <span
                                class="italic"
                                title={`Edited ${new Date(comment.edited_at!).toLocaleString(
                                  undefined,
                                  {
                                    month: 'short',
                                    day: 'numeric',
                                    hour: 'numeric',
                                    minute: '2-digit',
                                  },
                                )}`}
                              >
                                (edited)
                              </span>
                            </Show>
                            <Show when={canEditComment(comment) || canDeleteComment(comment)}>
                              <span
                                class={[
                                  'flex items-center gap-1 transition-opacity',
                                  confirmCommentId() === comment.id
                                    ? 'opacity-100'
                                    : 'opacity-0 group-hover:opacity-100',
                                ]}
                              >
                                <Show when={canEditComment(comment)}>
                                  <button
                                    type="button"
                                    title="Edit comment"
                                    class="rounded px-1 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                                    onClick={() => startCommentEdit(comment)}
                                  >
                                    ✏️
                                  </button>
                                </Show>
                                <Show when={canDeleteComment(comment)}>
                                  <button
                                    type="button"
                                    title={
                                      confirmCommentId() === comment.id
                                        ? 'Click again to delete'
                                        : 'Delete comment'
                                    }
                                    class={[
                                      'rounded px-1 text-[10px] font-semibold hover:bg-neutral-200 dark:hover:bg-neutral-700',
                                      { 'text-red-500': confirmCommentId() === comment.id },
                                    ]}
                                    onClick={() => askDeleteComment(comment)}
                                  >
                                    {confirmCommentId() === comment.id ? 'Delete?' : '🗑'}
                                  </button>
                                </Show>
                              </span>
                            </Show>
                          </p>
                          <Show
                            when={!comment.deleted_at}
                            fallback={
                              // The deletion trail: real mention chips (avatars,
                              // hovers, rename-proof) + the role the deleter held.
                              <p
                                class="prose-card mt-0.5 text-xs italic text-neutral-400"
                                // oxlint-disable-next-line solid/no-innerhtml -- renderMarkdown() sanitizes (DOMPurify)
                                innerHTML={renderMarkdown(
                                  tombstoneLine(
                                    comment,
                                    props.myId,
                                    props.members,
                                    props.teams,
                                    'comment',
                                  ),
                                  markdownContext(),
                                )}
                                onClick={onBodyClick}
                                onMouseOver={onBodyHover}
                              />
                            }
                          >
                            <Show
                              when={editingCommentId() !== comment.id}
                              fallback={
                                <form
                                  class={[
                                    'mt-0.5 flex w-full flex-col gap-1.5',
                                    { 'text-left': mine() },
                                  ]}
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    saveCommentEdit();
                                  }}
                                >
                                  <SmartTextarea
                                    value={commentEditDraft()}
                                    onInput={setCommentEditDraft}
                                    members={props.members}
                                    teams={props.teams}
                                    cards={props.cards}
                                    workspaceTags={props.workspaceTags}
                                    crossCards={props.crossCards}
                                    workspaceBoards={props.workspaceBoards}
                                    boardName={props.boardName}
                                    board={{ id: card()?.board_id ?? '', name: props.boardName }}
                                    rows={2}
                                    sendOnEnter
                                    onSend={() => saveCommentEdit()}
                                    placeholder="Edit comment…"
                                  />
                                  <div class="flex items-center justify-end gap-2 text-xs">
                                    <button
                                      type="button"
                                      class="rounded-md px-2 py-0.5 font-medium text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                                      onClick={() => setEditingCommentId(null)}
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="submit"
                                      disabled={!commentEditDraft().trim()}
                                      class="rounded-md bg-indigo-600 px-2.5 py-0.5 font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
                                    >
                                      Save
                                    </button>
                                  </div>
                                </form>
                              }
                            >
                              <div
                                class={`prose-card mt-0.5 rounded-xl px-3 py-2 text-left text-sm leading-relaxed ${
                                  mine()
                                    ? 'bg-indigo-600 text-white dark:bg-indigo-500'
                                    : 'bg-neutral-100 dark:bg-neutral-800/60'
                                }`}
                                onClick={onBodyClick}
                                onMouseOver={onBodyHover}
                                // oxlint-disable-next-line solid/no-innerhtml -- renderMarkdown() sanitizes (DOMPurify) and re-whitelists iframe hosts
                                innerHTML={renderMarkdown(comment.body, markdownContext())}
                              />
                            </Show>
                          </Show>
                        </div>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Show>
          </div>

          {/* ── composer (fixed at the bottom) ───────────────────────────── */}
          <div class="shrink-0 border-t border-neutral-100 px-5 py-3 dark:border-neutral-800">
            {/* Blocked mentions: the send-time indication. The server never
              notified these people or teams — the author decides. */}
            <Show when={blocked().length > 0 || blockedTeams().length > 0 || accessNote()}>
              <div class="mb-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-800 dark:bg-amber-950/50">
                <Show
                  when={blocked().length > 0 || blockedTeams().length > 0}
                  fallback={
                    <p class="flex items-start gap-2 text-amber-800 dark:text-amber-200">
                      <span class="flex-1">{accessNote()}</span>
                      <button
                        type="button"
                        title="Dismiss"
                        class="shrink-0 font-semibold text-amber-500 hover:text-amber-800 dark:hover:text-amber-200"
                        onClick={() => setAccessNote(null)}
                      >
                        ×
                      </button>
                    </p>
                  }
                >
                  <p class="font-semibold text-amber-900 dark:text-amber-100">
                    {[
                      ...blocked().map((person) => person.name),
                      ...blockedTeams().map((team) => `@${team.name}`),
                    ].join(', ')}{' '}
                    can’t see this board — no notification was sent.
                  </p>
                  <div class="mt-2 flex flex-wrap items-center gap-2">
                    <Show
                      when={props.accessDelegation || props.isWsAdmin}
                      fallback={
                        <button
                          type="button"
                          disabled={accessBusy()}
                          class="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                          onClick={() => void askAdmins()}
                        >
                          {accessBusy() ? 'Asking…' : 'Ask admins to grant access'}
                        </button>
                      }
                    >
                      <button
                        type="button"
                        disabled={accessBusy()}
                        class="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                        onClick={() => void grantAccess()}
                      >
                        {accessBusy() ? 'Granting…' : 'Give access & notify'}
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900"
                      onClick={() => {
                        setBlocked([]);
                        setBlockedTeams([]);
                      }}
                    >
                      Ignore
                    </button>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={commentsEngine.failed().length > 0}>
              <p class="mb-2 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950 dark:text-red-400">
                Couldn't post that comment — {commentsEngine.failed()[0]?.error}
                <button
                  type="button"
                  class="font-semibold underline"
                  onClick={() => commentsEngine.retry(commentsEngine.failed()[0]!.id)}
                >
                  Retry
                </button>
                <button
                  type="button"
                  class="font-semibold underline"
                  onClick={() => commentsEngine.dismiss(commentsEngine.failed()[0]!.id)}
                >
                  Dismiss
                </button>
              </p>
            </Show>
            <Show
              when={props.canEdit}
              fallback={
                <p class="text-center text-xs text-neutral-400">
                  View only — ask an admin for write access to comment.
                </p>
              }
            >
              <form
                class="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  post();
                }}
              >
                <SmartTextarea
                  value={commentDraft()}
                  onInput={setCommentDraft}
                  members={props.members}
                  teams={props.teams}
                  cards={props.cards}
                  workspaceTags={props.workspaceTags}
                  crossCards={props.crossCards}
                  workspaceBoards={props.workspaceBoards}
                  boardName={props.boardName}
                  board={{ id: card()?.board_id ?? '', name: props.boardName }}
                  rows={2}
                  sendOnEnter
                  onSend={() => post()}
                  placeholder="Write a comment… markdown, @ to mention, # to cite a card"
                />
                <div class="flex items-center justify-between">
                  <span class="text-[10px] text-neutral-400">
                    <kbd class="rounded border border-neutral-200 px-1 dark:border-neutral-700">
                      Enter
                    </kbd>{' '}
                    to send ·
                    <kbd class="rounded border border-neutral-200 px-1 dark:border-neutral-700">
                      Shift+Enter
                    </kbd>{' '}
                    new line ·<span class="font-semibold">@</span> mention ·
                    <span class="font-semibold">#</span> cite
                  </span>
                  <button
                    type="submit"
                    disabled={!commentDraft().trim()}
                    class="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
                  >
                    Send
                    <span aria-hidden="true">↵</span>
                  </button>
                </div>
              </form>
            </Show>
          </div>
        </Show>
      </aside>
    </div>
  );
}

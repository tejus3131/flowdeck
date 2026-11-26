// Extracted from the board route (phase 6): a panel is its own module
// so the route stays a wiring file (L5 rule 6).
import { liveQuery, useNavigate } from '@solidjs/router';
import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';

import { Avatar } from '../Avatar';
import { SmartTextarea } from './SmartTextarea';
import { tombstoneLine } from './lines';
import { createEngine } from '../../lib/sync';
import { perfFirstValue } from '../../lib/perf';
import { cachedStream } from '../../lib/cache';
import { renderMarkdown } from '../../lib/markdown';
import { mentionIds, mentionTeamIds } from '../../lib/notification-text';
import {
  checkMentionAccess,
  grantMentionAccess,
  requestMentionAccess,
  type BlockedMention,
} from '../../lib/access';
import {
  boardStream,
  chatSeq,
  deleteBoardMessage,
  editBoardMessage,
  getBoardChatSnapshot,
  postBoardMessage,
  type BoardMessageRow,
  type CardView,
  type CrossCard,
} from '../../lib/boards';

import { type Member, type TeamView } from '../../lib/workspaces';
import {
  checkTeamMentionAccess,
  grantTeamMentionAccess,
  requestTeamMentionAccess,
  type BlockedTeam,
} from '../../lib/access';
import { errorMessage } from '../../lib/error-message';

/**
 * The board-level chat — the card drawer's comment experience, lifted to
 * the whole board: live messages, avatars, own-vs-others bubbles, and
 * the same @mention surface (people + teams) in the composer. Embedded
 * in the board's side panel (the shell owns the chrome and the tabs).
 */
export function BoardChat(props: {
  boardId: string;
  /** The board's workspace — team chips link to team pages. */
  workspaceId: string;
  members: Member[];
  teams: TeamView[];
  /** This board's cards + cross-board cards — # citations resolve. */
  cards: CardView[];
  crossCards: CrossCard[];
  /** The workspace's boards — the # menu offers cross-board citations
   *  (chips serialize as [name](board:<uuid>) → board backlinks). */
  workspaceBoards?: { id: string; name: string }[];
  /** The workspace's tag vocabulary — # offers tags too. */
  workspaceTags: { id: string; name: string }[];
  boardName: string;
  canEdit: boolean;
  myId: string | null;
  myAvatar: string | null;
  myName: string;
  accessDelegation: boolean;
  isWsAdmin: boolean;
  /** The viewer's workspace role when it can delete others' messages
   *  (0057: owners/admins delete, they no longer edit others'). */
  myWsRole: 'owner' | 'admin' | null;
  /** Team admin of a team with edit access to this board — may delete. */
  myTeamAdmin: { teamId: string; teamName: string } | null;
  /** A mention-grant landed: mirror on the workspace relay. */
  onAccessGranted: (userIds: string[]) => void;
  onTeamAccessGranted: (teamIds: string[]) => void;
  /** Team/user chip hovers raise the detail card. */
  onHover: (target: { kind: 'user' | 'team'; id: string; rect: DOMRect } | null) => void;
  /** # citations open cards (this board) / cross-board cards. */
  onOpenCardRef: (num: number) => void;
  onOpenCrossCard: (cardId: string, anchor?: { commentId?: string; event?: string }) => void;
  /** A deep link (?chat=<message-id>) asks the panel to land on that
   *  exact message — mention backlinks click through to it. */
  anchorMessageId: () => string | null;
}) {
  type ChatSnapshot = { list: BoardMessageRow[] };
  // Phase 4 (ADR-3): the chat panel consumes the board TOPIC's chat slice —
  // liveQuery dedupes by (name + args), so this shares the board engine's
  // one connection instead of opening its own producer and socket.
  const topicLive = liveQuery(boardStream, 'board');
  const engine = createEngine<ChatSnapshot>({
    streamSource: (key) =>
      (async function* (): AsyncGenerator<ChatSnapshot> {
        // Perf mark: chat panel open → first value. Warm opens paint the
        // cached page instantly (cachedStream), the live value revalidates.
        for await (const list of await perfFirstValue(
          cachedStream(
            `board-chat:${key}`,
            () =>
              (async function* (): AsyncGenerator<BoardMessageRow[]> {
                for await (const composite of await topicLive(key)) yield composite.chat;
              })(),
            'board-chat-revalidate',
          ),
          'board-chat-open',
        )) {
          yield { list };
        }
      })(),
    key: () => props.boardId,
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
    status: () => topicLive.status(props.boardId),
    refresh: async () => ({ list: await getBoardChatSnapshot(props.boardId) }),
  });

  // Auto-follow: latest at the bottom.
  let scroller: HTMLDivElement | undefined;
  createEffect(
    () => engine.view().list.length,
    () => {
      queueMicrotask(() => {
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
    },
  );

  // Deep link (?chat=<message-id>): scroll the cited message into view
  // and flash it. Retries as pages load in — the anchor lands as soon as
  // the row exists, then stops.
  let anchoredId: string | null = null;
  createEffect(
    () => [props.anchorMessageId(), engine.view().list.length] as const,
    ([anchorId]) => {
      if (!anchorId || anchoredId === anchorId) return;
      queueMicrotask(() => {
        const row = scroller?.querySelector(`[data-msg-id="${anchorId}"]`);
        if (!row) return;
        anchoredId = anchorId;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.add('fd-chat-anchor');
        setTimeout(() => row.classList.remove('fd-chat-anchor'), 2400);
      });
    },
  );

  // ── blocked mentions (people AND teams) — the same panel as the drawer
  const [blocked, setBlocked] = createSignal<BlockedMention[]>([]);
  const [blockedTeams, setBlockedTeams] = createSignal<BlockedTeam[]>([]);
  const [accessNote, setAccessNote] = createSignal<string | null>(null);
  const [accessBusy, setAccessBusy] = createSignal(false);
  const [accessBody, setAccessBody] = createSignal('');

  const checkBlocked = (text: string) => {
    const ids = mentionIds(text);
    const teamIds = mentionTeamIds(text);
    if (ids.length === 0 && teamIds.length === 0) return;
    setAccessBody(text.slice(0, 200));
    if (ids.length > 0) {
      void checkMentionAccess(props.boardId, ids)
        .then((people) => {
          if (people.length > 0) setBlocked(people);
        })
        .catch(() => {});
    }
    if (teamIds.length > 0) {
      void checkTeamMentionAccess(props.boardId, teamIds)
        .then((teams) => {
          if (teams.length > 0) setBlockedTeams(teams);
        })
        .catch(() => {});
    }
  };

  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  const showAccessNote = (text: string) => {
    setAccessNote(text);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => setAccessNote(null), 4500);
  };
  onCleanup(() => clearTimeout(noteTimer));

  const grantAccess = async () => {
    if (accessBusy() || (blocked().length === 0 && blockedTeams().length === 0)) return;
    setAccessBusy(true);
    try {
      if (blocked().length > 0) {
        await grantMentionAccess({
          boardId: props.boardId,
          userIds: blocked().map((person) => person.userId),
          cardId: null,
          body: accessBody(),
        });
        props.onAccessGranted(blocked().map((person) => person.userId));
      }
      if (blockedTeams().length > 0) {
        await grantTeamMentionAccess({
          boardId: props.boardId,
          teamIds: blockedTeams().map((team) => team.teamId),
          cardId: null,
          body: accessBody(),
        });
        props.onTeamAccessGranted(blockedTeams().map((team) => team.teamId));
      }
      showAccessNote('Access granted — they can now see this board and just got your mention.');
      setBlocked([]);
      setBlockedTeams([]);
    } catch (error) {
      showAccessNote(errorMessage(error, 'Could not grant access'));
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
          boardId: props.boardId,
          userIds: blocked().map((person) => person.userId),
          cardId: null,
          body: accessBody(),
        });
      }
      if (blockedTeams().length > 0) {
        await requestTeamMentionAccess({
          boardId: props.boardId,
          teamIds: blockedTeams().map((team) => team.teamId),
          cardId: null,
          body: accessBody(),
        });
      }
      showAccessNote("Asked the workspace admins — you'll be notified when they decide.");
      setBlocked([]);
      setBlockedTeams([]);
    } catch (error) {
      showAccessNote(errorMessage(error, 'Could not ask the admins'));
    } finally {
      setAccessBusy(false);
    }
  };

  const [draft, setDraft] = createSignal('');
  const post = () => {
    const body = draft().trim();
    if (!body) return;
    setDraft('');
    const clientOp = crypto.randomUUID();
    const payload = {
      kind: 'comment-created' as const,
      tempId: crypto.randomUUID(),
      cardId: props.boardId,
      body,
      author: props.myName,
      authorId: props.myId,
      avatarUrl: props.myAvatar,
      createdAt: new Date().toISOString(),
      clientOp,
      countBefore: 0,
    };
    engine.mutate({
      kind: payload.kind,
      guards: [payload.tempId],
      tempIds: [payload.tempId],
      apply: (current) => {
        current.list.push({
          id: payload.tempId,
          body,
          author: payload.author,
          author_id: payload.authorId,
          avatar_url: payload.avatarUrl,
          created_at: payload.createdAt,
          edited_at: null,
          client_op: payload.clientOp,
        });
        current.list = [...current.list].sort(
          (a, b) => chatSeq(a) - chatSeq(b) || +new Date(a.created_at) - +new Date(b.created_at),
        );
      },
      send: () => postBoardMessage(props.boardId, body, clientOp),
      echo: (durable) => durable.list.some((row) => row.client_op === clientOp),
    });
    checkBlocked(body);
  };

  // ── edit + delete (0057): EDIT is the author's alone. DELETE is
  // role-scoped — author, workspace owners/admins, and team admins of a
  // team with edit access to this board. The server re-checks; this only
  // decides which affordances to show.
  const canEditMsg = (message: BoardMessageRow) =>
    props.canEdit && !message.deleted_at && message.author_id === props.myId;
  const canDeleteMsg = (message: BoardMessageRow) =>
    props.canEdit &&
    !message.deleted_at &&
    (message.author_id === props.myId || Boolean(props.myWsRole) || Boolean(props.myTeamAdmin));
  /** The role this viewer deletes under (optimistic tombstone stamp; the
   *  RPC's value wins on echo). */
  const deleteAsFor = (
    message: BoardMessageRow,
  ): {
    role: 'author' | 'owner' | 'admin' | 'team_admin';
    teamId: string | null;
  } => {
    if (message.author_id === props.myId) return { role: 'author', teamId: null };
    if (props.myWsRole) return { role: props.myWsRole, teamId: null };
    return { role: 'team_admin', teamId: props.myTeamAdmin?.teamId ?? null };
  };
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editDraft, setEditDraft] = createSignal('');
  const [confirmId, setConfirmId] = createSignal<string | null>(null);
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(confirmTimer));

  let editOriginal = '';
  const startEdit = (message: BoardMessageRow) => {
    setEditingId(message.id);
    setEditDraft(message.body);
    editOriginal = message.body;
  };
  /** Optimistic edit: the bubble swaps instantly, the guard holds until
   *  the live echo carries the new body. An unchanged body closes the
   *  editor without stamping an edit. */
  const saveEdit = () => {
    const id = editingId();
    const body = editDraft().trim();
    if (!id || !body) return;
    if (body === editOriginal) {
      setEditingId(null);
      return;
    }
    const editedAt = new Date().toISOString();
    setEditingId(null);
    engine.mutate({
      kind: 'message-edited',
      guards: [id],
      apply: (draft) => {
        const row = draft.list.find((entry) => entry.id === id);
        if (row) {
          row.body = body;
          row.edited_at = editedAt;
        }
      },
      send: () => editBoardMessage(id, body),
      echo: (durable) => durable.list.some((row) => row.id === id && row.body === body),
    });
  };
  /** Optimistic delete: the row becomes a tombstone in place (who deleted
   *  it, in what role); the guard holds until the echo carries the
   *  server-stamped trail. */
  const removeMessage = (message: BoardMessageRow) => {
    const as = deleteAsFor(message);
    const at = new Date().toISOString();
    engine.mutate({
      kind: 'message-deleted',
      guards: [message.id],
      apply: (draft) => {
        const row = draft.list.find((entry) => entry.id === message.id);
        if (row) {
          row.deleted_at = at;
          row.deleted_by = props.myId;
          row.deleted_as = as.role;
          row.deleted_as_team_id = as.teamId;
          row.body = '';
        }
      },
      send: () => deleteBoardMessage(message.id),
      echo: (durable) =>
        durable.list.some((row) => row.id === message.id && Boolean(row.deleted_at)),
    });
  };
  /** Two-step delete: the first click arms ("Delete?"), the second fires. */
  const askDelete = (message: BoardMessageRow) => {
    if (confirmId() === message.id) {
      clearTimeout(confirmTimer);
      setConfirmId(null);
      removeMessage(message);
    } else {
      setConfirmId(message.id);
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => setConfirmId(null), 3000);
    }
  };

  const markdownContext = () => ({
    members: props.members,
    // Boards the viewer can reach: board chips resolve current names and
    // render locked when the viewer can't see the board (backlinks must
    // not name boards a reader has no access to).
    boards: props.workspaceBoards ?? [],
    teams: props.teams,
    // Tag chips render the tag's current name — renames update the chat live.
    tags: props.workspaceTags,
    // # citations in board chat resolve across the org (same maps the
    // card drawer uses); chips read "Board › Card title".
    cardNumbers: [
      ...props.cards.map((c) => c.number).filter((number): number is number => number !== null),
      ...props.crossCards
        .map((c) => c.number)
        .filter((number): number is number => number !== null),
    ],
    cardRefs: new Map<number, { title: string | null; board: string }>(
      [
        ...props.cards.map((c) => [c.number, { title: c.title, board: props.boardName }]),
        ...props.crossCards.map((c) => [c.number, { title: c.title, board: c.board_name }]),
      ].filter(([num]) => num !== null) as [number, { title: string | null; board: string }][],
    ),
    accessibleCardIds: new Set<string>([
      ...props.cards.map((c) => c.id),
      ...props.crossCards.map((c) => c.id),
    ]),
    crossCards: new Map(
      props.crossCards.map((c) => [c.id, { title: c.title, board: c.board_name }]),
    ),
  });

  const navigate = useNavigate();
  /** Team chips in messages route to the team page; # citations open the
   *  card (this board) or its board (cross-board). */
  const onBodyClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const user = target?.closest?.('[data-user-id]');
    if (user) {
      event.preventDefault();
      navigate(`/u/${user.getAttribute('data-user-id') ?? ''}`);
      return;
    }
    const chip = target?.closest?.('[data-team-id]');
    if (chip && props.workspaceId) {
      event.preventDefault();
      navigate(`/w/${props.workspaceId}/t/${chip.getAttribute('data-team-id') ?? ''}`);
      return;
    }
    const tag = target?.closest?.('[data-tag-id]');
    if (tag && props.workspaceId) {
      event.preventDefault();
      navigate(`/w/${props.workspaceId}/tags/${tag.getAttribute('data-tag-id') ?? ''}`);
      return;
    }
    const ref = target?.closest?.('[data-card-ref]');
    if (ref) {
      event.preventDefault();
      props.onOpenCardRef(Number(ref.getAttribute('data-card-ref')));
      return;
    }
    const cross = target?.closest?.('[data-card-id]');
    if (cross) {
      event.preventDefault();
      // Backlink anchors ride on the chip: open the citing comment /
      // description event, not just the card.
      props.onOpenCrossCard(cross.getAttribute('data-card-id') ?? '', {
        commentId: cross.getAttribute('data-comment-id') ?? undefined,
        event: cross.getAttribute('data-event') ?? undefined,
      });
      return;
    }
    const board = target?.closest?.('[data-board-id]');
    if (board) {
      event.preventDefault();
      // A backlink chip carries the citing message: land ON it, not just
      // on the board.
      const anchor = board.getAttribute('data-message-id');
      navigate(`/b/${board.getAttribute('data-board-id') ?? ''}${anchor ? `?chat=${anchor}` : ''}`);
    }
  };

  /** Hovering a team chip raises its profile card; leaving chips clears. */
  const onChipHover = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const chip = target?.closest?.('[data-team-id]');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      props.onHover({
        kind: 'team',
        id: chip.getAttribute('data-team-id') ?? '',
        rect,
      });
    } else if (target?.closest?.('[data-user-id]')) {
      const userChip = target!.closest('[data-user-id]') as HTMLElement | null;
      if (userChip) {
        props.onHover({
          kind: 'user',
          id: userChip.getAttribute('data-user-id') ?? '',
          rect: userChip.getBoundingClientRect(),
        });
      }
    } else {
      props.onHover(null);
    }
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <Show
          when={engine.view().list.length > 0}
          fallback={
            <p class="py-8 text-center text-xs text-neutral-400">
              No messages yet — say hi, @mention people or teams.
            </p>
          }
        >
          <ul class="flex flex-col gap-3">
            <For each={engine.view().list}>
              {(message) => {
                const mine = () => message.author_id !== null && message.author_id === props.myId;
                return (
                  <li
                    data-msg-id={message.id}
                    class={`group flex items-start gap-2 ${mine() ? 'flex-row-reverse' : ''}`}
                  >
                    <Avatar src={message.avatar_url} name={message.author} size="sm" />
                    <div
                      class={`flex min-w-0 max-w-[85%] flex-col ${mine() ? 'items-end text-right' : ''}`}
                    >
                      <p
                        class={`flex items-center gap-2 text-[11px] text-neutral-400 ${mine() ? 'flex-row-reverse' : ''}`}
                      >
                        <span class="font-semibold text-neutral-500 dark:text-neutral-300">
                          {mine() ? 'You' : message.author}
                        </span>
                        <Show when={message.agent}>
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
                          {new Date(message.created_at).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </time>
                        <Show when={message.edited_at && !message.deleted_at}>
                          <span
                            class="italic"
                            title={`Edited ${new Date(message.edited_at!).toLocaleString(
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
                        <Show when={canEditMsg(message) || canDeleteMsg(message)}>
                          <span
                            class={[
                              'flex items-center gap-1 transition-opacity',
                              confirmId() === message.id
                                ? 'opacity-100'
                                : 'opacity-0 group-hover:opacity-100',
                            ]}
                          >
                            <Show when={canEditMsg(message)}>
                              <button
                                type="button"
                                title="Edit message"
                                class="rounded px-1 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                                onClick={() => startEdit(message)}
                              >
                                ✏️
                              </button>
                            </Show>
                            <Show when={canDeleteMsg(message)}>
                              <button
                                type="button"
                                title={
                                  confirmId() === message.id
                                    ? 'Click again to delete'
                                    : 'Delete message'
                                }
                                class={[
                                  'rounded px-1 text-[10px] font-semibold hover:bg-neutral-200 dark:hover:bg-neutral-700',
                                  { 'text-red-500': confirmId() === message.id },
                                ]}
                                onClick={() => askDelete(message)}
                              >
                                {confirmId() === message.id ? 'Delete?' : '🗑'}
                              </button>
                            </Show>
                          </span>
                        </Show>
                      </p>
                      <Show
                        when={!message.deleted_at}
                        fallback={
                          // The deletion trail: real mention chips (avatars,
                          // hovers, rename-proof) + the role the deleter held.
                          <p
                            class="prose-card mt-0.5 text-xs italic text-neutral-400"
                            // oxlint-disable-next-line solid/no-innerhtml -- renderMarkdown() sanitizes (DOMPurify)
                            innerHTML={renderMarkdown(
                              tombstoneLine(
                                message,
                                props.myId,
                                props.members,
                                props.teams,
                                'message',
                              ),
                              markdownContext(),
                            )}
                            onClick={onBodyClick}
                            onMouseOver={onChipHover}
                          />
                        }
                      >
                        <Show
                          when={editingId() !== message.id}
                          fallback={
                            <form
                              class={[
                                'mt-0.5 flex w-full flex-col gap-1.5',
                                { 'text-left': mine() },
                              ]}
                              onSubmit={(event) => {
                                event.preventDefault();
                                saveEdit();
                              }}
                            >
                              <SmartTextarea
                                value={editDraft()}
                                onInput={setEditDraft}
                                members={props.members}
                                teams={props.teams}
                                cards={props.cards}
                                workspaceTags={props.workspaceTags}
                                crossCards={props.crossCards}
                                workspaceBoards={props.workspaceBoards}
                                boardName={props.boardName}
                                board={{ id: props.boardId, name: props.boardName }}
                                rows={2}
                                sendOnEnter
                                onSend={() => saveEdit()}
                                placeholder="Edit message…"
                              />
                              <div class="flex items-center justify-end gap-2 text-xs">
                                <button
                                  type="button"
                                  class="rounded-md px-2 py-0.5 font-medium text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                                  onClick={() => setEditingId(null)}
                                >
                                  Cancel
                                </button>
                                <button
                                  type="submit"
                                  disabled={!editDraft().trim()}
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
                            // oxlint-disable-next-line solid/no-innerhtml -- renderMarkdown() sanitizes (DOMPurify)
                            innerHTML={renderMarkdown(message.body, markdownContext())}
                            onClick={onBodyClick}
                            onMouseOver={onChipHover}
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

      <div class="shrink-0 border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <Show
          when={blocked().length > 0 || blockedTeams().length > 0 || accessNote()}
          fallback={<span />}
        >
          <div class="mb-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-800 dark:bg-amber-950/50">
            <Show
              when={blocked().length > 0 || blockedTeams().length > 0}
              fallback={
                <p class="flex items-start gap-2 text-amber-800 dark:text-amber-200">
                  <span class="flex-1">{accessNote()}</span>
                  <button
                    type="button"
                    class="font-semibold text-amber-500 hover:text-amber-800 dark:hover:text-amber-200"
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

        <Show
          when={props.canEdit}
          fallback={
            <p class="text-center text-xs text-neutral-400">
              View only — ask an admin for write access to chat.
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
              value={draft()}
              onInput={setDraft}
              members={props.members}
              teams={props.teams}
              cards={props.cards}
              workspaceTags={props.workspaceTags}
              crossCards={props.crossCards}
              workspaceBoards={props.workspaceBoards}
              boardName={props.boardName}
              board={{ id: props.boardId, name: props.boardName }}
              rows={2}
              sendOnEnter
              onSend={() => post()}
              placeholder="Message the board… @ to mention, # to cite a card or tag"
            />
            <div class="flex items-center justify-between">
              <span class="text-[10px] text-neutral-400">
                <kbd class="rounded border border-neutral-200 px-1 dark:border-neutral-700">
                  Enter
                </kbd>{' '}
                to send ·<span class="font-semibold">#</span> cite
              </span>
              <button
                type="submit"
                disabled={!draft().trim()}
                class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </form>
        </Show>
      </div>
    </div>
  );
}

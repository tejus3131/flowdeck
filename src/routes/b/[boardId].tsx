import { Title } from '@solidjs/meta';
import type { RouteProps } from '@solidjs/router';
import { liveQuery, revalidate, useNavigate, useSearchParams } from '@solidjs/router';
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onSettled } from 'solid-js';

import { Avatar } from '../../components/Avatar';
import { PriorityPill } from '../../components/PriorityPill';
import { ACCESS_ENTITY, createBoardEngine, createEngine } from '../../lib/sync';
import { createBoardPresence, presenceColor, type RemoteDrag } from '../../lib/presence';
import { createWorkspaceRelay } from '../../lib/workspace-relay';
import {
  accessKey,
  applyDetailOp,
  echoDetailOp,
  guardsForDetailOp,
  mergeWorkspaceDetail,
  tempIdsForDetailOp,
  WS_OPS_KNOWN,
  type AccessChangedOp,
  type WorkspaceOpPayload,
} from '../../lib/workspace-ops';
import {
  applyBoardOp,
  echoBoardOp,
  guardsFor,
  OPS_KNOWN,
  tempIdsFor,
  type BoardOpPayload,
} from '../../lib/board-ops';
import { getMe } from '../../lib/auth';
import { renderMarkdown } from '../../lib/markdown';
import { mentionIds, mentionTeamIds } from '../../lib/notification-text';
import { markSeen, unseenCount } from '../../lib/seen';
import { boardChatStamp, stampBoardChatSeen } from '../../lib/board-chat-seen';
import { openBoardChat, openCardScope } from '../../lib/open-scopes';
import { createPanelWidth } from '../../lib/panel-width';
import { statusOf, type PublicStatus } from '../../lib/status';
import {
  markBoardNotificationsSeen,
  markCardNotificationsSeen,
} from '../../lib/notifications';
import {
  checkMentionAccess,
  grantMentionAccess,
  requestMentionAccess,
  type BlockedMention,
} from '../../lib/access';
import {
  addComment,
  boardChatStream,
  boardStream,
  cardCommentsStream,
  createCard,
  createList,
  deleteBoard,
  deleteCard,
  deleteList,
  findOrCreateTag,
  getBoardSnapshot,
  getCrossBoardCards,
  type CrossCard,
  getBoardChatSnapshot,
  getCardComments,
  getCardEvents,
  type CardEventRow,
  moveCard as moveCardServer,
  postBoardMessage,
  type BoardMessageRow,
  updateBoard as updateBoardServer,
  updateList as updateListServer,
  updateCard as updateCardServer,
  type BoardSnapshot,
  type CardView,
  type CommentRow,
  type ListRow,
} from '../../lib/boards';
import {
  getMyWorkspaces,
  getWorkspaceSnapshot,
  setBoardAccess,
  switchWorkspace,
  workspaceStream,
  type Member,
  type TeamView,
  type WorkspaceDetail,
} from '../../lib/workspaces';
import { setBoardTeamAccess } from '../../lib/teams';
import { getChatPref, setChatPref, CHAT_LEVELS, type ChatLevel } from '../../lib/chat-prefs';
import {
  checkTeamMentionAccess,
  grantTeamMentionAccess,
  requestTeamMentionAccess,
  type BlockedTeam,
} from '../../lib/access';
const EMPTY: BoardSnapshot = {
  board: { id: '', name: '', owner_id: '', workspace_id: null, created_at: '', updated_at: '', client_op: null, description: '', access_delegation: false },
  lists: [],
  cards: [],
  revision: 0,
  myAccess: null,
  denied: false,
};

/** The workspace-detail engine's empty state (settings drawer). */
const EMPTY_WORKSPACE: WorkspaceDetail = {
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

/** Fractional position for a card dropped at display index `toIndex`. */
function positionAt(cards: CardView[], listId: string, toIndex: number): number {
  const positions = cards
    .filter((card) => card.list_id === listId)
    .map((card) => card.position)
    .sort((a, b) => a - b);
  const prev = positions[toIndex - 1];
  const next = positions[toIndex];
  if (prev === undefined && next === undefined) return 1;
  if (prev === undefined) return next / 2;
  if (next === undefined) return prev + 1;
  return (prev + next) / 2;
}

const OP_LABELS: Record<string, string> = {
  addCard: 'Couldn\u2019t add that card',
  moveCard: 'Couldn\u2019t move that card',
  deleteCard: 'Couldn\u2019t delete that card',
  updateCard: 'Couldn\u2019t save that card',
  addList: 'Couldn\u2019t add that list',
  deleteList: 'Couldn\u2019t delete that list',
  renameList: 'Couldn\u2019t rename that list',
  renameBoard: 'Couldn\u2019t rename the board',
};

/** A comment op payload (the drawer's engine consumes these too). */
type CommentOp = Extract<BoardOpPayload, { kind: 'comment-created' }>;

/** What the open drawer hears from the board relay: a comment op, or the
 *  failure of one (both engines' predictions drop under the same id). */
type CommentBusEvent =
  | { type: 'op'; payload: CommentOp; opId: string }
  | { type: 'fail'; opId: string };

export default function Board(props: RouteProps<'/b/:boardId'>) {
  // liveQuery: one shared channel per board, request-scoped on the server
  // (SSR renders the first value and closes), reconnecting on the client.
  const boardLive = liveQuery(boardStream, 'board');
  const engine = createBoardEngine(
    (boardId) => boardLive(boardId),
    () => props.params.boardId,
    EMPTY,
    () => boardLive.status(props.params.boardId),
    () => getBoardSnapshot(props.params.boardId),
  );
  const view = engine.view;
  const me = createMemo(() => getMe());
  const navigate = useNavigate();

  /** A comment op payload (the drawer's engine consumes these too). */
  type CommentOp = Extract<BoardOpPayload, { kind: 'comment-created' }>;

  /** What the open drawer hears from the board relay: a comment op, or the
   *  failure of one (both engines' predictions drop under the same id). */
  type CommentBusEvent =
    | { type: 'op'; payload: CommentOp; opId: string }
    | { type: 'fail'; opId: string };

  /** Live feed from the board relay into the open drawer's comment engine:
   *  received comment-created ops also append the row there. */
  const commentListeners = new Set<(event: CommentBusEvent) => void>();
  const commentBus = {
    emit: (payload: CommentOp, opId: string) => {
      for (const listener of commentListeners) listener({ type: 'op', payload, opId });
    },
    emitFail: (opId: string) => {
      for (const listener of commentListeners) listener({ type: 'fail', opId });
    },
    on: (listener: (event: CommentBusEvent) => void) => {
      commentListeners.add(listener);
      return () => commentListeners.delete(listener);
    },
  };

  // ── provisional ops: the Figma relay ────────────────────────────────
  // The author applies + sends + RELAYS the op; receivers apply it as a
  // prediction the same instant. The durable echo retires it everywhere,
  // guards hold intermediate snapshots off, and the author's failure
  // relay (or the TTL) drops a prediction that never landed.

  /** Author path: outbox op + relay to the other viewers. */
  const runOp = (
    payload: BoardOpPayload,
    send: () => Promise<unknown>,
  ) => {
    const opId = crypto.randomUUID();
    engine.mutate({
      kind: payload.kind,
      guards: guardsFor(payload),
      tempIds: tempIdsFor(payload),
      apply: (draft) => applyBoardOp(draft, payload, new Date().toISOString()),
      send: () =>
        send().catch((error) => {
          // The write failed on OUR side: let peers drop the prediction.
          presence.broadcastOpFail(opId);
          throw error;
        }),
      echo: (durable) => echoBoardOp(durable, payload),
    });
    presence.broadcastOp({ opId, payload });
  };

  const presence = createBoardPresence(props.params.boardId, () => me(), (op) => {
    // Receiver path: apply the relay as a provisional prediction. Unknown
    // payload shapes (older/newer clients) are ignored — the echo covers.
    if ('payload' in op && op.payload && typeof op.payload === 'object') {
      const payload = op.payload as BoardOpPayload;
      if (typeof payload.kind === 'string' && OPS_KNOWN.has(payload.kind)) {
        engine.applyRemote(
          {
            kind: payload.kind,
            guards: guardsFor(payload),
            tempIds: tempIdsFor(payload),
            apply: (draft) => applyBoardOp(draft, payload, new Date().toISOString()),
            echo: (durable) => echoBoardOp(durable, payload),
          },
          op.opId,
        );
        // A comment lands in the open drawer's own engine as well.
        if (payload.kind === 'comment-created') {
          commentBus.emit(payload, op.opId);
        }
      }
    } else if ('opId' in op) {
      engine.failRemote(op.opId);
      // The open drawer's copy of that op drops too (same op id).
      commentBus.emitFail(op.opId);
    }
  });

  // ── workspace detail: members, roles, and per-board access overrides ──
  // Powers the settings drawer's grant UI. Durable snapshots arrive on the
  // workspace stream; provisional ops on the relay below. The key follows
  // the board's workspace (null until the board snapshot lands — the engine
  // simply re-keys when it appears).
  const workspaceLive = liveQuery(workspaceStream, 'ws-detail');
  const wsEngine = createEngine<WorkspaceDetail>({
    streamSource: (key) => workspaceLive(key),
    key: () => view().board.workspace_id ?? '',
    empty: EMPTY_WORKSPACE,
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
    status: () => workspaceLive.status(view().board.workspace_id ?? ''),
    refresh: async () => {
      const wsId = view().board.workspace_id;
      return wsId ? (await getWorkspaceSnapshot(wsId)) ?? EMPTY_WORKSPACE : EMPTY_WORKSPACE;
    },
  });

  // Direct visits (link, bookmark, notification) can land on a board whose
  // workspace isn't the active one — the switcher, dashboard, and every
  // workspace-scoped page must agree with what's on screen, so the active
  // choice follows the board's workspace. Board-only guests (no membership
  // in the board's workspace) keep their current choice untouched.
  createEffect(
    () => view().board.workspace_id,
    (boardWorkspaceId) => {
      if (!boardWorkspaceId) return;
      void (async () => {
        const mine = await getMyWorkspaces();
        if (!mine.some((ws) => ws.id === boardWorkspaceId)) return;
        if (mine.some((ws) => ws.current && ws.id === boardWorkspaceId)) return;
        try {
          await switchWorkspace(boardWorkspaceId);
          revalidate('workspaces');
          revalidate('boards');
        } catch {
          // Membership raced away mid-view — the board itself still renders.
        }
      })();
    },
  );

  // The workspace relay carries workspace life into this page twice over:
  //  * the SETTINGS DRAWER's engine (members, roles, access overrides)
  //  * the board engine's myAccess — an admin flips THIS viewer's access
  //    and the editing surface appears/disappears instantly (the guarded
  //    myAccess holds against older durable snapshots until the echo
  //    confirms).
  // The author of an access change broadcasts here; the drawer's author
  // path mirrors it (an author's own broadcast doesn't loop back).
  const wsRelay = createWorkspaceRelay(
    () => view().board.workspace_id,
    () => me(),
    (op) => {
      if ('payload' in op && op.payload && typeof op.payload === 'object') {
        const payload = op.payload as WorkspaceOpPayload;
        if (!WS_OPS_KNOWN.has(payload.kind)) return;
        const meId = me()?.id ?? null;
        wsEngine.applyRemote(
          {
            kind: payload.kind,
            guards: guardsForDetailOp(payload, meId),
            tempIds: tempIdsForDetailOp(payload),
            apply: (draft) => applyDetailOp(draft, payload, meId, new Date().toISOString()),
            echo: (durable) => echoDetailOp(durable, payload, meId),
          },
          op.opId,
        );
        // An access change on THIS board targeting ME flips my surface.
        if (
          payload.kind === 'access-changed' &&
          payload.boardId === props.params.boardId &&
          payload.userId === meId
        ) {
          engine.applyRemote(
            {
              kind: payload.kind,
              guards: [ACCESS_ENTITY],
              apply: (draft) => {
                draft.myAccess = payload.access;
              },
              echo: (durable) => durable.myAccess === payload.access,
            },
            op.opId,
          );
        }
        // Removed from the workspace while viewing: the page stops being ours.
        if (payload.kind === 'member-removed' && payload.userId === meId) {
          navigate('/');
        }
      } else if ('opId' in op) {
        // An author's write failed: drop the prediction wherever it lives
        // (each engine no-ops on ids it doesn't hold).
        wsEngine.failRemote(op.opId);
        engine.failRemote(op.opId);
      }
    },
  );

  // Route param change (navigating board → board) keeps this component
  // mounted — close the old board's drawer + hover so they don't leak
  // onto the new board.
  createEffect(
    () => props.params.boardId,
    (boardId, prev) => {
      if (prev !== undefined && boardId !== prev) {
        setOpenCardId(null);
        setOpenCardOp(null);
        setHover(null);
      }
    },
  );

  // Deep links: ?card=<id> opens the drawer, ?chat=1 opens the chat tab.
  const [searchParams, setSearchParams] = useSearchParams<{ card?: string; chat?: string }>();
  createEffect(
    () => (view().board.id ? searchParams.card : null),
    (cardId) => {
      if (cardId && view().cards.some((c) => c.id === cardId)) {
        openCard(cardId, view().cards.find((c) => c.id === cardId)?.client_op ?? null);
        setSearchParams({ card: '' }, { replace: true });
      }
    },
  );
  createEffect(
    () => (view().board.id ? searchParams.chat : null),
    (chat) => {
      if (chat) {
        switchPanel('chat');
        setSearchParams({ chat: '' }, { replace: true });
      }
    },
  );


  // Opening the board = seeing its board-level rows (access notes): they
  // auto-mark read the moment the page renders.
  createEffect(
    () => view().board.id,
    (id) => {
      if (id) void markBoardNotificationsSeen(id).catch(() => {});
    },
  );

  const [dragging, setDragging] = createSignal<string | null>(null);
  const [dropHint, setDropHint] = createSignal<{ listId: string; index: number } | null>(null);
  const [openCardId, setOpenCardId] = createSignal<string | null>(null);
  // Detail hover cards over @mentions and #citations.
  const [hover, setHover] = createSignal<
    { kind: 'user' | 'card' | 'tag' | 'team'; id: string; rect: DOMRect } | null
  >(null);
  // Cross-board reference targets, fetched when the drawer first opens.
  const [crossCards, setCrossCards] = createSignal<CrossCard[]>([]);
  createEffect(
    () => openCardId(),
    (id) => {
      if (id && crossCards().length === 0) {
        const wsId = view().board.workspace_id;
        if (wsId)
          void getCrossBoardCards(wsId)
            .then(setCrossCards)
            .catch(() => {});
      }
    },
  );
  // The clicked card's client_op: the drawer re-resolves the card when the
  // provisional row (temp id) swaps for the durable echo (different id).
  const [openCardOp, setOpenCardOp] = createSignal<string | null>(null);
  const openCard = (id: string, clientOp: string | null) => {
    // One panel, one owner: opening the card drawer closes the board panel
    // (they share the same right side — never stacked).
    switchPanel(null);
    setOpenCardId(id);
    setOpenCardOp(clientOp);
  };
  /** The open card's CURRENT id — provisional rows swap for their durable
   *  echo (different id, same client_op); this survives the swap. */
  const openCardResolvedId = (): string => {
    const id = openCardId() ?? '';
    if (view().cards.some((c) => c.id === id)) return id;
    const op = openCardOp();
    const byOp = op ? view().cards.find((c) => c.client_op === op) : undefined;
    return byOp?.id ?? id;
  };
  const [addingIn, setAddingIn] = createSignal<string | null>(null);
  const [renamingBoard, setRenamingBoard] = createSignal(false);

  // The shared panel's user-set width (per-device, localStorage).
  const panelWidth = createPanelWidth();
  /** The inline style both panel asides use when the user has resized. */
  const panelStyle = () => {
    const w = panelWidth.width();
    return w === null ? {} : { width: `${w}px` };
  };

  // ── per-device list collapse (localStorage — a preference, not data) ──
  const collapsedKey = () => `fd-collapsed-lists:${props.params.boardId}`;
  const [collapsedLists, setCollapsedLists] = createSignal<Set<string>>(new Set());
  onSettled(() => {
    try {
      const raw = localStorage.getItem(collapsedKey());
      if (raw) setCollapsedLists(new Set(JSON.parse(raw) as string[]));
    } catch {
      // fresh start on corrupt storage
    }
  });
  const toggleListCollapse = (listId: string) => {
    setCollapsedLists((current) => {
      const next = new Set(current);
      if (next.has(listId)) next.delete(listId);
      else next.add(listId);
      try {
        localStorage.setItem(collapsedKey(), JSON.stringify([...next]));
      } catch {
        // private mode — the toggle still works for this visit
      }
      return next;
    });
  };

  // ── engine ops: instant local apply, server ACK, echo retirement ──────
  const addCard = (listId: string, title: string) => {
    const position =
      (view().cards.filter((c) => c.list_id === listId).reduce((max, c) => Math.max(max, c.position), 0) || 0) + 1;
    const clientOp = crypto.randomUUID();
    runOp(
      { kind: 'create-card', tempId: crypto.randomUUID(), listId, title, position, clientOp },
      () => createCard(listId, title, clientOp),
    );
  };

  const moveCard = (cardId: string, toListId: string, toIndex: number) => {
    const position = positionAt(view().cards, toListId, toIndex);
    runOp(
      { kind: 'move-card', cardId, listId: toListId, position },
      () => moveCardServer(cardId, toListId, position),
    );
  };

  const removeCard = (cardId: string) => {
    runOp({ kind: 'delete-card', cardId }, () => deleteCard(cardId));
  };

  const addList = (name: string) => {
    const position = (view().lists.reduce((max, l) => Math.max(max, l.position), 0) || 0) + 1;
    const clientOp = crypto.randomUUID();
    runOp(
      { kind: 'create-list', tempId: crypto.randomUUID(), name, position, clientOp },
      () => createList(props.params.boardId, name, clientOp),
    );
  };

  const removeList = (listId: string) => {
    runOp({ kind: 'delete-list', listId }, () => deleteList(listId));
  };

  const renameList = (listId: string, name: string) => {
    runOp({ kind: 'update-list', listId, name }, () => updateListServer(listId, { name }));
  };

  const renameBoard = (name: string) => {
    runOp({ kind: 'update-board', name }, () => updateBoardServer(props.params.boardId, { name }));
  };
  const describeBoard = (description: string) => {
    runOp({ kind: 'update-board', description }, () =>
      updateBoardServer(props.params.boardId, { description }),
    );
  };
  /** Owners/admins: may anyone with access grant others onto this board?
   *  Drives the mention flow — ON lets mentioners grant directly, OFF
   *  routes them through an ask-the-admins request. */
  const toggleDelegation = (on: boolean) => {
    runOp(
      { kind: 'update-board', accessDelegation: on },
      () => updateBoardServer(props.params.boardId, { accessDelegation: on }),
    );
  };

  // ── board settings: who's in, who can do what ─────────────────────────
  // One side panel, two tabs (chat + settings) — full height either way.
  const [panel, setPanel] = createSignal<'chat' | 'settings' | null>(null);
  // While the chat tab is open, this board is "on screen": its fresh
  // mention/chat rows are quietly read instead of toasting.
  let releaseChatScope: (() => void) | undefined;
  const switchPanel = (tab: 'chat' | 'settings' | null) => {
    // One panel, one owner: opening the board panel closes the card
    // drawer — they'd otherwise stack on the same right side.
    if (tab) {
      setOpenCardId(null);
      setHover(null);
    }
    if (panel() === 'chat' && tab !== 'chat') {
      releaseChatScope?.();
      releaseChatScope = undefined;
    }
    if (tab === 'chat' && panel() !== 'chat') {
      releaseChatScope = openBoardChat(props.params.boardId);
      stampBoardChatSeen(props.params.boardId, Date.now());
      setChatUnread(0);
    }
    setPanel(tab);
  };
  onCleanup(() => releaseChatScope?.());
  const openPanel = (tab: 'chat' | 'settings') =>
    switchPanel(panel() === tab ? null : tab);

  // ── board chat unread: a dot on the 💬 button while the panel is shut.
  // The panel + this counter share ONE live query channel; the stamp is
  // per-device (a message is "new" until this device has seen it).
  const chatStamp = () => boardChatStamp(props.params.boardId);
  const stampChatSeen = (latest: number) => stampBoardChatSeen(props.params.boardId, latest);
  const chatLive = liveQuery(boardChatStream, 'board-chat');
  const [chatUnread, setChatUnread] = createSignal(0);
  const chatLatest = (list: { created_at: string }[]): number =>
    list.length > 0 ? +new Date(list[list.length - 1]!.created_at) : 0;
  onSettled(() => {
    void (async () => {
      try {
        for await (const list of await chatLive(props.params.boardId)) {
          if (panel() === 'chat') {
            stampChatSeen(chatLatest(list));
            setChatUnread(0);
          } else {
            setChatUnread(
              list.filter((row) => +new Date(row.created_at) > chatStamp()).length,
            );
          }
        }
      } catch {
        // the chat panel still works without the dot
      }
    })();
  });
  const [settingsError, setSettingsError] = createSignal<string | null>(null);
  const detail = createMemo(() => wsEngine.view());
  // Membership-loss fall-back: once this viewer HAD a workspace role here
  // and the live detail loses it (removed, left, or the workspace was
  // deleted — the stream ends empty), fall back to the workspace picker.
  let hadRoleHere = false;
  createEffect(
    () => detail().myRole,
    (role) => {
      if (role) {
        hadRoleHere = true;
        return;
      }
      if (!hadRoleHere) return; // still loading — nothing lost yet
      revalidate('workspaces');
      revalidate('boards');
      navigate('/');
    },
  );
  const myRole = () => detail().myRole;
  const isWsAdmin = () => myRole() === 'owner' || myRole() === 'admin';
  const canDeleteBoard = () => view().board.owner_id === (me()?.id ?? '') || isWsAdmin();

  /** Author path for a workspace op (settings drawer): outbox op + relay.
   *  The author's own board engine flip for self-targeting ops rides along
   *  (their broadcast doesn't loop back to them). */
  const wsRunOp = (payload: WorkspaceOpPayload, send: () => Promise<unknown>) => {
    const opId = crypto.randomUUID();
    const meId = me()?.id ?? null;
    wsEngine.mutate({
      kind: payload.kind,
      guards: guardsForDetailOp(payload, meId),
      tempIds: tempIdsForDetailOp(payload),
      apply: (draft) => applyDetailOp(draft, payload, meId, new Date().toISOString()),
      send: () =>
        send().catch((error) => {
          wsRelay.broadcastOpFail(opId);
          throw error;
        }),
      echo: (durable) => echoDetailOp(durable, payload, meId),
    });
    wsRelay.broadcastOp({ opId, payload });
    // Self-targeting access change: flip my own board engine too.
    if (
      payload.kind === 'access-changed' &&
      payload.boardId === props.params.boardId &&
      payload.userId === meId
    ) {
      engine.applyRemote(
        {
          kind: 'access-changed',
          guards: [ACCESS_ENTITY],
          apply: (draft) => {
            draft.myAccess = payload.access;
          },
          echo: (durable) => durable.myAccess === payload.access,
        },
        `${opId}:self`,
      );
    }
    return opId;
  };

  /** Grant a member none/view/write on THIS board — instant for everyone. */
  const changeAccess = (userId: string, access: 'edit' | 'view' | null) => {
    setSettingsError(null);
    const payload: AccessChangedOp = {
      kind: 'access-changed',
      boardId: props.params.boardId,
      userId,
      access,
    };
    wsRunOp(payload, () => setBoardAccess({ boardId: props.params.boardId, userId, access }));
  };

  /** A team's board access changed (settings drawer): mirror it on the
   *  relay so every open board settings + members page updates instantly. */
  const relayTeamAccess = (teamId: string, access: 'edit' | 'view' | null) => {
    const payload: WorkspaceOpPayload = {
      kind: 'team-access',
      boardId: props.params.boardId,
      teamId,
      access,
    };
    const opId = crypto.randomUUID();
    wsEngine.applyRemote(
      {
        kind: payload.kind,
        guards: guardsForDetailOp(payload, null),
        tempIds: [],
        apply: (draft) => applyDetailOp(draft, payload, null, new Date().toISOString()),
        echo: (durable) => echoDetailOp(durable, payload, null),
      },
      opId,
    );
    wsRelay.broadcastOp({ opId, payload });
  };

  /** A TEAM mention-grant landed: mirror it on the relay. */
  const relayTeamMentionGrant = (teamIds: string[]) => {
    for (const teamId of teamIds) {
      const payload: WorkspaceOpPayload = {
        kind: 'team-access',
        boardId: props.params.boardId,
        teamId,
        access: 'edit',
      };
      const opId = crypto.randomUUID();
      wsEngine.applyRemote(
        {
          kind: payload.kind,
          guards: guardsForDetailOp(payload, null),
          tempIds: [],
          apply: (draft) => applyDetailOp(draft, payload, null, new Date().toISOString()),
          echo: (durable) => echoDetailOp(durable, payload, null),
        },
        opId,
      );
      wsRelay.broadcastOp({ opId, payload });
    }
  };

  /** A mention-grant landed (from the card drawer): mirror it on the
   *  workspace relay so open settings drawers and member lists update
   *  instantly — the write itself already happened server-side. */
  const relayMentionGrant = (userIds: string[]) => {
    const meId = me()?.id ?? null;
    for (const userId of userIds) {
      const payload: AccessChangedOp = {
        kind: 'access-changed',
        boardId: props.params.boardId,
        userId,
        access: 'edit',
      };
      const opId = crypto.randomUUID();
      wsEngine.applyRemote(
        {
          kind: payload.kind,
          guards: guardsForDetailOp(payload, meId),
          tempIds: tempIdsForDetailOp(payload),
          apply: (draft) => applyDetailOp(draft, payload, meId, new Date().toISOString()),
          echo: (durable) => echoDetailOp(durable, payload, meId),
        },
        opId,
      );
      wsRelay.broadcastOp({ opId, payload });
    }
  };

  /** Effective access on this board — mirrors user_board_access(): a
   *  personal override beats everything; the board owner and workspace
   *  owners/admins always edit; then team grants fill the gap. */
  const effectiveAccess = (member: Member): 'edit' | 'view' | null => {
    const override = detail().access[accessKey(props.params.boardId, member.user_id)] ?? null;
    if (override) return override;
    if (
      view().board.owner_id === member.user_id ||
      member.role === 'owner' ||
      member.role === 'admin'
    ) {
      return 'edit';
    }
    const myTeams = new Set(
      detail()
        .teams.filter((team) => team.members.some((m) => m.user_id === member.user_id))
        .map((team) => team.id),
    );
    const grants = (detail().teamAccess[props.params.boardId] ?? [])
      .filter((grant) => myTeams.has(grant.teamId))
      .map((grant) => grant.access);
    if (grants.includes('edit')) return 'edit';
    if (grants.includes('view')) return 'view';
    return null;
  };

  /** Every member's override is adjustable by ws admins — a leftover
   *  personal 'view' (e.g. from member days, before a promotion) outranks
   *  the workspace role in user_board_access and would freeze an admin;
   *  setting it back to None lets the role speak (promotions also strip
   *  overrides server-side). */
  const isGrantable = (_member: Member) => true;

  const [deleting, setDeleting] = createSignal(false);
  const removeBoard = async () => {
    setSettingsError(null);
    setDeleting(true);
    try {
      await deleteBoard(props.params.boardId);
      // Relay-after-ack (server-minted identity): open dashboards drop the
      // board instantly; the durable echo covers everyone else.
      wsRelay.broadcastOp({
        opId: crypto.randomUUID(),
        payload: { kind: 'board-deleted', boardId: props.params.boardId },
      });
      navigate('/');
    } catch (error) {
      setDeleting(false);
      setSettingsError(error instanceof Error ? error.message : 'Could not delete the board');
    }
  };

  /** The board-side half of a posted comment: the card's stats bump rides
   *  the SAME relay op id everywhere — author and receivers apply it as one
   *  provisional op under one identity. The WRITE belongs to the drawer's
   *  engine alone (one insert); this half never sends, so the echo retires
   *  it and a failure reverts it via commentFailed below. */
  const postComment = (payload: CommentOp, relayOpId: string) => {
    engine.applyRemote(
      {
        kind: payload.kind,
        guards: guardsFor(payload),
        tempIds: tempIdsFor(payload),
        apply: (draft) => applyBoardOp(draft, payload, new Date().toISOString()),
        echo: (durable) => echoBoardOp(durable, payload),
      },
      relayOpId,
    );
    presence.broadcastOp({ opId: relayOpId, payload });
  };

  /** The drawer's insert failed: revert the stats bump here and at peers. */
  const commentFailed = (relayOpId: string) => {
    engine.failRemote(relayOpId);
    presence.broadcastOpFail(relayOpId);
  };

  const updateCard = (
    cardId: string,
    patch: {
      title?: string;
      description?: string;
      priority?: string | null;
      tags?: { id: string; name: string }[];
      assignees?: string[];
    },
    clientOp?: string | null,
  ) => {
    runOp(
      {
        kind: 'update-card',
        cardId,
        title: patch.title,
        description: patch.description,
        priority: patch.priority,
        tags: patch.tags,
        assignees: patch.assignees,
      },
      () =>
        updateCardServer(
          cardId,
          {
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
            ...(patch.tags !== undefined ? { tagIds: patch.tags.map((tag) => tag.id) } : {}),
            ...(patch.assignees !== undefined ? { assignees: patch.assignees } : {}),
          },
          clientOp ?? null,
        ),
    );
  };

  const syncing = () => engine.saving();
  // Viewers see the board without the editing surface: no mutation UI, no
  // drag; their effective access comes with every snapshot.
  const canEdit = () => view().myAccess === 'edit';

  return (
    <>
      <Title>{view().board.name || 'Board'} - Flowdeck</Title>
      <Show
        when={!view().denied}
        fallback={
          <main class="flex h-[calc(100vh-3rem)] flex-col items-center justify-center gap-3 px-4 text-center">
            <h1 class="text-lg font-semibold">No access to this board</h1>
            <p class="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">
              A workspace admin hasn't granted you view or write access here yet. This page
              updates on its own the moment you're added.
            </p>
            <a href="/" class="text-sm font-medium text-indigo-600 underline dark:text-indigo-400">
              Back to your boards
            </a>
          </main>
        }
      >
      <main class="flex h-[calc(100vh-3rem)] flex-col overflow-hidden">
        <header class="flex items-center gap-3 border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
          <a
            href="/"
            class="rounded-md px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
            title="All boards"
          >
            ←
          </a>

          <Show
            when={!renamingBoard()}
            fallback={
              <form
                class="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
                  if (name) renameBoard(name);
                  setRenamingBoard(false);
                }}
              >
                <input
                  name="name"
                  value={view().board.name}
                  class="max-w-64 py-1 text-base font-semibold"
                  autofocus
                  onBlur={() => setRenamingBoard(false)}
                />
              </form>
            }
          >
            <Show
              when={canEdit()}
              fallback={<span class="rounded-md px-2 py-1 text-base font-semibold tracking-tight">{view().board.name || '…'}</span>}
            >
              <button
                type="button"
                class="rounded-md px-2 py-1 text-base font-semibold tracking-tight hover:bg-neutral-100 dark:hover:bg-neutral-800"
                title="Rename board"
                onClick={() => setRenamingBoard(true)}
              >
                {view().board.name || '…'}
              </button>
            </Show>
          </Show>

          <Show when={!canEdit()}>
            <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300" title="An admin limited your access on this board">
              👁 View only
            </span>
          </Show>

          <button
            type="button"
            title="Board chat"
            class={`relative rounded-md px-2 py-1 text-sm hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-white ${
              panel() === 'chat' ? 'text-indigo-600 dark:text-indigo-400' : 'text-neutral-400'
            }`}
            onClick={() => {
              openPanel('chat');
              setChatUnread(0);
            }}
          >
            💬
            <Show when={chatUnread() > 0}>
              <span class="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-indigo-600 px-1 text-[9px] font-bold text-white">
                {chatUnread() > 9 ? '9+' : chatUnread()}
              </span>
            </Show>
          </button>
          <button
            type="button"
            title="Board settings — name, description, member access"
            class={`rounded-md px-2 py-1 text-sm hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-white ${
              panel() === 'settings' ? 'text-indigo-600 dark:text-indigo-400' : 'text-neutral-400'
            }`}
            onClick={() => openPanel('settings')}
          >
            ⚙
          </button>

          <span class="ml-auto flex items-center gap-2 text-xs text-neutral-400">
            <Show when={presence.others().length > 0}>
              <span class="flex -space-x-2">
                <For each={presence.others()}>
                  {(other) => (
                    <span
                      title={other.name}
                      class="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border-2 border-white text-[10px] font-semibold text-white dark:border-neutral-950"
                      style={{ 'background-color': presenceColor(other.userId) }}
                    >
                      <Show when={other.avatarUrl} fallback={other.name.slice(0, 2).toUpperCase()}>
                        <img src={other.avatarUrl!} alt={other.name} class="h-full w-full object-cover" />
                      </Show>
                    </span>
                  )}
                </For>
              </span>
            </Show>
            <Show when={syncing()}>
              <span class="flex items-center gap-1.5 rounded-full bg-neutral-100 px-2 py-0.5 dark:bg-neutral-800">
                <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" />
                Syncing
              </span>
            </Show>
            <Show when={engine.status() === 'reconnecting'}>
              <span class="flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-amber-600 dark:bg-amber-950 dark:text-amber-400">
                <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                Reconnecting…
              </span>
            </Show>
            <Show when={engine.status() === 'offline'}>
              <span class="rounded-full bg-red-50 px-2 py-0.5 text-red-600 dark:bg-red-950 dark:text-red-400">
                Offline
              </span>
            </Show>
            <Show when={view().lists.length > 0 || view().cards.length > 0}>
              <span>
                {view().lists.length} lists · {view().cards.length} cards
              </span>
            </Show>
          </span>
        </header>

        <div class="flex flex-1 gap-4 overflow-x-auto p-4">
          <For each={view().lists}>
            {(list) => (
              <BoardColumn
                list={list}
                cards={view().cards.filter((card) => card.list_id === list.id)}
                members={detail().members}
                dragging={dragging()}
                remoteDrag={presence.remoteDrag()?.cardId === undefined ? null : presence.remoteDrag()}
                dropHint={dropHint()?.listId === list.id ? dropHint()!.index : null}
                isTemp={engine.isTemp(list.id)}
                canEdit={canEdit()}
                onDragStart={(cardId) => {
                  setDragging(cardId);
                  presence.broadcastDrag(cardId, me()?.display_name || 'Someone');
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDropHint(null);
                  presence.broadcastDrag(null, '');
                }}
                onDrop={(index, cardId) => {
                  setDragging(null);
                  setDropHint(null);
                  // Cards still materializing can't be dragged yet (their
                  // real id hasn't been echoed) — the drop is a no-op.
                  if (cardId && canEdit() && !engine.isTemp(cardId)) moveCard(cardId, list.id, index);
                }}                onHover={(index) => setDropHint({ listId: list.id, index })}
                adding={addingIn() === list.id}
                onAdd={() => setAddingIn(list.id)}
                onCancelAdd={() => setAddingIn(null)}
                onSubmitAdd={(title) => {
                  setAddingIn(null);
                  addCard(list.id, title);
                }}
                onAddAnother={() => setAddingIn(list.id)}
                onRemove={() => removeList(list.id)}
                onRename={(name) => renameList(list.id, name)}
                onOpenCard={(cardId, clientOp) => openCard(cardId, clientOp)}
                onRemoveCard={(cardId) => removeCard(cardId)}
                collapsed={collapsedLists().has(list.id)}
                onToggleCollapse={() => toggleListCollapse(list.id)}
              />
            )}
          </For>

          <Show when={canEdit()}>
            <AddList onAdd={addList} />
          </Show>
        </div>
      </main>
      </Show>

      <Show when={openCardId()}>
        {(cardId) => (
          <CardDrawer
            cardId={cardId()}
            clientOp={openCardOp()}
            cards={view().cards}
            members={detail().members}
            workspaceId={view().board.workspace_id ?? ''}
            workspaceTags={detail().tags}
            crossCards={crossCards()}
            canEdit={canEdit()}
            boardName={view().board.name}
            accessDelegation={view().board.access_delegation}
            isWsAdmin={isWsAdmin()}
            onAccessGranted={relayMentionGrant}
            onTeamAccessGranted={relayTeamMentionGrant}
            myId={me()?.id ?? null}
            myAvatar={me()?.avatar_url ?? null}
            teams={detail().teams}
            myName={me()?.display_name ?? me()?.email?.split('@')[0] ?? 'You'}
            onClose={() => {
              setOpenCardId(null);
              setHover(null);
            }}
            onDelete={(cardIdNow) => {
              removeCard(cardIdNow);
              setOpenCardId(null);
            }}
            onUpdate={(patch) => updateCard(openCardResolvedId(), patch, openCardOp())}
            onPostComment={postComment}
            onCommentFail={commentFailed}
            onCommentArrived={commentBus.on}
            onOpenCardRef={(num) => {
              const target = view().cards.find((c) => c.number === num);
              if (target) openCard(target.id, target.client_op);
            }}
            onHover={setHover}
            panelWidth={panelWidth}
            onOpenCrossCard={(cardId) => {
              const target = crossCards().find((c) => c.id === cardId);
              setHover(null);
              if (target) navigate(`/b/${target.board_id}?card=${target.id}`);
            }}
            onOpenTag={(tagId) => {
              const tag = detail().tags.find((t) => t.id === tagId);
              setHover(null);
              navigate(tag ? `/search?tag=${encodeURIComponent(tag.name)}` : '/search');
            }}
          />
        )}
      </Show>

      <DetailHoverCard
        hover={hover()}
        members={detail().members}
        cards={view().cards}
        lists={view().lists}
        crossCards={crossCards()}
        workspaceTags={detail().tags}
        teams={detail().teams}
        onOpenCard={(cardId, clientOp) => {
          setHover(null);
          openCard(cardId, clientOp);
        }}
      />

      <Show when={panel() && view().board.id}>
        <div
          class="fixed inset-0 z-40 flex justify-end bg-neutral-950/20"
          onClick={() => switchPanel(null)}
        >
          <aside
            class="flex h-full w-full max-w-lg flex-col border-l border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
            style={panelStyle()}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              class={`absolute -left-1 top-0 z-10 hidden h-full w-2 cursor-col-resize md:block ${panelWidth.dragging() ? 'bg-indigo-500/40' : 'hover:bg-indigo-500/20'}`}
              title="Drag to resize"
              onMouseDown={panelWidth.startDrag}
            />
            <header class="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-100 px-4 py-2.5 dark:border-neutral-800">
              <div class="flex rounded-lg border border-neutral-200 p-0.5 dark:border-neutral-700">
                <button
                  type="button"
                  class={`rounded-md px-3 py-1 text-xs font-semibold ${
                    panel() === 'chat'
                      ? 'bg-indigo-600 text-white'
                      : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                  }`}
                  onClick={() => switchPanel('chat')}
                >
                  💬 Chat
                </button>
                <button
                  type="button"
                  class={`rounded-md px-3 py-1 text-xs font-semibold ${
                    panel() === 'settings'
                      ? 'bg-indigo-600 text-white'
                      : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                  }`}
                  onClick={() => switchPanel('settings')}
                >
                  ⚙ Settings
                </button>
              </div>
              <div class="flex items-center gap-2 text-xs">
                <Show when={panel() === 'chat'}>
                  <ChatPrefMenu scopeType="board" scopeId={props.params.boardId} />
                </Show>
                <button
                  type="button"
                  title="Close"
                  class="rounded-md px-2 py-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                  onClick={() => switchPanel(null)}
                >
                  ×
                </button>
              </div>
            </header>
            <Show when={panel() === 'chat'}>
              <BoardChat
                boardId={props.params.boardId}
                workspaceId={view().board.workspace_id ?? ''}
                members={detail().members}
                teams={detail().teams}
                cards={view().cards}
                crossCards={crossCards()}
                boardName={view().board.name}
                canEdit={canEdit()}
                myId={me()?.id ?? null}
                myAvatar={me()?.avatar_url ?? null}
                myName={me()?.display_name ?? me()?.email?.split('@')[0] ?? 'You'}
                accessDelegation={view().board.access_delegation}
                isWsAdmin={isWsAdmin()}
                onAccessGranted={relayMentionGrant}
                onTeamAccessGranted={relayTeamMentionGrant}
                onHover={setHover}
                onOpenCardRef={(num) => {
                  const target = view().cards.find((c) => c.number === num);
                  if (target) openCard(target.id, target.client_op);
                }}
                onOpenCrossCard={(cardId) => {
                  const target = crossCards().find((c) => c.id === cardId);
                  if (target) navigate(`/b/${target.board_id}?card=${target.id}`);
                }}
              />
            </Show>
            <Show when={panel() === 'settings'}>
              <BoardSettings
          boardId={props.params.boardId}
          board={view().board}
          canEdit={canEdit()}
          isWsAdmin={isWsAdmin()}
          canDelete={canDeleteBoard()}
          accessDelegation={view().board.access_delegation}
          onToggleDelegation={toggleDelegation}
          detail={detail()}
          meId={me()?.id ?? null}
          deleting={deleting()}
          error={settingsError()}
          onError={setSettingsError}
          onTeamAccessChanged={relayTeamAccess}
          onRename={renameBoard}
          onDescribe={describeBoard}
          onEffectiveAccess={effectiveAccess}
          onIsGrantable={isGrantable}
          onChangeAccess={changeAccess}
          onDelete={() => void removeBoard()}
          onClose={() => setPanel(null)}
        />
            </Show>
          </aside>
        </div>
      </Show>

      <FailureToasts
        failures={engine.failed()}
        onRetry={engine.retry}
        onDismiss={engine.dismiss}
      />
    </>
  );
}

function BoardColumn(props: {
  list: ListRow;
  cards: CardView[];
  members: Member[];
  dragging: string | null;
  remoteDrag: RemoteDrag | null;
  dropHint: number | null;
  isTemp: boolean;
  canEdit: boolean;
  adding: boolean;
  onDragStart: (cardId: string) => void;
  onDragEnd: () => void;
  onDrop: (index: number, cardId: string | null) => void;
  onHover: (index: number) => void;
  onAdd: () => void;
  onCancelAdd: () => void;
  onSubmitAdd: (title: string) => void;
  onAddAnother: () => void;
  onRemove: () => void;
  onRename: (name: string) => void;
  onOpenCard: (cardId: string, clientOp: string | null) => void;
  onRemoveCard: (cardId: string) => void;
  /** Per-device collapse state (a preference — "hide the done pile"). */
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const [renaming, setRenaming] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [keepOpen, setKeepOpen] = createSignal(false);

  // Where in this column a pointer sits: the index the dropped card takes.
  const indexAt = (clientY: number): number => {
    const elements = document.querySelectorAll<HTMLDivElement>(
      `[data-column="${props.list.id}"] [data-card]`,
    );
    let index = elements.length;
    for (let i = 0; i < elements.length; i++) {
      const rect = elements[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        index = i;
        break;
      }
    }
    return index;
  };

  return (
    <section
      data-column={props.list.id}
      class={[
        'flex shrink-0 flex-col rounded-2xl border border-neutral-200/80 bg-neutral-100/60 dark:border-neutral-800 dark:bg-neutral-900/70',
        props.collapsed ? 'w-56' : 'w-72',
        { 'animate-pulse': props.isTemp },
      ]}      onDragOver={(event) => {
        if (!props.dragging) return;
        event.preventDefault();
        props.onHover(indexAt(event.clientY));
      }}
      onDrop={(event) => {
        event.preventDefault();
        props.onDrop(indexAt(event.clientY), props.dragging);
      }}
    >
      <header class="flex items-center justify-between gap-2 px-3 pt-3">
        <Show
          when={!renaming()}
          fallback={
            <form
              class="flex-1"
              onSubmit={(event) => {
                event.preventDefault();
                const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
                if (name) props.onRename(name);
                setRenaming(false);
              }}
            >
              <input
                name="name"
                value={props.list.name}
                class="w-full px-2 py-0.5 text-sm font-semibold"
                onBlur={() => setRenaming(false)}
              />
            </form>
          }
        >
          <Show
            when={props.canEdit}
            fallback={
              <span class="rounded-md px-1.5 py-0.5 text-sm font-semibold">{props.list.name}</span>
            }
          >
            <button
              type="button"
              class="rounded-md px-1.5 py-0.5 text-sm font-semibold hover:bg-neutral-200/70 dark:hover:bg-neutral-800"
              title="Rename list"
              onClick={() => setRenaming(true)}
            >
              {props.list.name}
            </button>
          </Show>
        </Show>
        <div class="flex items-center gap-1.5 text-xs text-neutral-400">
          <button
            type="button"
            title={props.collapsed ? 'Expand list' : 'Collapse list'}
            class="rounded-md px-1 hover:text-neutral-700 dark:hover:text-neutral-200"
            onClick={props.onToggleCollapse}
          >
            {props.collapsed ? '▸' : '▾'}
          </button>
          <span class="rounded-full bg-neutral-200/80 px-1.5 py-0.5 font-medium dark:bg-neutral-800">
            {props.cards.length}
          </span>
          <Show
            when={!confirming()}
            fallback={
              <button
                type="button"
                class="rounded-md bg-red-100 px-1.5 py-0.5 text-red-600 dark:bg-red-950 dark:text-red-400"
                onClick={() => props.onRemove()}
              >
                Sure?
              </button>
            }
          >
            <Show when={props.canEdit}>
              <button
                type="button"
                title="Delete list"
                class="rounded-md px-1 hover:text-red-500"
                onClick={() => setConfirming(true)}
              >
                ×
              </button>
            </Show>
          </Show>
        </div>
      </header>

      <Show when={!props.collapsed}>
      <div class="flex flex-1 flex-col gap-2 overflow-y-auto p-2.5">
        <For each={props.cards}>
          {(card, index) => (
            <>
              <Show when={props.dropHint === index() && props.dragging !== card.id}>
                <div class="h-1 rounded-full bg-indigo-500/60" />
              </Show>
              <article
                data-card
                data-card-id={card.id}
                draggable={props.canEdit ? 'true' : undefined}
                onDragStart={(event) => {
                  if (!props.canEdit) return;
                  const transfer = event.dataTransfer;
                  if (transfer) {
                    transfer.effectAllowed = 'move';
                    transfer.setData('text/plain', card.id);
                  }
                  props.onDragStart(card.id);
                }}
                onDragEnd={props.onDragEnd}
                onClick={() => props.onOpenCard(card.id, card.client_op)}
                class={[
                  'group relative cursor-pointer rounded-xl border border-neutral-200/80 bg-white p-3 text-sm shadow-xs transition hover:border-indigo-300 hover:shadow-sm active:cursor-grabbing dark:border-neutral-700/80 dark:bg-neutral-900 dark:hover:border-indigo-700',
                  { 'opacity-40': props.dragging === card.id },
                  { 'ring-2 ring-amber-400': props.remoteDrag?.cardId === card.id },
                ]}
              >
                <Show when={props.remoteDrag?.cardId === card.id}>
                  <span class="absolute -top-2 left-2 rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-semibold text-amber-950">
                    {props.remoteDrag!.name} moving…
                  </span>
                </Show>
                <p class="pr-5">{card.title}</p>
                {/* Assignment at a glance: priority, tags, assignee avatar. */}
                <div class="mt-1 flex flex-wrap items-center gap-1">
                  <Show when={card.priority}>
                    {(priority) => <PriorityPill priority={priority()} />}
                  </Show>
                  <For each={card.tags.slice(0, 3)}>
                    {(tag) => (
                      <span class="rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
                        #{tag.name}
                      </span>
                    )}
                  </For>
                  <span class="flex -space-x-1.5">
                    <For each={card.assignees.slice(0, 4)}>
                      {(userId) => {
                        const member = () => props.members.find((m) => m.user_id === userId);
                        return (
                          <span
                            class="rounded-full ring-1 ring-white dark:ring-neutral-900"
                            title={`Assigned to ${member()?.display_name ?? userId}`}
                          >
                            <Avatar
                              src={member()?.avatar_url}
                              name={member()?.display_name}
                              email={member()?.email}
                              size="sm"
                            />
                          </span>
                        );
                      }}
                    </For>
                    <Show when={card.assignees.length > 4}>
                      <span class="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-200 text-[10px] font-semibold text-neutral-600 ring-1 ring-white dark:bg-neutral-700 dark:text-neutral-200 dark:ring-neutral-900">
                        +{card.assignees.length - 4}
                      </span>
                    </Show>
                  </span>                </div>
                <Show when={card.description}>
                  <button
                    type="button"
                    class="mt-1 text-[11px] font-medium text-neutral-400 hover:text-indigo-500 dark:hover:text-indigo-400"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onOpenCard(card.id, card.client_op);
                    }}
                  >
                    ☰ Details
                  </button>
                </Show>
                <Show when={unseenCount(card) > 0}>
                  <span
                    title="New comments — open the card to clear"
                    class="mt-1.5 inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                  >
                    💬 {unseenCount(card)} new
                  </span>
                </Show>
                <Show when={props.canEdit}>
                  <button
                    type="button"
                    title="Delete card"
                    class="absolute right-2 top-2 hidden rounded px-1 text-neutral-300 hover:text-red-500 group-hover:block dark:text-neutral-600"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onRemoveCard(card.id);
                    }}
                  >
                    ×
                  </button>
                </Show>
              </article>
            </>
          )}
        </For>
        <Show when={props.dropHint === props.cards.length && props.cards.length > 0}>
          <div class="h-1 rounded-full bg-indigo-500/60" />
        </Show>

        {/* Add-card (editors only): the input ALWAYS clears instantly on
            submit (the card appears immediately via the engine) — optionally
            stays open for the next card ("add another"), never blocked by
            the server. Viewers see no editing surface at all. */}
        <Show when={props.canEdit}>
          <Show
            when={props.adding || keepOpen()}
            fallback={
              <button
                type="button"
                class="rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                onClick={() => {
                  setKeepOpen(true);
                  props.onAdd();
                }}
              >
                + Add card
              </button>
            }
          >
          <form
            class="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const title = String(new FormData(form).get('title') ?? '').trim();
              if (title) {
                props.onSubmitAdd(title);
                if (keepOpen()) {
                  form.reset();
                  form.querySelector('textarea')?.focus();
                }
              }
            }}
          >
            <textarea name="title" rows={2} placeholder="Card title…" autofocus />
            <div class="flex items-center gap-2">
              <button
                type="submit"
                class="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                Add
              </button>
              <Show
                when={keepOpen()}
                fallback={
                  <button
                    type="button"
                    class="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                    title="Keep the form open to add several cards"
                    onClick={() => setKeepOpen(true)}
                  >
                    Add another ↵
                  </button>
                }
              >
                <button
                  type="button"
                  class="text-xs font-medium text-indigo-600 dark:text-indigo-400"
                  title="Close the form"
                  onClick={() => {
                    setKeepOpen(false);
                    props.onCancelAdd();
                  }}
                >
                  Done
                </button>
              </Show>
            </div>
          </form>
          </Show>
        </Show>
      </div>
      </Show>
    </section>
  );
}

function AddList(props: { onAdd: (name: string) => void }) {
  const [open, setOpen] = createSignal(false);
  return (
    <Show
      when={open()}
      fallback={
        <button
          type="button"
          class="h-10 w-72 shrink-0 rounded-2xl border border-dashed border-neutral-300 text-sm font-medium text-neutral-500 hover:border-neutral-400 hover:bg-neutral-100/60 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:bg-neutral-900/70"
          onClick={() => setOpen(true)}
        >
          + Add list
        </button>
      }
    >
      <form
        class="flex w-72 shrink-0 flex-col gap-2 rounded-2xl border border-neutral-200/80 bg-neutral-100/60 p-3 dark:border-neutral-800 dark:bg-neutral-900/70"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const name = String(new FormData(form).get('name') ?? '').trim();
          if (name) props.onAdd(name);
          form.reset();
          setOpen(false);
        }}
      >
        <input name="name" placeholder="List name…" autofocus />
        <div class="flex gap-2">
          <button
            type="submit"
            class="rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
          >
            Add list
          </button>
          <button
            type="button"
            class="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
        </div>
      </form>
    </Show>
  );
}

/**
 * The card detail drawer — the GitHub-PR experience at card scale: markdown
 * description with preview/edit, #number citations that open cards, and
 * LIVE comments (a small engine over the card's comment stream; new
 * comments arrive by relay instantly and by echo durably, whoever wrote
 * them). Opening a card marks its comments seen.
 */
/** The mentionable handle for a member: username, first name, or email
 *  handle — the exact string @autocomplete inserts and chips validate. */
function mentionNameOf(member: Member): string {
  return member.display_name?.split(/\s+/)[0] ?? member.email?.split('@')[0] ?? 'member';
}

/** A textarea that knows the board: typing `@` offers members, `#` offers
 *  cards (number + title) — Slack-style. Selecting inserts the real token,
 *  so every rendered @/# is an actual reference. */
/** A textarea that knows the board and LOOKS like Slack:
 *  - typing `@` offers members, `#` offers cards; picking inserts the
 *    real reference (`@[Name](user:id)` / `#N`) — but the box shows a
 *    clean chip instead of the raw markdown (a synced backdrop renders
 *    the highlight while the textarea's own text stays transparent);
 *  - `sendOnEnter` gives comment boxes Enter-to-send (Shift+Enter
 *    newlines; the dropdown's Enter always picks the highlighted item).
 */
/**
 * The mention composer — Slack/Trello-style: a contenteditable box whose
 * @mentions, #citations, #tags, and cross-board references are REAL
 * chips (non-editable inline nodes). One Backspace removes a whole chip
 * (the browser treats it as a single unit), the raw markdown is never
 * visible while typing, and the serialized markdown travels in
 * props.value/onInput exactly as before.
 */
function SmartTextarea(props: {
  value: string;
  onInput: (value: string) => void;
  members: Member[];
  /** Teams appear in the @ menu too (mentioning one notifies every member). */
  teams: TeamView[];
  cards: CardView[];
  /** The workspace's tag vocabulary (# in the box offers these too). */
  workspaceTags: { id: string; name: string }[];
  /** Every card the viewer can see across boards (# offers cross-board refs). */
  crossCards: CrossCard[];
  placeholder?: string;
  rows?: number;
  class?: string;
  /** Enter posts (comments); descriptions keep Enter as newline. */
  sendOnEnter?: boolean;
  onSend?: () => void;
}) {
  type Menu = { kind: 'at' | 'hash'; query: string; textNode: Text; offset: number };
  const [menu, setMenu] = createSignal<Menu | null>(null);
  const [active, setActive] = createSignal(0);
  /** Open upward when the composer sits low on screen. */
  const [flip, setFlip] = createSignal(false);
  let root: HTMLDivElement | undefined;
  /** Escape latches the menu shut for this trigger until it's re-typed. */
  let dismissedStart = -1;

  // ── serialization: chips + text → markdown ─────────────────────────
  const serialize = (): string => {
    if (!root) return props.value;
    const out: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out.push(node.textContent ?? '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      if (el.tagName === 'BR') {
        out.push('\n');
        return;
      }
      const mention = el.getAttribute('data-mention');
      if (mention) {
        const label = (el.textContent ?? '').replace(/^@/, '');
        const [kind, id] = mention.split(':');
        out.push(`[${label}](${kind}:${id})`);
        return;
      }
      if (el.hasAttribute('data-cite')) {
        out.push(`#${el.getAttribute('data-cite')}`);
        return;
      }
      const tag = el.getAttribute('data-tag');
      if (tag) {
        out.push(`[#${el.textContent?.replace(/^#/, '')}](tag:${tag})`);
        return;
      }
      const cross = el.getAttribute('data-cross');
      if (cross) {
        out.push(`[${el.textContent}](card:${cross})`);
        return;
      }
      for (const child of el.childNodes) walk(child);
    };
    for (const child of root.childNodes) walk(child);
    return out.join('');
  };

  // ── external value → chips (the parent clears or seeds the draft) ───
  const renderValue = (value: string) => {
    if (!root) return;
    root.textContent = '';
    const pattern = /\[([^\]\n]+)\]\((user|team|tag|card|all):([0-9a-f-]{36}|everyone)\)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    const appendText = (text: string) => {
      if (!text) return;
      root.appendChild(document.createTextNode(text));
    };
    while ((match = pattern.exec(value)) !== null) {
      appendText(value.slice(last, match.index));
      const kind = match[2];
      const id = match[3];
      const chip = document.createElement('span');
      chip.contentEditable = 'false';
      chip.className =
        kind === 'user' || kind === 'team' || kind === 'all'
          ? kind === 'all'
            ? 'fd-chip fd-chip-all'
            : 'fd-chip fd-chip-user'
          : kind === 'tag'
            ? 'fd-chip fd-chip-tag'
            : 'fd-chip fd-chip-card';
      if (kind === 'user' || kind === 'team' || kind === 'all') chip.setAttribute('data-mention', `${kind}:${id}`);
      else if (kind === 'tag') chip.setAttribute('data-tag', id);
      else chip.setAttribute('data-cross', id);
      chip.textContent = `${kind === 'tag' ? '#' : kind === 'card' ? '' : '@'}${match[1]}`;
      root.appendChild(chip);
      last = pattern.lastIndex;
    }
    appendText(value.slice(last));
  };

  // Sync when the parent's value changes from OUTSIDE (posting clears
  // the draft). While the composer holds the caret, the DOM is the truth.
  createEffect(
    () => props.value,
    (value) => {
      if (!root) return;
      // While typing, the DOM is the truth — except a parent CLEAR (the
      // value going empty), which always wins: the box must reset after
      // a send even though it still holds the caret.
      if (document.activeElement === root && value !== '') return;
      if (serialize() === value) return;
      renderValue(value ?? '');
    },
  );
  onSettled(() => {
    if (root && !root.textContent && props.value) renderValue(props.value);
  });

  // ── the @ / # menu ─────────────────────────────────────────────────
  type Option = { key: string; label: string; hint?: string; chip: HTMLElement };
  const makeChip = (className: string, attr: [string, string] | null, cite: string | null, label: string): HTMLElement => {
    const chip = document.createElement('span');
    chip.contentEditable = 'false';
    chip.className = className;
    if (attr) chip.setAttribute(attr[0], attr[1]);
    if (cite) chip.setAttribute('data-cite', cite);
    chip.textContent = label;
    return chip;
  };

  const options = (): Option[] => {
    const m = menu();
    if (!m) return [];
    if (m.kind === 'at') {
      const q = m.query.toLowerCase();
      const people = props.members
        .filter((member) => {
          const haystack = `${member.display_name ?? ''} ${member.email ?? ''}`.toLowerCase();
          return haystack.includes(q);
        })
        .slice(0, 6)
        .map((member) => {
          const label = (member.display_name ?? member.email ?? 'member').replace(/[\]\(\[]/g, '');
          return {
            key: member.user_id,
            label,
            hint: member.email ?? undefined,
            chip: makeChip('fd-chip fd-chip-user', ['data-mention', `user:${member.user_id}`], null, `@${label}`),
          };
        });
      // @all — Slack's @channel: everyone who can see this board, at
      // direct-mention volume ('none' still silences it).
      const all =
        'all'.includes(q) || q === ''
          ? [
              {
                key: 'all:everyone',
                label: 'All',
                hint: `notifies everyone with access (${props.members.length})`,
                chip: makeChip('fd-chip fd-chip-all', ['data-mention', 'all:everyone'], null, '@All'),
              },
            ]
          : [];
      const teams = props.teams
        .filter((team) => !q || team.name.toLowerCase().includes(q))
        .slice(0, 3)
        .map((team) => {
          const label = team.name.replace(/[\]\(\[]/g, '');
          return {
            key: `team:${team.id}`,
            label: `${label} · team`,
            hint: `notifies ${team.members.length} member${team.members.length === 1 ? '' : 's'}`,
            chip: makeChip('fd-chip fd-chip-user', ['data-mention', `team:${team.id}`], null, `@${label}`),
          };
        });
      return [...all, ...people, ...teams];
    }
    const q = m.query.toLowerCase();
    const current = props.cards
      .filter((card) => card.number !== null)
      .filter((card) => !q || String(card.number) === m.query || card.title.toLowerCase().includes(q))
      .slice(0, 4)
      .map((card) => ({
        key: `c:${card.id}`,
        label: `#${card.number}`,
        hint: card.title,
        chip: makeChip('fd-chip fd-chip-card', null, String(card.number), `#${card.number}`),
      }));
    const tags = props.workspaceTags
      .filter((tag) => !q || tag.name.includes(q))
      .slice(0, 3)
      .map((tag) => ({
        key: `t:${tag.id}`,
        label: `#${tag.name}`,
        hint: 'tag — links to search',
        chip: makeChip('fd-chip fd-chip-tag', ['data-tag', tag.id], null, `#${tag.name}`),
      }));
    const cross = props.crossCards
      .filter(
        (card) =>
          card.board_id !== props.cards[0]?.board_id &&
          (!q || String(card.number) === m.query || card.title.toLowerCase().includes(q) || card.board_name.toLowerCase().includes(q)),
      )
      .slice(0, 5)
      .map((card) => ({
        key: `x:${card.id}`,
        label: `${card.board_name} #${card.number}`,
        hint: card.title,
        chip: makeChip('fd-chip fd-chip-card', ['data-cross', card.id], null, `${card.board_name} #${card.number}`),
      }));
    return [...current, ...tags, ...cross];
  };

  /** The caret's text node + offset, when it sits in plain text. */
  const caretContext = (): { node: Text; offset: number } | null => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const anchor = selection.anchorNode;
    if (!anchor || anchor.nodeType !== Node.TEXT_NODE || !root?.contains(anchor)) return null;
    return { node: anchor as Text, offset: selection.anchorOffset ?? 0 };
  };

  const detect = () => {
    const caret = caretContext();
    if (!caret) {
      setMenu(null);
      return;
    }
    const before = caret.node.textContent?.slice(0, caret.offset) ?? '';
    const at = before.lastIndexOf('@');
    const hash = before.lastIndexOf('#');
    const start = Math.max(at, hash);
    if (start < 0) {
      setMenu(null);
      return;
    }
    // Slack-style: the query is EVERYTHING since the trigger — spaces
    // included ("@john sm…" keeps searching), and a new @/# ends it.
    const between = before.slice(start + 1);
    if (between.includes('@') || between.includes('#') || /[\n]$/.test(between)) {
      setMenu(null);
      return;
    }
    if (start === dismissedStart && !between) {
      setMenu(null);
      return;
    }
    if (start !== dismissedStart) dismissedStart = -1;
    // Flip the menu up when the composer is low on the screen.
    if (root) {
      const rect = root.getBoundingClientRect();
      setFlip(rect.bottom + 240 > window.innerHeight);
    }
    setMenu({
      kind: at > hash ? 'at' : 'hash',
      query: between,
      textNode: caret.node,
      offset: start,
    });
    setActive(0);
  };

  /** Insert the picked chip at the caret, removing the typed @query. */
  const insertOption = (option: Option) => {
    const m = menu();
    if (!m || !root) return;
    const selection = window.getSelection();
    const caret = caretContext();
    // Remove the typed trigger + query (spaces included).
    if (caret && caret.node === m.textNode) {
      m.textNode.deleteData(m.offset, caret.offset - m.offset);
    } else if (m.textNode.isConnected) {
      m.textNode.deleteData(m.offset, m.textNode.length - m.offset);
    }
    const range = document.createRange();
    const anchor: Node = caret && root.contains(caret.node) ? caret.node : root;
    const pos = anchor.nodeType === Node.TEXT_NODE ? m.offset : anchor.childNodes.length;
    range.setStart(anchor, Math.min(pos, anchor.nodeType === Node.TEXT_NODE ? (anchor as Text).length : anchor.childNodes.length));
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    range.insertNode(option.chip);
    // A trailing space to type after; the caret lands behind it.
    const space = document.createTextNode(' ');
    option.chip.after(space);
    const after = document.createRange();
    after.setStart(space, 1);
    after.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(after);
    setMenu(null);
    root.focus();
    props.onInput(serialize());
  };

  const send = () => {
    props.onSend?.();
    queueMicrotask(() => root?.focus());
  };

  return (
    <div class={`relative ${props.class ?? ''}`}>
      <div
        ref={root}
        data-placeholder={props.placeholder ?? ''}
        contenteditable="true"
        role="textbox"
        class="fd-composer w-full whitespace-pre-wrap break-words rounded-xl border border-neutral-200 bg-transparent px-3 py-2 text-sm leading-6 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 dark:border-neutral-700"
        style={{ 'min-height': `${(props.rows ?? 3) * 1.5}rem` }}
        onInput={() => {
          props.onInput(serialize());
          detect();
        }}
        onKeyDown={(event) => {
          const list = options();
          if (menu() && list.length > 0) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((active() + 1) % list.length);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((active() - 1 + list.length) % list.length);
            } else if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              event.stopPropagation();
              insertOption(list[active()]);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              dismissedStart = menu()?.offset ?? -1;
              setMenu(null);
            }
            return;
          }
          if (event.key === 'Escape') {
            if (menu()) event.stopPropagation();
            return;
          }
          if (event.key === 'Enter') {
            if (event.metaKey || event.ctrlKey) {
              event.preventDefault();
              send();
              return;
            }
            if (props.sendOnEnter && !event.shiftKey) {
              event.preventDefault();
              send();
            }
            // otherwise: Enter is a newline (descriptions) — default.
          }
        }}
        onBlur={() => setMenu(null)}
        // Paste is plain text — chips only come from the menus.
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData?.getData('text/plain') ?? '';
          if (!text) return;
          const selection = window.getSelection();
          selection?.deleteFromDocument();
          document.execCommand('insertText', false, text);
          props.onInput(serialize());
        }}
        onFocus={() => detect()}
        onClick={() => detect()}
      />
      <Show when={menu() && options().length > 0}>
        <div
          class={`absolute left-0 z-40 max-h-44 w-64 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900 ${
            flip() ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          <For each={options()}>
            {(option, index) => (
              <button
                type="button"
                class={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                  index() === active()
                    ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                    : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertOption(option);
                }}
              >
                <span class="min-w-0 flex-1 truncate">{option.label}</span>
                <span class="shrink-0 truncate text-[10px] text-neutral-400">{option.hint}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function DetailHoverCard(props: {
  hover: { kind: 'user' | 'card' | 'tag' | 'team'; id: string; rect: DOMRect } | null;
  members: Member[];
  cards: CardView[];
  lists: ListRow[];
  crossCards: CrossCard[];
  workspaceTags: { id: string; name: string }[];
  teams: TeamView[];
  onOpenCard: (cardId: string, clientOp: string | null) => void;
}) {
  // Position: below-left of the target; when space runs short, anchor to
  // the viewport BOTTOM above the target (no guessed heights — the card
  // grows upward from the anchor edge).
  const position = () => {
    const h = props.hover;
    if (!h) return { left: '-9999px', top: '0px' } as const;
    const left = Math.min(Math.max(8, h.rect.left), Math.max(8, window.innerWidth - 288));
    if (h.rect.bottom + 240 <= window.innerHeight) {
      return { left: `${left}px`, top: `${h.rect.bottom + 8}px` } as const;
    }
    // Flip up: anchor the card's BOTTOM above the target.
    const bottom = Math.max(8, window.innerHeight - h.rect.top + 8);
    return { left: `${left}px`, bottom: `${bottom}px` } as const;
  };

  const member = () => props.members.find((m) => m.user_id === props.hover?.id);
  // The hovered user's live status (fetched per hover — statuses are
  // slow-moving; a fresh fetch per hover stays cheap).
  const [status, setStatus] = createSignal<PublicStatus | null>(null);
  createEffect(
    () => (props.hover?.kind === 'user' ? props.hover.id : null),
    (userId) => {
      setStatus(null);
      if (userId) void statusOf(userId).then(setStatus).catch(() => {});
    },
  );
  const crossCard = () => props.crossCards.find((c) => c.id === props.hover?.id);
  const card = () =>
    props.cards.find(
      (c) => c.number === Number(props.hover?.id) || c.id === props.hover?.id,
    );
  const tag = () => props.workspaceTags.find((t) => t.id === props.hover?.id);
  const list = () => props.lists.find((l) => l.id === card()?.list_id);
  const team = () => props.teams.find((t) => t.id === props.hover?.id);

  return (
    <Show when={props.hover}>
      <div
        class="pointer-events-none fixed z-[60] w-72 rounded-xl border border-neutral-200 bg-white p-3 text-left shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
        style={position()}
      >
        <Show
          when={props.hover!.kind === 'user' && member()}
          fallback={
            <Show
              when={props.hover!.kind === 'tag' && tag()}
              fallback={
                <Show
                  when={props.hover!.kind === 'card' && crossCard()}
                  fallback={
                    <Show when={card()} fallback={
                      <Show when={team()} fallback={<p class="text-xs text-neutral-400">Unknown reference</p>}>
                        {(t) => (
                          <>
                            <div class="flex items-center gap-2">
                              <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-sm dark:bg-emerald-500/15">
                                👥
                              </span>
                              <div class="min-w-0">
                                <p class="truncate text-sm font-semibold">{t().name}</p>
                                <p class="text-[10px] font-medium uppercase tracking-wider text-neutral-400">
                                  Team · {t().members.length} member{t().members.length === 1 ? '' : 's'}
                                </p>
                              </div>
                            </div>
                            <Show when={t().description}>
                              <p class="mt-2 line-clamp-3 text-xs text-neutral-500 dark:text-neutral-400">
                                {t().description}
                              </p>
                            </Show>
                            <Show when={t().members.length > 0}>
                              <div class="mt-2 flex items-center gap-1.5">
                                <span class="flex -space-x-1.5">
                                  <For each={t().members.slice(0, 6)}>
                                    {(entry) => {
                                      const person = () => props.members.find((m) => m.user_id === entry.user_id);
                                      return (
                                        <span class="rounded-full ring-2 ring-white dark:ring-neutral-900">
                                          <Avatar src={person()?.avatar_url} name={person()?.display_name} email={person()?.email} size="xs" />
                                        </span>
                                      );
                                    }}
                                  </For>
                                </span>
                                <Show when={t().members.length > 6}>
                                  <span class="text-[10px] text-neutral-400">+{t().members.length - 6}</span>
                                </Show>
                              </div>
                            </Show>
                            <p class="mt-2 text-[10px] text-neutral-400">Click to open the team page</p>
                          </>
                        )}
                      </Show>
                    }>
                      {(target) => (
                        <>
                          <div class="flex items-start gap-2">
                            <span class="rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                              #{target().number}
                            </span>
                            <p class="min-w-0 flex-1 break-words text-sm font-semibold">
                              {target().title}
                            </p>
                          </div>
                          <p class="mt-1 text-xs text-neutral-400">
                            in <span class="font-medium text-neutral-500 dark:text-neutral-300">{list()?.name ?? '…'}</span>
                            <Show when={target().priority}> · {target().priority}</Show>
                          </p>
                          <Show when={(target().assignees ?? []).length > 0}>
                            <div class="mt-2 flex items-center gap-1.5">
                              <span class="flex -space-x-1.5">
                                <For each={target().assignees}>
                                  {(userId) => {
                                    const person = () => props.members.find((m) => m.user_id === userId);
                                    return <Avatar src={person()?.avatar_url} name={person()?.display_name} email={person()?.email} size="sm" />;
                                  }}
                                </For>
                              </span>
                              <span class="text-xs text-neutral-400">
                                {target().assignees.length} assigned
                              </span>
                            </div>
                          </Show>
                          <Show when={(target().tags ?? []).length > 0}>
                            <div class="mt-2 flex flex-wrap gap-1">
                              <For each={target().tags}>
                                {(cardTag) => (
                                  <span class="rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
                                    #{cardTag.name}
                                  </span>
                                )}
                              </For>
                            </div>
                          </Show>
                          <p class="mt-2 text-[10px] text-neutral-400">Click to open this card</p>
                        </>
                      )}
                    </Show>
                  }
                >
                  {(cross) => (
                    <>
                      <p class="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                        {cross().board_name}
                      </p>
                      <div class="mt-1 flex items-start gap-2">
                        <span class="rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                          #{cross().number}
                        </span>
                        <p class="min-w-0 flex-1 break-words text-sm font-semibold">
                          {cross().title}
                        </p>
                      </div>
                      <p class="mt-2 text-[10px] text-neutral-400">Click to open it on its board</p>
                    </>
                  )}
                </Show>
              }
            >
              {(t) => (
                <>
                  <p class="text-sm font-semibold text-sky-700 dark:text-sky-300">#{t().name}</p>
                  <p class="mt-1 text-xs text-neutral-400">
                    A tag shared across this workspace's cards.
                  </p>
                  <p class="mt-2 text-[10px] text-neutral-400">Click to search cards with this tag</p>
                </>
              )}
            </Show>
          }
        >
          {(person) => (
            <div class="flex items-center gap-2.5">
              <Avatar src={person().avatar_url} name={person().display_name} email={person().email} size="md" />
              <div class="min-w-0">
                <p class="truncate text-sm font-semibold">{person().display_name ?? person().email}</p>
                <Show when={person().username}>
                  <p class="truncate text-xs text-neutral-400">@{person().username}</p>
                </Show>
                <Show when={person().email}>
                  <p class="truncate text-xs text-neutral-400">{person().email}</p>
                </Show>
                <Show when={status()}>
                  {(current) => (
                    <p class="mt-0.5 truncate text-xs font-medium text-indigo-600 dark:text-indigo-400">
                      {current().emoji ?? ''} {current().label ?? ''}
                      {current().dnd ? ' · 🔕 do not disturb' : ''}
                    </p>
                  )}
                </Show>
                <p class="mt-0.5 text-[10px] text-neutral-400">{person().role} of this workspace</p>
              </div>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}

/** The floating detail card over @mentions and #citations.

/** The tag input: chips backed by the workspace's shared vocabulary.
 *  Existing tags autocomplete by name; a NEW name opens a tiny inline
 *  form that takes a description with it (the "what is this tag for"
 *  the vocabulary deserves) — then it's created and attached. */
function TagInput(props: {
  workspaceTags: { id: string; name: string; description?: string }[];
  workspaceId: string;
  onAdd: (tag: { id: string; name: string }) => void;
}) {
  const [draft, setDraft] = createSignal('');
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [creating, setCreating] = createSignal<string | null>(null);
  const [description, setDescription] = createSignal('');
  let root: HTMLDivElement | undefined;

  const suggestions = () => {
    const q = draft().trim().toLowerCase().replace(/^#/, '');
    return props.workspaceTags
      .filter((tag) => !q || tag.name.includes(q))
      .slice(0, 5);
  };
  /** Does the typed name already exist? (then no create flow needed) */
  const exists = () => {
    const clean = draft().trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
    return clean !== '' && props.workspaceTags.some((tag) => tag.name === clean);
  };
  /** Open the create-with-description form for the typed name. */
  const openCreate = () => {
    const clean = draft().trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').slice(0, 24);
    if (!clean) return;
    setCreating(clean);
    setDescription('');
  };

  const add = async (name: string) => {
    const clean = name.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').slice(0, 24);
    if (!clean || busy()) return;
    setBusy(true);
    try {
      const existing = props.workspaceTags.find((tag) => tag.name === clean);
      const tag = existing ?? (await findOrCreateTag(props.workspaceId, clean, description()));
      props.onAdd(tag);
      setDraft('');
      setOpen(false);
      setCreating(null);
      setDescription('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="relative" onClick={(event) => event.stopPropagation()}>
      <input
        class="w-28 rounded-full border border-dashed border-neutral-300 bg-transparent px-2 py-0.5 text-[11px] dark:border-neutral-700"
        placeholder="+ tag…"
        value={draft()}
        onInput={(event) => {
          setDraft(event.currentTarget.value);
          setCreating(null);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          // Focus moving INTO the dropdown (the create form's description
          // input) must keep it open — the old timer closed it out from
          // under the typist.
          if (root?.contains(event.relatedTarget as Node | null)) return;
          setTimeout(() => {
            setOpen(false);
            setCreating(null);
          }, 150);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            const first = suggestions()[0];
            if (first && draft().trim() !== '' && !creating()) void add(first.name);
            else if (draft().trim() !== '' && !creating()) openCreate();
          }
          if (event.key === 'Escape') setOpen(false);
        }}
      />
      <Show when={open() && draft().trim() !== ''}>
        <div ref={root} class="absolute left-0 top-full z-30 mt-1 w-56 rounded-xl border border-neutral-200 bg-white p-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
          <For each={suggestions()}>
            {(tag) => (
              <button
                type="button"
                class="block w-full rounded-lg px-2 py-1 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                onMouseDown={(event) => {
                  event.preventDefault();
                  void add(tag.name);
                }}
              >
                #{tag.name}
                <Show when={tag.description}>
                  <span class="ml-1 text-[10px] text-neutral-400">— {tag.description}</span>
                </Show>
              </button>
            )}
          </For>
          <Show
            when={!exists() && !creating()}
            fallback={
              <Show when={creating()}>
                <form
                  class="space-y-1.5 border-t border-neutral-100 p-1.5 dark:border-neutral-800"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void add(creating()!);
                  }}
                >
                  <p class="text-[11px] font-semibold text-neutral-500 dark:text-neutral-300">
                    New tag #{creating()}
                  </p>
                  <input
                    class="w-full text-xs"
                    placeholder="What is this tag for? (optional)"
                    value={description()}
                    onInput={(event) => setDescription(event.currentTarget.value)}
                    autofocus
                  />
                  <div class="flex gap-2">
                    <button
                      type="submit"
                      disabled={busy()}
                      class="rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {busy() ? 'Creating…' : 'Create & add'}
                    </button>
                    <button
                      type="button"
                      class="text-[11px] font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                      onClick={() => setCreating(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </Show>
            }
          >
            <button
              type="button"
              class="mt-0.5 block w-full rounded-lg px-2 py-1 text-left text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950"
              onMouseDown={(event) => {
                event.preventDefault();
                openCreate();
              }}
            >
              + Create “{draft().trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-')}”
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function CardDrawer(props: {
  cardId: string;
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
  canEdit: boolean;
  /** The board's name — citation chips read "Board #12". */
  boardName: string;
  /** May editors grant board access themselves (the board's setting)? */
  accessDelegation: boolean;
  /** Workspace owners/admins can always grant — the panel adapts. */
  isWsAdmin: boolean;
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
  /** Deletes the card with this (swap-resolved) id. */
  onDelete: (cardId: string) => void;
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
  onHover: (target: { kind: 'user' | 'card' | 'tag' | 'team'; id: string; rect: DOMRect } | null) => void;
  /** The shared panel width helper (resize handle + width style). */
  panelWidth: { width: () => number | null; dragging: () => boolean; startDrag: (event: MouseEvent) => void };
  /** A cross-board reference was clicked — route to that board's card. */
  onOpenCrossCard: (cardId: string) => void;
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
    // Org-wide numbers (#N is unique across the workspace now): the union
    // of this board's cards and every card reachable cross-board.
    cardNumbers: [
      ...props.cards
        .map((c) => c.number)
        .filter((number): number is number => number !== null),
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
  createEffect(() => card()?.title, (title) => {
    if (title !== undefined && !titleDraft()) setTitleDraft(title);
  });

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
    const oldest = list[0]?.created_at;
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
  // Events are slow-moving (a trail, not a chat): fetch on settings-tab
  // open and poll gently while it's open — no live connection needed.
  const [events, setEvents] = createSignal<CardEventRow[]>([]);
  createEffect(
    // Only the SETTINGS tab polls; other tabs and the closed drawer hold
    // nothing open.
    () => (tab() === 'settings' ? cardIdNow() : ''),
    (id) => {
      if (!id) {
        setEvents([]);
        return;
      }
      let alive = true;
      const load = async () => {
        try {
          const rows = await getCardEvents(id);
          if (alive) setEvents(rows);
        } catch {
          // the timeline is best-effort decoration
        }
      };
      void load();
      const timer = setInterval(() => void load(), 10_000);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    },
  );
  /** The actor's display name — the workspace roster first (members can
   *  vanish; the trail must keep naming them), falling back gracefully. */
  const actorName = (actorId: string | null) => {
    if (!actorId) return 'Someone';
    const member = props.members.find((entry) => entry.user_id === actorId);
    return member?.display_name ?? member?.email?.split('@')[0] ?? 'Someone';
  };
  const eventLine = (row: CardEventRow): string => {
    const detail = row.detail ?? {};
    const added = (detail.added as string[] | undefined) ?? [];
    const removed = (detail.removed as string[] | undefined) ?? [];
    switch (row.kind) {
      case 'created':
        return 'created this card';
      case 'moved':
        return `moved this from ${String(detail.from ?? 'a list')} to ${String(detail.to ?? 'a list')}`;
      case 'renamed':
        return `renamed this from “${String(detail.from ?? '')}” to “${String(detail.to ?? '')}”`;
      case 'priority': {
        const to = detail.to as string | null | undefined;
        return to ? `set priority to ${to}` : 'cleared the priority';
      }
      case 'tags': {
        const parts: string[] = [];
        if (added.length > 0) parts.push(`added ${added.map((name) => `#${name}`).join(', ')}`);
        if (removed.length > 0)
          parts.push(`removed ${removed.map((name) => `#${name}`).join(', ')}`);
        return parts.join(' · ') || 'changed tags';
      }
      case 'assignees': {
        const parts: string[] = [];
        if (added.length > 0) parts.push(`assigned ${added.join(', ')}`);
        if (removed.length > 0) parts.push(`unassigned ${removed.join(', ')}`);
        return parts.join(' · ') || 'changed assignees';
      }
      case 'description':
        return 'updated the description';
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
  const commentsLive = liveQuery(cardCommentsStream, 'comments');
  const commentsEngine = createEngine<CommentsSnapshot>({
    streamSource: (key) =>
      (async function* (): AsyncGenerator<CommentsSnapshot> {
        // The card's client_op rides along: the server resolves a
        // mid-provisional (temp) key to the durable card before binding.
        for await (const list of await commentsLive(key, props.clientOp ?? null)) {
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
      ].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
      if (draft.list.length !== merged.length || draft.list.some((row, i) => row !== merged[i])) {
        draft.list = merged;
      }
    },
    status: () => commentsLive.status(cardIdNow()),
    refresh: async () => ({ list: await getCardComments(cardIdNow(), props.clientOp ?? null) }),
  });

  const comments = () => dedup([...older(), ...commentsEngine.view().list]);

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
                client_op: payload.clientOp,
              });
              draft.list = [...draft.list].sort(
                (a, b) => +new Date(a.created_at) - +new Date(b.created_at),
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
  const blockedNames = () => blocked().map((person) => person.name).join(', ');
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
          `Access granted — ${blockedTeams().map((team) => `@${team.name}`).join(', ')} can now see this board and just got your mention.`,
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
      setAccessNote(error instanceof Error ? error.message : 'Could not grant access');
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
      showAccessNote(error instanceof Error ? error.message : 'Could not ask the admins');
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
        `Access granted — ${blockedTeams().map((team) => `@${team.name}`).join(', ')} can now see this board and just got your mention.`,
      );
      setBlockedTeams([]);
    } catch (error) {
      showAccessNote(error instanceof Error ? error.message : 'Could not grant access');
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
          client_op: payload.clientOp,
        });
        draft.list = [...draft.list].sort(
          (a, b) => +new Date(a.created_at) - +new Date(b.created_at),
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
      props.onOpenCrossCard(cross.getAttribute('data-card-id') ?? '');
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
    const cardRef = around.getAttribute('data-card-ref') ?? around.getAttribute('data-card-id') ?? '';
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
          <div class="flex flex-1 items-baseline gap-2">
            <Show when={card()?.number}>
              {(num) => (
                <span class="rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  #{num()}
                </span>
              )}
            </Show>
            {/* The title is a plain label here — editing lives in the
                Settings tab. Reads the live store, so a rename by anyone
                (this device included) shows up instantly. */}
            <span
              class="min-w-0 flex-1 truncate text-lg font-semibold text-neutral-900 dark:text-white"
              title={card()?.title ?? ''}
            >
              {card()?.title ?? '…'}
            </span>
          </div>
          <button
            type="button"
            class="rounded-md px-2 py-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
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
                            <Avatar src={member()?.avatar_url} name={member()?.display_name} email={member()?.email} size="sm" />
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
                          <Avatar src={member()?.avatar_url} name={member()?.display_name} email={member()?.email} size="sm" />
                        </button>
                      </Show>
                    );
                  }}
                </For>
              </span>
              <Show when={props.canEdit}>
                <div data-assign-picker class="relative" onClick={(event) => event.stopPropagation()}>
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
                          const assigned = () => (card()?.assignees ?? []).includes(member.user_id);
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
                              <Avatar src={member.avatar_url} name={member.display_name} email={member.email} size="sm" />
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
                  <Show when={card()?.priority} fallback={<span class="text-xs text-neutral-400">None</span>}>
                    {(priority) => <PriorityPill priority={priority()} />}
                  </Show>
                }
              >
                <select
                  class="w-28 py-1 text-xs"
                  value={card()?.priority ?? ''}
                  onChange={(event) =>
                    props.onUpdate({ priority: (event.currentTarget.value || null) as string | null })
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
                  <span class="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
                    #{tag.name}
                    <Show when={props.canEdit}>
                      <button
                        type="button"
                        class="text-sky-400 hover:text-sky-700 dark:hover:text-sky-100"
                        title={`Remove #${tag.name}`}
                        onClick={() =>
                          props.onUpdate({ tags: (card()?.tags ?? []).filter((t) => t.id !== tag.id) })
                        }
                      >
                        ×
                      </button>
                    </Show>
                  </span>
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
              {' '}· {new Date(card()!.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
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
                  rows={8}
                  onSend={() => saveBody()}
                  placeholder={'Describe the task — **markdown**, image links, #12 references, @name mentions'}
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
                  Everything that happens to this card — moves, renames, tags, assignments —
                  lands here.
                </p>
              }
            >
              <ol class="flex flex-col gap-1 border-l border-neutral-200 pl-3 dark:border-neutral-700">
                <For each={events()}>
                  {(row) => (
                    <li class="relative text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                      <span class="absolute -left-[17px] top-1.5 h-1.5 w-1.5 rounded-full bg-neutral-300 dark:bg-neutral-600" />
                      <span class="font-medium text-neutral-700 dark:text-neutral-200">
                        {actorName(row.actor_id)}
                      </span>{' '}
                      {eventLine(row)}
                      <span class="ml-1 text-[10px] text-neutral-400">{timeAgo(row.created_at)}</span>
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
          <Show when={comments().length > 0} fallback={
            <p class="py-6 text-center text-xs text-neutral-400">
              No comments yet — mention cards as #12, people as @name, use markdown.
            </p>
          }>
            <ul class="flex flex-col gap-3 py-1">
              <For each={comments()}>
                {(comment) => {
                  const mine = () => comment.author_id !== null && comment.author_id === props.myId;
                  return (
                    <li class={`flex items-start gap-2 ${mine() ? 'flex-row-reverse' : ''}`}>
                      <Avatar src={comment.avatar_url} name={comment.author} size="sm" />
                      <div class={`min-w-0 max-w-[85%] ${mine() ? 'items-end text-right' : ''}`}>
                        <p class={`flex items-baseline gap-2 text-[11px] text-neutral-400 ${mine() ? 'flex-row-reverse' : ''}`}>
                          <span class="font-semibold text-neutral-500 dark:text-neutral-300">
                            {mine() ? 'You' : comment.author}
                          </span>
                          <time>
                            {new Date(comment.created_at).toLocaleString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </time>
                        </p>
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
                rows={2}
                sendOnEnter
                onSend={() => post()}
                placeholder="Write a comment… markdown, @ to mention, # to cite a card"
              />
              <div class="flex items-center justify-between">
                <span class="text-[10px] text-neutral-400">
                  <kbd class="rounded border border-neutral-200 px-1 dark:border-neutral-700">Enter</kbd> to send ·
                  <kbd class="rounded border border-neutral-200 px-1 dark:border-neutral-700">Shift+Enter</kbd> new line ·
                  <span class="font-semibold">@</span> mention ·
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

/**
 * The per-scope notification settings (Slack channel-notification style):
 * all messages / direct + team mentions / direct only / nothing. Shared
 * by the board chat header and the card drawer header.
 */
function ChatPrefMenu(props: { scopeType: 'board' | 'card'; scopeId: string }) {
  const [level, setLevel] = createSignal<ChatLevel | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

  onSettled(() => {
    // The click-away listener registers synchronously so onSettled can
    // return the cleanup (onCleanup is forbidden inside onSettled — the
    // throw took down the whole board page in dev).
    const onPointerDown = (event: MouseEvent) => {
      if (open() && root && !root.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    void getChatPref(props.scopeType, props.scopeId)
      .then((saved) => {
        setLevel(saved);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => document.removeEventListener('mousedown', onPointerDown);
  });

  const current = () => level() ?? 'mentions_team';
  const pick = (next: ChatLevel | null) => {
    setLevel(next);
    void setChatPref(props.scopeType, props.scopeId, next).catch(() => {});
    setOpen(false);
  };

  return (
    <div ref={root} class="relative">
      <button
        type="button"
        title="Notification settings"
        class={`rounded-md px-1.5 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
          level() === null ? 'text-neutral-400' : 'text-indigo-500'
        }`}
        onClick={() => setOpen(!open())}
      >
        🔔
      </button>
      <Show when={open()}>
        <div class="absolute right-0 top-full z-40 mt-1.5 w-60 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
          <p class="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Notify me about
          </p>
          <For each={CHAT_LEVELS}>
            {(option) => (
              <button
                type="button"
                class={`flex w-full flex-col rounded-lg px-2 py-1.5 text-left text-xs ${
                  current() === option.value
                    ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                    : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                }`}
                onClick={() => pick(option.value)}
              >
                <span class="font-medium">{option.label}</span>
                <span class="text-[10px] text-neutral-400">{option.hint}</span>
              </button>
            )}
          </For>
          <Show when={level() !== null && loaded()}>
            <button
              type="button"
              class="mt-0.5 w-full rounded-lg px-2 py-1.5 text-left text-xs text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              onClick={() => pick(null)}
            >
              Reset to default
            </button>
          </Show>
          <p class="px-2 pt-1.5 text-[10px] leading-snug text-neutral-400">
            Mentions arrive as notifications; “all” activity is quiet — it lives in the bell’s
            Chat section.
          </p>
        </div>
      </Show>
    </div>
  );
}

/**
 * The board-level chat — the card drawer's comment experience, lifted to
 * the whole board: live messages, avatars, own-vs-others bubbles, and
 * the same @mention surface (people + teams) in the composer. Embedded
 * in the board's side panel (the shell owns the chrome and the tabs).
 */
function BoardChat(props: {
  boardId: string;
  /** The board's workspace — team chips link to team pages. */
  workspaceId: string;
  members: Member[];
  teams: TeamView[];
  /** This board's cards + cross-board cards — # citations resolve. */
  cards: CardView[];
  crossCards: CrossCard[];
  boardName: string;
  canEdit: boolean;
  myId: string | null;
  myAvatar: string | null;
  myName: string;
  accessDelegation: boolean;
  isWsAdmin: boolean;
  /** A mention-grant landed: mirror on the workspace relay. */
  onAccessGranted: (userIds: string[]) => void;
  onTeamAccessGranted: (teamIds: string[]) => void;
  /** Team/user chip hovers raise the detail card. */
  onHover: (target: { kind: 'user' | 'team'; id: string; rect: DOMRect } | null) => void;
  /** # citations open cards (this board) / cross-board cards. */
  onOpenCardRef: (num: number) => void;
  onOpenCrossCard: (cardId: string) => void;
}) {
  type ChatSnapshot = { list: BoardMessageRow[] };
  const chatLive = liveQuery(boardChatStream, 'board-chat');
  const engine = createEngine<ChatSnapshot>({
    streamSource: (key) =>
      (async function* (): AsyncGenerator<ChatSnapshot> {
        for await (const list of await chatLive(key)) {
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
      ].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
      if (draft.list.length !== merged.length || draft.list.some((row, i) => row !== merged[i])) {
        draft.list = merged;
      }
    },
    status: () => chatLive.status(props.boardId),
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
      showAccessNote(error instanceof Error ? error.message : 'Could not grant access');
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
      showAccessNote(error instanceof Error ? error.message : 'Could not ask the admins');
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
          client_op: payload.clientOp,
        });
        current.list = [...current.list].sort(
          (a, b) => +new Date(a.created_at) - +new Date(b.created_at),
        );
      },
      send: () => postBoardMessage(props.boardId, body, clientOp),
      echo: (durable) => durable.list.some((row) => row.client_op === clientOp),
    });
    checkBlocked(body);
  };

  const markdownContext = () => ({
    members: props.members,
    teams: props.teams,
    // # citations in board chat resolve across the org (same maps the
    // card drawer uses); chips read "Board › Card title".
    cardNumbers: [
      ...props.cards
        .map((c) => c.number)
        .filter((number): number is number => number !== null),
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
    const ref = target?.closest?.('[data-card-ref]');
    if (ref) {
      event.preventDefault();
      props.onOpenCardRef(Number(ref.getAttribute('data-card-ref')));
      return;
    }
    const cross = target?.closest?.('[data-card-id]');
    if (cross) {
      event.preventDefault();
      props.onOpenCrossCard(cross.getAttribute('data-card-id') ?? '');
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
                  <li class={`flex items-start gap-2 ${mine() ? 'flex-row-reverse' : ''}`}>
                    <Avatar src={message.avatar_url} name={message.author} size="sm" />
                    <div class={`min-w-0 max-w-[85%] ${mine() ? 'items-end text-right' : ''}`}>
                      <p class={`flex items-baseline gap-2 text-[11px] text-neutral-400 ${mine() ? 'flex-row-reverse' : ''}`}>
                        <span class="font-semibold text-neutral-500 dark:text-neutral-300">
                          {mine() ? 'You' : message.author}
                        </span>
                        <time>
                          {new Date(message.created_at).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </time>
                      </p>
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
              cards={[]}
              workspaceTags={[]}
              crossCards={[]}
              rows={2}
              sendOnEnter
              onSend={() => post()}
              placeholder="Message the board… @ to mention, teams too"
            />
            <div class="flex items-center justify-between">
              <span class="text-[10px] text-neutral-400">
                <kbd class="rounded border border-neutral-200 px-1 dark:border-neutral-700">Enter</kbd> to send
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

/**
 * Board settings drawer — the board's own management surface:
 *  * name + description (editors)
 *  * per-member access to THIS board (workspace admins): none / view /
 *    write. Grants flip the affected viewer's page instantly (relay) and
 *    are confirmed by the echo — the same pattern as every other op.
 *  * delete (board owner or workspace owner/admin).
 * Members with the plain role start at "no access" and are granted per
 * board; owners/admins and the board owner always hold write (their
 * selector renders as a fixed badge, mirroring user_board_access()).
 */
function BoardSettings(props: {
  boardId: string;
  board: { name: string; description: string; owner_id: string };
  canEdit: boolean;
  isWsAdmin: boolean;
  canDelete: boolean;
  /** May editors grant board access themselves (the mention flow)? */
  accessDelegation: boolean;
  onToggleDelegation: (on: boolean) => void;
  detail: WorkspaceDetail;
  meId: string | null;
  deleting: boolean;
  error: string | null;
  /** Surface a failed server write in the drawer's error strip. */
  onError: (message: string) => void;
  /** A team's access changed — mirror on the workspace relay. */
  onTeamAccessChanged: (teamId: string, access: 'edit' | 'view' | null) => void;
  onRename: (name: string) => void;
  onDescribe: (description: string) => void;
  onEffectiveAccess: (member: Member) => 'edit' | 'view' | null;
  onIsGrantable: (member: Member) => boolean;
  onChangeAccess: (userId: string, access: 'edit' | 'view' | null) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [nameDraft, setNameDraft] = createSignal(props.board.name);
  const [descriptionDraft, setDescriptionDraft] = createSignal<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);

  // Escape closes (same affordance as the card drawer).
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') props.onClose();
  };
  document.addEventListener('keydown', onKey);
  onCleanup(() => document.removeEventListener('keydown', onKey));

  // The description textarea starts as a mirror of the server value; null
  // means "not editing" (the rendered markdown shows instead).
  const description = () => descriptionDraft() ?? props.board.description;
  const saveDescription = () => {
    if (descriptionDraft() !== null && descriptionDraft() !== props.board.description) {
      props.onDescribe(descriptionDraft()!);
    }
    setDescriptionDraft(null);
  };

  const ACCESS_OPTIONS: { value: 'edit' | 'view' | null; label: string; hint: string }[] = [
    { value: null, label: 'None', hint: 'No access to this board' },
    { value: 'view', label: 'View', hint: 'See the board, no editing' },
    { value: 'edit', label: 'Write', hint: 'Full editing' },
  ];

  const accessOf = (member: Member) => props.onEffectiveAccess(member);

  return (
    <div class="min-h-0 flex-1 overflow-y-auto p-5">
        <Show when={props.error} fallback={null}>
          {(error) => (
            <p class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950 dark:text-red-400">
              {error()}
            </p>
          )}
        </Show>

        {/* ── name + description ───────────────────────────────────────── */}
        <section class="mt-5">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">Details</h3>
          <label class="mt-2 block text-xs text-neutral-400">Name</label>
          <Show
            when={props.canEdit}
            fallback={<p class="mt-1 text-sm font-medium">{props.board.name}</p>}
          >
            <form
              class="mt-1 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const name = nameDraft().trim();
                if (name && name !== props.board.name) props.onRename(name);
              }}
            >
              <input
                class="flex-1"
                value={nameDraft()}
                maxlength="80"
                onInput={(event) => setNameDraft(event.currentTarget.value)}
              />
              <button
                type="submit"
                disabled={nameDraft().trim() === props.board.name}
                class="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
              >
                Save
              </button>
            </form>
          </Show>

          <label class="mt-3 block text-xs text-neutral-400">
            Description <span class="text-neutral-300">(markdown — shown on this board)</span>
          </label>
          <Show
            when={descriptionDraft() !== null || props.canEdit}
            fallback={<p class="prose-card mt-1 text-sm text-neutral-600 dark:text-neutral-300">{props.board.description || <span class="text-neutral-400">No description</span>}</p>}
          >
            <Show
              when={descriptionDraft() !== null}
              fallback={
                <button
                  type="button"
                  class="mt-1 w-full rounded-lg border border-dashed border-neutral-300 px-3 py-2 text-left text-xs text-neutral-500 hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-600"
                  onClick={() => setDescriptionDraft(props.board.description)}
                >
                  {props.board.description ? 'Edit description…' : '+ Add a description…'}
                </button>
              }
            >
              <form
                class="mt-1 space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveDescription();
                }}
              >
                <textarea
                  class="w-full"
                  rows={4}
                  maxlength={4000}
                  placeholder="What is this board for? Scope, goals, links…"
                  value={description()}
                  onInput={(event) => setDescriptionDraft(event.currentTarget.value)}
                />
                <div class="flex justify-end gap-2">
                  <button
                    type="button"
                    class="rounded-lg px-3 py-1.5 text-xs font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    onClick={() => setDescriptionDraft(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                  >
                    Save
                  </button>
                </div>
              </form>
            </Show>
          </Show>
        </section>

        {/* ── per-member access to this board ──────────────────────────── */}
        <section class="mt-6">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Access on this board
          </h3>
          <Show
            when={props.isWsAdmin}
            fallback={
              <p class="mt-2 text-xs text-neutral-400">
                Only workspace owners and admins can change board access.
              </p>
            }
          >
            <p class="mt-1 text-xs text-neutral-400">
              Members start with no access — grant view or write per board. Changes reach
              everyone on this board instantly.
            </p>
          </Show>
          <ul class="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
            <For each={props.detail.members}>
              {(member) => {
                const current = () => accessOf(member);
                const grantable = () => props.onIsGrantable(member);
                return (
                  <li class="flex items-center gap-3 py-2.5">
                    <Avatar
                      src={member.avatar_url}
                      name={member.display_name}
                      email={member.email}
                      size="sm"
                    />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm font-medium">
                        {member.display_name ?? member.email}
                        <Show when={member.user_id === props.meId}>
                          <span class="ml-1 text-xs font-normal text-neutral-400">(you)</span>
                        </Show>
                      </span>
                      <span class="block truncate text-xs text-neutral-400">
                        {member.role} · workspace member
                      </span>
                    </span>
                    <Show
                      when={grantable() && props.isWsAdmin}
                      fallback={
                        <span
                          title={
                            current() === 'edit'
                              ? 'Always write via their workspace role or board ownership'
                              : 'No access yet'
                          }
                          class={`rounded-full px-2.5 py-1 text-xs font-medium ${
                            current() === 'edit'
                              ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                              : current() === 'view'
                                ? 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                                : 'bg-neutral-100 text-neutral-400 dark:bg-neutral-800'
                          }`}
                        >
                          {current() === 'edit' ? 'Write' : current() === 'view' ? 'View' : 'None'}
                        </span>
                      }
                    >
                      <div class="flex rounded-lg border border-neutral-200 p-0.5 dark:border-neutral-700">
                        <For each={ACCESS_OPTIONS}>
                          {(option) => (
                            <button
                              type="button"
                              title={option.hint}
                              class={`rounded-md px-2.5 py-1 text-xs font-medium ${
                                current() === option.value
                                  ? 'bg-indigo-600 text-white'
                                  : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                              }`}
                              onClick={() => props.onChangeAccess(member.user_id, option.value)}
                            >
                              {option.label}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </section>

        {/* ── mention access: who may let people in ────────────────────── */}
        <section class="mt-6">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Mention access
          </h3>
          <div class="mt-2 flex items-start gap-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
            <button
              type="button"
              role="switch"
              aria-checked={props.accessDelegation ? 'true' : 'false'}
              disabled={!props.isWsAdmin}
              title={
                props.isWsAdmin
                  ? 'Toggle who may grant access when someone is mentioned without it'
                  : 'Only workspace owners and admins can change this'
              }
              class={`relative h-6 w-11 shrink-0 rounded-full transition ${
                props.accessDelegation ? 'bg-indigo-600' : 'bg-neutral-300 dark:bg-neutral-700'
              } ${props.isWsAdmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
              onClick={() => props.onToggleDelegation(!props.accessDelegation)}
            >
              <span
                class={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                  props.accessDelegation ? 'left-[1.375rem]' : 'left-0.5'
                }`}
              />
            </button>
            <div class="min-w-0">
              <p class="text-sm font-medium">
                Anyone with access can grant board access
              </p>
              <p class="mt-0.5 text-xs leading-relaxed text-neutral-400">
                When someone is mentioned but can’t see this board:{' '}
                <span class={props.accessDelegation ? 'text-indigo-600 dark:text-indigo-400' : ''}>
                  {props.accessDelegation
                    ? 'the author can let them in directly and notify them.'
                    : 'the author can only ask the workspace owners/admins to grant access.'}
                </span>{' '}
                Owners and admins can always grant, either way.
              </p>
            </div>
          </div>
        </section>

        {/* ── teams: grant the whole team access to this board ──────── */}
        <section class="mt-6">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Team access
          </h3>
          <Show
            when={(props.detail.teams.length ?? 0) > 0}
            fallback={
              <p class="mt-2 text-xs text-neutral-400">
                No teams yet — create them from the workspace members page.
              </p>
            }
          >
            <p class="mt-1 text-xs text-neutral-400">
              Granting a team access gives every member that access (individuals can still
              be tuned above).
            </p>
            <ul class="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
              <For each={props.detail.teams}>
                {(team) => {
                  const current = () =>
                    (props.detail.teamAccess[props.boardId] ?? []).find(
                      (grant) => grant.teamId === team.id,
                    )?.access ?? null;
                  const canManage = () =>
                    props.isWsAdmin ||
                    team.members.some(
                      (member) => member.user_id === props.meId && member.role === 'admin',
                    );
                  return (
                    <li class="flex items-center gap-3 py-2.5">
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm font-medium">
                          @{team.name}
                          <Show when={team.members.some((m) => m.role === 'admin')}>
                            <span class="ml-1 text-[10px] font-normal text-neutral-400">
                              · {team.members.filter((m) => m.role === 'admin').length} admin
                              {team.members.filter((m) => m.role === 'admin').length === 1 ? '' : 's'}
                            </span>
                          </Show>
                        </span>
                        <span class="block truncate text-xs text-neutral-400">
                          {team.members.length} member{team.members.length === 1 ? '' : 's'}
                        </span>
                      </span>
                      <Show
                        when={canManage()}
                        fallback={
                          <span
                            class={`rounded-full px-2.5 py-1 text-xs font-medium ${
                              current() === 'edit'
                                ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                                : current() === 'view'
                                  ? 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                                  : 'bg-neutral-100 text-neutral-400 dark:bg-neutral-800'
                            }`}
                          >
                            {current() === 'edit' ? 'Write' : current() === 'view' ? 'View' : 'None'}
                          </span>
                        }
                      >
                        <div class="flex rounded-lg border border-neutral-200 p-0.5 dark:border-neutral-700">
                          <For each={[null, 'view', 'edit'] as const}>
                            {(option) => (
                              <button
                                type="button"
                                class={`rounded-md px-2.5 py-1 text-xs font-medium ${
                                  current() === option
                                    ? 'bg-indigo-600 text-white'
                                    : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                                }`}
                                onClick={() =>
                                  void setBoardTeamAccess({
                                    boardId: props.boardId,
                                    teamId: team.id,
                                    access: option,
                                  })
                                    .then(() => props.onTeamAccessChanged(team.id, option))
                                    .catch((error: unknown) => {
                                    props.onError(
                                      error instanceof Error ? error.message : 'Could not change team access',
                                    );
                                  })
                                }
                              >
                                {option === null ? 'None' : option === 'view' ? 'View' : 'Write'}
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </section>

        {/* ── danger zone ──────────────────────────────────────────────── */}
        <Show when={props.canDelete}>
          <section class="mt-6 border-t border-neutral-200 pt-4 dark:border-neutral-800">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-red-500">
              Danger zone
            </h3>
            <p class="mt-1 text-xs text-neutral-400">
              Deleting removes the board, its lists, cards, and comments for everyone.
            </p>
            <Show
              when={confirmingDelete()}
              fallback={
                <button
                  type="button"
                  class="mt-2 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete this board…
                </button>
              }
            >
              <span class="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  disabled={props.deleting}
                  class="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                  onClick={() => props.onDelete()}
                >
                  {props.deleting ? 'Deleting…' : 'Really delete everything?'}
                </button>
                <button
                  type="button"
                  class="text-xs font-medium text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </button>
              </span>
            </Show>
          </section>
        </Show>
    </div>
  );
}

/** Bottom-right stack of retryable failures — the engine's error surface. */
function FailureToasts(props: {
  failures: { id: string; kind: string; error?: string }[];
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <div class="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      <For each={props.failures}>
        {(failure) => (
          <div class="flex items-start gap-3 rounded-xl border border-red-200 bg-white p-3 text-sm shadow-lg dark:border-red-900 dark:bg-neutral-900">
            <div class="flex-1">
              <p class="font-medium">{OP_LABELS[failure.kind] ?? 'Something went wrong'}</p>
              <p class="mt-0.5 text-xs text-neutral-400">{failure.error}</p>
            </div>
            <button
              type="button"
              class="rounded-md bg-indigo-600 px-2 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
              onClick={() => props.onRetry(failure.id)}
            >
              Retry
            </button>
            <button
              type="button"
              class="rounded-md px-1.5 py-1 text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
              title="Dismiss"
              onClick={() => props.onDismiss(failure.id)}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

import { Title } from '@solidjs/meta';
import type { RouteProps } from '@solidjs/router';
import { liveQuery, revalidate, useNavigate, useSearchParams } from '@solidjs/router';
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onSettled } from 'solid-js';

import { AddList } from '../../components/board/AddList';
import { ChatPrefMenu } from '../../components/board/ChatPrefMenu';
import { DetailHoverCard } from '../../components/board/DetailHoverCard';
import { FailureToasts } from '../../components/board/FailureToasts';
import { BoardSettings } from '../../components/board/BoardSettings';
import { BoardChat } from '../../components/board/BoardChat';
import { CardDrawer } from '../../components/board/CardDrawer';
import { BoardColumn } from '../../components/board/BoardColumn';
import { ACCESS_ENTITY, createBoardEngine, createEngine } from '../../lib/sync';
import { perfFirstValue, perfTrack } from '../../lib/perf';
import { cachedStream, cacheGet, cachePut } from '../../lib/cache';
import { useEntities } from '../../lib/entity-store';
import { planDrop } from '../../lib/card-drop';
import { trackRecentBoard, warmBoardActive } from '../../lib/prefetch';
import { brand } from '../../lib/brand';
import { markBoardSynced } from '../../lib/offline-state';
import { noteEngagementEdit } from '../../components/InstallCard';
import { SyncWatermark } from '../../components/SyncWatermark';
import { createBoardPresence, presenceColor } from '../../lib/presence';
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
import { captureCardCompleted, captureCardCreated } from '../../lib/telemetry';
import {
  boardChatStamp,
  stampBoardChatSeen,
  hydrateBoardChatSeen,
} from '../../lib/board-chat-seen';
import { openBoardChat } from '../../lib/open-scopes';
import { createPanelWidth } from '../../lib/panel-width';
import { markBoardNotificationsSeen } from '../../lib/notifications';
import {
  boardStream,
  createCard,
  createList,
  deleteBoard,
  deleteList,
  getBoardRevision,
  getBoardSnapshot,
  getCrossBoardCards,
  getWorkspaceBoardList,
  moveCard as moveCardServer,
  resolveCard as resolveCardServer,
  type BoardMessageRow,
  type BoardSnapshot,
  type CrossCard,
  unresolveCard as unresolveCardServer,
  updateBoard as updateBoardServer,
  updateCard as updateCardServer,
  updateList as updateListServer,
} from '../../lib/boards';

import {
  getMyWorkspaces,
  getWorkspaceSnapshot,
  reserveSwitchIntent,
  setBoardAccess,
  switchWorkspaceOrdered,
  workspaceStream,
  type Member,
  type WorkspaceDetail,
} from '../../lib/workspaces';
import { errorMessage } from '../../lib/error-message';
const EMPTY: BoardSnapshot = {
  board: {
    id: '',
    name: '',
    owner_id: '',
    workspace_id: null,
    created_at: '',
    updated_at: '',
    client_op: null,
    description: '',
    access_delegation: false,
  },
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

export default function Board(props: RouteProps<'/b/:boardId'>) {
  // liveQuery: one shared channel per board, request-scoped on the server
  // (SSR renders the first value and closes), reconnecting on the client.
  const boardLive = liveQuery(boardStream, 'board');
  // The L2 entity store (phase 1): both engines normalize their durable
  // snapshots into it — every chip on this page resolves tag names from
  // it, so a rename re-renders them all in the frame it lands (the
  // canonical test). Declared BEFORE the engines: their ingest closures
  // reference it, and while those only fire on async durable emissions
  // today, the reference must not depend on that.
  const entities = useEntities();
  const engine = createBoardEngine(
    // Perf mark: board open → first snapshot (docs/performance.md budget).
    // The cached stream seeds the view instantly on a warm open; the live
    // producer revalidates and every yield refreshes the cache.
    (boardId) =>
      perfFirstValue(
        cachedStream(`board:${boardId}`, () => boardLive(boardId), 'board-revalidate'),
        'board-open',
      ),
    () => props.params.boardId,
    EMPTY,
    () => boardLive.status(props.params.boardId),
    // The durable poll refresh gets its own mark: realtime outages show
    // up here, not in board-open. It also keeps the cache warm when
    // realtime is dead.
    //
    // Revision-gated (migration 0032's whole point): the poll's first
    // read is the cursor ALONE — one tiny query. An unchanged board
    // re-feeds the cached snapshot instead of six reads plus the full
    // board over the wire, so idle tabs cost ~nothing server-side. The
    // cache rides the same stream the engine feeds from (cachedStream
    // writes every yield), so its revision is the engine's own; a
    // missing/evicted cache or any landed write — mine or another
    // viewer's, realtime dead or alive — bumps the cursor and takes the
    // full path. Server logs showed the ungated poll re-snapshotting
    // every 20s per tab at 600ms–1.5s a pull.
    () =>
      perfTrack('board-refresh', async () => {
        const id = props.params.boardId;
        const [revision, cached] = await Promise.all([
          getBoardRevision(id),
          cacheGet<BoardSnapshot>(`board:${id}`),
        ]);
        if (cached && cached.revision === revision) return cached;
        const snapshot = await getBoardSnapshot(id);
        cachePut(`board:${id}`, snapshot);
        return snapshot;
      }),
    // Phase 1 (ADR-1): every durable board snapshot lands its tag
    // rows and card_tags join rows in the entity store — the chips
    // below resolve names from it, not from their embedded copies.
    (snap) => entities.ingestBoardSnapshot(snap),
  );
  const view = engine.view;
  const me = createMemo(() => getMe());
  const navigate = useNavigate();

  // The per-board last-synced watermark (offline UX): every durable
  // snapshot the engine merges stamps the board's freshness. Reads the
  // view's revision — the merged cursor, not the raw wire's.
  createEffect(
    () => ({ boardId: props.params.boardId, revision: view().revision }),
    ({ boardId, revision }) => markBoardSynced(boardId, revision),
  );

  // The install affordance's engagement signal: edits are the moment a
  // user benefits from installing. Counted per session, never blocking.
  createEffect(
    () => engine.ops().filter((op) => !op.remote).length,
    (count, prev) => {
      if (count > (prev ?? 0)) noteEngagementEdit();
    },
  );

  // Prefetch bookkeeping (docs/performance.md, layer 3): this board is
  // the user's most-recently-opened (the dashboard warms from that
  // list), and while it is open its live channel owns the cache — a
  // late warm finishing over it must not write stale.
  //
  // Param-keyed, NOT onSettled: the route is param-reactive — navigating
  // to another board reuses this component — so the bookkeeping must
  // follow the param. The cleanup releases the previous board on each
  // change and at unmount.
  createEffect(
    () => props.params.boardId,
    (boardId) => {
      trackRecentBoard(boardId);
      warmBoardActive(boardId, true);
      return () => warmBoardActive(boardId, false);
    },
  );

  /** A comment op payload (the drawer's engine consumes these too). */
  type CommentOp = Extract<BoardOpPayload, { kind: 'comment-created' }>;

  /** What the open drawer hears from the board relay: a comment op, or the
   *  failure of one (both engines' predictions drop under the same id). */
  type CommentBusEvent =
    { type: 'op'; payload: CommentOp; opId: string } | { type: 'fail'; opId: string };

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

  /** Author path: outbox op + relay to the other viewers. The optional
   *  telemetry closure is the behavior event for the op — the engine
   *  fires it when the echo retires (the write is durable). */
  const runOp = (payload: BoardOpPayload, send: () => Promise<unknown>, telemetry?: () => void) => {
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
      telemetry,
    });
    presence.broadcastOp({ opId, payload });
  };

  const presence = createBoardPresence(
    props.params.boardId,
    () => me(),
    (op) => {
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
    },
  );

  // ── workspace detail: members, roles, and per-board access overrides ──
  // Powers the settings drawer's grant UI. Durable snapshots arrive on the
  // workspace stream; provisional ops on the relay below. The key follows
  // the board's workspace (null until the board snapshot lands — the engine
  // simply re-keys when it appears).
  const workspaceLive = liveQuery(workspaceStream, 'ws-detail');
  const wsEngine = createEngine<WorkspaceDetail>({
    // Stale-while-revalidate like the board itself (docs/performance.md,
    // layer 1): the cached roster paints members — names, avatars — the
    // instant the page opens; the live producer revalidates behind it.
    // This is the fix for the reload flash on card #51: image BYTES were
    // instant in the service worker, but the roster carrying avatar_url
    // was a cold fetch, so every avatar showed the "?" fallback until it
    // landed. An empty key (pre-snapshot) ends quietly — nothing caches.
    streamSource: (key) =>
      perfFirstValue(
        cachedStream(`ws-detail:${key}`, () => workspaceLive(key), 'ws-detail-revalidate'),
        'ws-detail-open',
      ),
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
    // The workspace's tag vocabulary joins the entity store too —
    // richer rows than the board's chips carry (descriptions land).
    ingest: (detail) => entities.ingestWorkspaceDetail(detail),
    status: () => workspaceLive.status(view().board.workspace_id ?? ''),
    refresh: async () => {
      const wsId = view().board.workspace_id;
      return wsId ? ((await getWorkspaceSnapshot(wsId)) ?? EMPTY_WORKSPACE) : EMPTY_WORKSPACE;
    },
  });

  // Direct visits (link, bookmark, notification) can land on a board whose
  // workspace isn't the active one — the switcher, dashboard, and every
  // workspace-scoped page must agree with what's on screen, so the active
  // choice follows the board's workspace. Board-only guests (no membership
  // in the board's workspace) keep their current choice untouched.
  // The intent is RESERVED before the async membership lookup, so a lookup
  // that resolves late can never claim the newest token and overwrite a
  // newer selection; "already active" is decided by the coordinator itself
  // from the cookie inside its serialized slot (never from a stale cached
  // snapshot), so a corrective switch is always queued when it matters.
  createEffect(
    () => view().board.workspace_id,
    (boardWorkspaceId) => {
      if (!boardWorkspaceId) return;
      const intent = reserveSwitchIntent();
      void (async () => {
        try {
          const mine = await getMyWorkspaces();
          // Board-only guest: no membership in the board's workspace —
          // the reservation is simply abandoned (it never enters the
          // request chain), and the active choice stays untouched.
          if (!mine.some((ws) => ws.id === boardWorkspaceId)) return;
          const outcome = await switchWorkspaceOrdered(boardWorkspaceId, intent);
          // 'current' can still need a refresh: a superseded switch may
          // have written the cookie without any caller revalidating, so
          // the cached "current" flag can lag behind the cookie. Refresh
          // on every non-superseded outcome.
          if (outcome !== 'superseded') {
            revalidate('workspaces');
            revalidate('boards');
          }
        } catch {
          // Best effort: on failure the active choice stays as it was —
          // the board itself still renders, and the next visit retries.
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

  // Deep links: ?card=<id> opens the drawer, ?chat=1 opens the chat tab,
  // ?chat=<message-id> opens the chat ON that exact message (mention
  // backlinks in card trails click through to the citing message).
  const [searchParams, setSearchParams] = useSearchParams<{ card?: string; chat?: string }>();
  const [chatAnchor, setChatAnchor] = createSignal<string | null>(null);
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
        // A UUID names the message to land on; anything else just opens
        // the tab.
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chat)) {
          setChatAnchor(chat);
        }
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
  /** The dragged card's height — the ghost opens exactly that much space. */
  const [dragHeight, setDragHeight] = createSignal<number | null>(null);
  /** The card the next tick's delayed hide belongs to (drag image timing). */
  let pendingDragCard: string | null = null;
  /** The dragged card's home slot — broadcast at dragstart so peers lift
   *  the card straight into its preview at the original spot, letting the
   *  source card stay hidden for the WHOLE drag (one representation, even
   *  while the hover travels other lists). */
  let dragHomeSlot: { listId: string; index: number } | null = null;

  // A resting pointer sends no hover broadcasts, and the relay expires
  // silent drags after 4s — so a long drag would drop its peer ghost
  // mid-flight. A 2s heartbeat re-broadcasts the current drag state:
  // peers keep the ghost (and the source card's ring) alive as long as
  // the mover still holds the card; when the tab closes, the heartbeat
  // dies with it and the relay expires the drag the usual way.
  let dragHeartbeat: ReturnType<typeof setInterval> | null = null;
  const stopHeartbeat = () => {
    if (dragHeartbeat) {
      clearInterval(dragHeartbeat);
      dragHeartbeat = null;
    }
  };
  const startHeartbeat = () => {
    dragHeartbeat ??= setInterval(() => {
      const cardId = dragging();
      if (!cardId) {
        stopHeartbeat();
        return;
      }
      const hint = dropHint() ?? dragHomeSlot;
      const name = me()?.display_name || 'Someone';
      if (hint) {
        presence.broadcastDragHover(cardId, name, dragHeight(), hint.listId, hint.index);
      } else {
        presence.broadcastDrag(cardId, name, dragHeight());
      }
    }, 2000);
  };
  onSettled(() => stopHeartbeat);

  // The mover's hover slot broadcasts to peers (deduped by the dropHint
  // setter — one message per real slot crossing): they see the ghost
  // glide exactly where the mover points, no scrolling on their side.
  createEffect(
    () => dropHint(),
    (hint) => {
      if (!dragging() || !hint) return;
      presence.broadcastDragHover(
        dragging(),
        me()?.display_name || 'Someone',
        dragHeight(),
        hint.listId,
        hint.index,
      );
    },
  );

  // ── auto-scroll while dragging (board card #50) ─────────────────────────
  // Both axes: the horizontal board scroller and the hovered column's
  // vertical scroller scroll at their edges. The pointer rides in a plain
  // variable (the rAF loop makes no reactive reads); the loop lives
  // exactly as long as the drag does.
  let dragPoint: { x: number; y: number } | null = null;
  onSettled(() => {
    const onDragOver = (event: DragEvent) => {
      if (dragging()) dragPoint = { x: event.clientX, y: event.clientY };
    };
    document.addEventListener('dragover', onDragOver);
    return () => document.removeEventListener('dragover', onDragOver);
  });
  createEffect(
    () => dragging(),
    (cardId) => {
      if (!cardId) return;
      const EDGE = 90;
      const SPEED = 18;
      const step = () => {
        const point = dragPoint;
        if (point) {
          const board = document.querySelector<HTMLElement>('[data-board-scroll]');
          if (board) {
            const rect = board.getBoundingClientRect();
            // Only while the pointer sits in the board's vertical band.
            if (point.y > rect.top - 60 && point.y < rect.bottom + 60) {
              if (point.x - rect.left < EDGE) board.scrollLeft -= SPEED;
              else if (rect.right - point.x < EDGE) board.scrollLeft += SPEED;
            }
          }
          const column = document
            .elementFromPoint(point.x, point.y)
            ?.closest<HTMLElement>('[data-column]')
            ?.querySelector<HTMLElement>('[data-cards-scroll]');
          if (column) {
            const rect = column.getBoundingClientRect();
            if (point.y - rect.top < EDGE) column.scrollTop -= SPEED;
            else if (rect.bottom - point.y < EDGE) column.scrollTop += SPEED;
          }
        }
        raf = requestAnimationFrame(step);
      };
      let raf = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf);
    },
  );

  const [openCardId, setOpenCardId] = createSignal<string | null>(null);
  // Detail hover cards over @mentions and #citations.
  const [hover, setHover] = createSignal<{
    kind: 'user' | 'card' | 'tag' | 'team';
    id: string;
    rect: DOMRect;
  } | null>(null);
  // Cross-board reference targets — every card the viewer can reach
  // outside this board. Feeds the # menu's cross-card chips AND the
  // accessibleCardIds privacy gate, so it must be loaded with the BOARD,
  // not lazily on the first drawer open (a viewer who never opens the
  // drawer would see every cross-board chip as "private card").
  // Keyed by workspace id (a stale list would gate the wrong cards);
  // a failed load retries (capped), like the board list.
  const [crossCardsFor, setCrossCardsFor] = createSignal<{
    wsId: string | null;
    cards: CrossCard[];
  }>({ wsId: null, cards: [] });
  const crossCards = () => crossCardsFor().cards;
  const [crossCardsRetry, setCrossCardsRetry] = createSignal(0);
  createEffect(
    () => [view().board.workspace_id, crossCardsRetry()] as const,
    ([wsId]) => {
      if (!wsId) return;
      if (crossCardsFor().wsId === wsId) return;
      let alive = true;
      onCleanup(() => {
        alive = false;
      });
      void getCrossBoardCards(wsId)
        .then((cards) => {
          if (alive && view().board.workspace_id === wsId) setCrossCardsFor({ wsId, cards });
        })
        .catch(() => {
          if (alive && crossCardsRetry() < 3)
            setTimeout(() => setCrossCardsRetry((n) => n + 1), 2000);
        });
    },
  );
  // The workspace's boards, for the composer's # menu (cross-board
  // citations → board backlinks). RLS: only boards this viewer can see.
  // Keyed by workspace id: navigating to another workspace's board in
  // the same session must not serve the OLD workspace's list — and a
  // failed load retries on the next effect run instead of caching empty.
  const [workspaceBoardsFor, setWorkspaceBoardsFor] = createSignal<{
    wsId: string | null;
    boards: { id: string; name: string }[];
  }>({
    wsId: null,
    boards: [],
  });
  const workspaceBoards = () => workspaceBoardsFor().boards;
  // A failed load retries (capped) instead of leaving the menu without
  // cross-board chips until a full reload.
  const [boardListRetry, setBoardListRetry] = createSignal(0);
  createEffect(
    () => [view().board.workspace_id, boardListRetry()] as const,
    ([wsId]) => {
      if (!wsId) return;
      if (workspaceBoardsFor().wsId === wsId) return;
      let alive = true;
      onCleanup(() => {
        alive = false;
      });
      void getWorkspaceBoardList(wsId)
        .then((boards) => {
          if (alive && view().board.workspace_id === wsId) {
            setWorkspaceBoardsFor({ wsId, boards });
          }
        })
        .catch(() => {
          if (alive && boardListRetry() < 3) {
            setTimeout(() => setBoardListRetry((n) => n + 1), 2000);
          }
        });
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
      (view()
        .cards.filter((c) => c.list_id === listId)
        .reduce((max, c) => Math.max(max, c.position), 0) || 0) + 1;
    const clientOp = crypto.randomUUID();
    // Captured as a plain local: the telemetry closure fires at echo
    // retirement (outside any tracked scope) and the board is stable
    // for the life of the op.
    const boardId = props.params.boardId;
    runOp(
      { kind: 'create-card', tempId: crypto.randomUUID(), listId, title, position, clientOp },
      () => createCard(listId, title, clientOp),
      // The cardCreated behavior event: quick-add creates bare cards —
      // description and due date arrive later via update-card, so both
      // ship false at creation today.
      () => captureCardCreated({ boardId, hasDescription: false, hasDueDate: false }),
    );
  };

  const moveCard = (cardId: string, toListId: string, toIndex: number) => {
    // The planner never ties (lib/card-drop.ts): a healthy gap takes the
    // midpoint; a degenerate zone — tied neighbours, or a gap halved to
    // float precision — heals: the segment re-spreads across its gap
    // and the displaced cards ride along as extra move ops. Without the
    // heal, a drop inside a tie computed (1+1)/2 = 1: the card JOINED
    // the tie and the fold's re-merge shuffled it seconds later.
    const drop = planDrop(view().cards, toListId, toIndex, cardId);
    for (const heal of drop.heals) {
      // A provisional (relayed) card's write lives on its author's
      // machine — healing it locally would fight the prediction.
      if (engine.isTemp(heal.cardId)) continue;
      runOp(
        { kind: 'move-card', cardId: heal.cardId, listId: toListId, position: heal.position },
        () => moveCardServer(heal.cardId, toListId, heal.position),
      );
    }
    runOp({ kind: 'move-card', cardId, listId: toListId, position: drop.position }, () =>
      moveCardServer(cardId, toListId, drop.position),
    );
  };

  /** The time capsule's hide/unhide (0059): resolve removes the card from
   *  the board's lists; unresolve brings it back to its frozen list (the
   *  RPC heals position and logs the trail). */
  const toggleResolve = (cardId: string, resolved: boolean) => {
    // Same capture rule as addCard above — the closure fires untracked.
    const boardId = props.params.boardId;
    runOp(
      {
        kind: 'resolve-card',
        cardId,
        resolved,
        at: new Date().toISOString(),
        by: me()?.id ?? null,
      },
      () => (resolved ? resolveCardServer(cardId) : unresolveCardServer(cardId)),
      // Completion only — an unresolve is not a task success.
      resolved ? () => captureCardCompleted({ boardId }) : undefined,
    );
  };

  const addList = (name: string) => {
    const position = (view().lists.reduce((max, l) => Math.max(max, l.position), 0) || 0) + 1;
    const clientOp = crypto.randomUUID();
    runOp({ kind: 'create-list', tempId: crypto.randomUUID(), name, position, clientOp }, () =>
      createList(props.params.boardId, name, clientOp),
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
    runOp({ kind: 'update-board', accessDelegation: on }, () =>
      updateBoardServer(props.params.boardId, { accessDelegation: on }),
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
      // Stamp the latest message the channel has DELIVERED (server
      // clock) — never the client's wall clock, which could run fast
      // and permanently swallow future messages into "seen".
      stampChatSeen(latestChatInstant());
      setChatUnread(0);
    }
    setPanel(tab);
  };
  onCleanup(() => releaseChatScope?.());
  const openPanel = (tab: 'chat' | 'settings') => switchPanel(panel() === tab ? null : tab);

  // ── board chat unread: a dot on the 💬 button while the panel is shut.
  // The panel + this counter share ONE live query channel. The stamp is
  // server-backed and, crucially, only ever advances to a KNOWN MESSAGE
  // instant (created_at — server clock): a fast client clock can't push
  // it into the future, where it would swallow yet-unseen messages on
  // every device forever (the stamp is monotonic server-side).
  const chatStamp = () => boardChatStamp(props.params.boardId);
  const stampChatSeen = (latest: number) => stampBoardChatSeen(props.params.boardId, latest);
  const [chatUnread, setChatUnread] = createSignal(0);
  /** The latest message instant the channel has delivered (server clock). */
  const [latestChatInstant, setLatestChatInstant] = createSignal(0);
  const chatLatest = (list: { created_at: string }[]): number =>
    list.length > 0 ? +new Date(list[list.length - 1]!.created_at) : 0;
  const applyChatList = (list: BoardMessageRow[]) => {
    // The board-open chat channel keeps the cache warm even with the
    // panel closed — opening the chat then paints the latest page
    // instantly and the live value verifies it.
    cachePut(`board-chat:${props.params.boardId}`, list);
    setLatestChatInstant(chatLatest(list));
    if (panel() === 'chat') {
      stampChatSeen(chatLatest(list));
      setChatUnread(0);
    } else {
      setChatUnread(
        list.filter((row) => !row.deleted_at && +new Date(row.created_at) > chatStamp()).length,
      );
    }
  };
  onSettled(() => {
    // Hydrate the server-side read state (#43) WITHOUT holding the chat
    // channel hostage: the channel starts at once, and the count
    // re-runs against the last list once the server stamp lands.
    let lastChatList: BoardMessageRow[] | null = null;
    void hydrateBoardChatSeen(props.params.boardId)
      .then(() => {
        if (lastChatList) applyChatList(lastChatList);
      })
      .catch(() => {});
    void (async () => {
      try {
        // Phase 4 (ADR-3): the chat dot rides the board TOPIC's composite —
        // one connection per viewer per board, shared with the board
        // engine and the chat panel (liveQuery dedupes by name+args).
        for await (const composite of await boardLive(props.params.boardId)) {
          lastChatList = composite.chat;
          applyChatList(composite.chat);
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
  /** The viewer's workspace delete role on this board (owners/admins may
   *  delete others' messages — not edit them; 0057). */
  const myWsRole = () => {
    const role = myRole();
    return role === 'owner' || role === 'admin' ? role : null;
  };
  /** The viewer team(s) they ADMIN with edit access to this board — team
   *  admins may delete on boards their team edits (0057). First match. */
  const myTeamAdminOnBoard = createMemo(() => {
    const meId = me()?.id ?? null;
    if (!meId) return null;
    for (const grant of detail().teamAccess[props.params.boardId] ?? []) {
      if (grant.access !== 'edit') continue;
      const team = detail().teams.find((t) => t.id === grant.teamId);
      if (team && team.members.some((m) => m.user_id === meId && m.role === 'admin')) {
        return { teamId: team.id, teamName: team.name };
      }
    }
    return null;
  });

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
  /** purge = the deliberate end-of-life (0061): only the settings drawer
   *  passes it, after a typed confirmation when cards are involved. */
  const removeBoard = async (purge = false) => {
    setSettingsError(null);
    setDeleting(true);
    try {
      await deleteBoard(props.params.boardId, purge || undefined);
      // Relay-after-ack (server-minted identity): open dashboards drop the
      // board instantly; the durable echo covers everyone else.
      wsRelay.broadcastOp({
        opId: crypto.randomUUID(),
        payload: { kind: 'board-deleted', boardId: props.params.boardId },
      });
      navigate('/');
    } catch (error) {
      setDeleting(false);
      setSettingsError(errorMessage(error, 'Could not delete the board'));
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
      <Title>
        {view().board.name || 'Board'} - {brand.name}
      </Title>
      <Show
        when={!view().denied}
        fallback={
          <main class="flex h-[calc(100vh-3rem)] flex-col items-center justify-center gap-3 px-4 text-center">
            <h1 class="text-lg font-semibold">No access to this board</h1>
            <p class="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">
              A workspace admin hasn't granted you view or write access here yet. This page updates
              on its own the moment you're added.
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
                fallback={
                  <span class="rounded-md px-2 py-1 text-base font-semibold tracking-tight">
                    {view().board.name || '…'}
                  </span>
                }
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
              <span
                class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300"
                title="An admin limited your access on this board"
              >
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
                        <Show
                          when={other.avatarUrl}
                          fallback={other.name.slice(0, 2).toUpperCase()}
                        >
                          {/* crossorigin as in Avatar.tsx: cors mode makes the
                            fetch cacheable by the service worker. */}
                          <img
                            src={other.avatarUrl!}
                            alt={other.name}
                            crossorigin="anonymous"
                            class="h-full w-full object-cover"
                          />
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
              <SyncWatermark boardId={props.params.boardId} />
              <Show when={view().lists.length > 0 || view().cards.length > 0}>
                <span>
                  {view().lists.length} lists · {view().cards.filter((c) => !c.resolved_at).length}{' '}
                  cards
                </span>
              </Show>
            </span>
          </header>

          <div data-board-scroll class="flex flex-1 gap-4 overflow-x-auto p-4">
            <For each={view().lists}>
              {(list) => (
                <BoardColumn
                  list={list}
                  cards={view().cards.filter(
                    (card) => card.list_id === list.id && !card.resolved_at,
                  )}
                  members={detail().members}
                  dragging={dragging()}
                  remoteDrag={
                    presence.remoteDrag()?.cardId === undefined ? null : presence.remoteDrag()
                  }
                  dropHint={dropHint()?.listId === list.id ? dropHint()!.index : null}
                  dragHeight={dragHeight()}
                  // The peer ghost: another viewer's hover slot in THIS
                  // column, in the same full-list index space every column
                  // renders (the mover broadcasts the slot their own column
                  // measured — both sides count the same cards).
                  remoteDropHint={
                    presence.remoteDrag()?.listId === list.id
                      ? (presence.remoteDrag()!.index ?? null)
                      : null
                  }
                  // The preview renders the actual card data — the ghost is
                  // the card, not a placeholder shape.
                  draggedCard={
                    dragging() ? (view().cards.find((c) => c.id === dragging()) ?? null) : null
                  }
                  remoteDragCard={
                    presence.remoteDrag()?.cardId
                      ? (view().cards.find((c) => c.id === presence.remoteDrag()!.cardId) ?? null)
                      : null
                  }
                  isTemp={engine.isTemp(list.id)}
                  canEdit={canEdit()}
                  isSaving={(cardId) => engine.isSaving(cardId)}
                  onDragStart={(cardId, height) => {
                    setDragHeight(height);
                    // Broadcast the card's home slot immediately — peers see
                    // the preview at the card's original spot from the first
                    // message, so the source can hide for the entire drag
                    // without a vanish gap.
                    const source = view().cards.find((c) => c.id === cardId);
                    const homeIndex = source
                      ? view()
                          .cards.filter((c) => c.list_id === source.list_id)
                          .findIndex((c) => c.id === cardId)
                      : -1;
                    dragHomeSlot =
                      source && homeIndex >= 0
                        ? { listId: source.list_id, index: homeIndex }
                        : null;
                    const name = me()?.display_name || 'Someone';
                    if (dragHomeSlot) {
                      presence.broadcastDragHover(
                        cardId,
                        name,
                        height,
                        dragHomeSlot.listId,
                        dragHomeSlot.index,
                      );
                    } else {
                      presence.broadcastDrag(cardId, name, height);
                    }
                    // The browser snapshots the drag image as dragstart
                    // completes — hiding the source in the same tick yields
                    // a blank preview, so the hide lands one frame late.
                    pendingDragCard = cardId;
                    setTimeout(() => {
                      if (pendingDragCard === cardId) setDragging(cardId);
                    }, 0);
                    startHeartbeat();
                  }}
                  onDragEnd={() => {
                    stopHeartbeat();
                    pendingDragCard = null;
                    dragHomeSlot = null;
                    setDragging(null);
                    setDropHint(null);
                    setDragHeight(null);
                    presence.broadcastDrag(null, '', null);
                  }}
                  onDrop={(index, cardId) => {
                    // No end broadcast here by design: the spec guarantees a
                    // dragend on the source right after drop, and onDragEnd
                    // is the single place that clears peers' ghost state.
                    stopHeartbeat();
                    pendingDragCard = null;
                    dragHomeSlot = null;
                    setDragging(null);
                    setDropHint(null);
                    setDragHeight(null);
                    // Cards still materializing can't be dragged yet (their
                    // real id hasn't been echoed) — the drop is a no-op.
                    if (cardId && canEdit() && !engine.isTemp(cardId))
                      moveCard(cardId, list.id, index);
                  }}
                  onHover={(index) =>
                    // Identical index → identical value: dragover fires per
                    // mouse-move, and a fresh object per event re-renders and
                    // re-runs the FLIP pass constantly (the glitch storm).
                    setDropHint((prev) =>
                      prev?.listId === list.id && prev.index === index
                        ? prev
                        : { listId: list.id, index },
                    )
                  }
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
                  onResolveCard={(cardId) => toggleResolve(cardId, true)}
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
            boardId={view().board.id}
            cardId={cardId()}
            clientOp={openCardOp()}
            cards={view().cards}
            members={detail().members}
            workspaceId={view().board.workspace_id ?? ''}
            workspaceTags={detail().tags}
            crossCards={crossCards()}
            workspaceBoards={workspaceBoards()}
            canEdit={canEdit()}
            boardName={view().board.name}
            accessDelegation={view().board.access_delegation}
            isWsAdmin={isWsAdmin()}
            myWsRole={myWsRole()}
            myTeamAdmin={myTeamAdminOnBoard()}
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
            onResolve={(cardIdNow, resolved) => toggleResolve(cardIdNow, resolved)}
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
            onOpenCrossCard={(cardId, anchor) => {
              const target = crossCards().find((c) => c.id === cardId);
              setHover(null);
              // Land on the citing comment / description event when the
              // chip carried its anchor (board backlinks).
              const extra = anchor?.commentId
                ? `&comment=${anchor.commentId}`
                : anchor?.event
                  ? `&event=${anchor.event}`
                  : '';
              if (target) navigate(`/b/${target.board_id}?card=${target.id}${extra}`);
            }}
            onOpenTag={(tagId) => {
              setHover(null);
              const wsId = view().board.workspace_id;
              if (wsId) navigate(`/w/${wsId}/tags/${tagId}`);
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
        workspaceBoards={workspaceBoards()}
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
                workspaceBoards={workspaceBoards()}
                workspaceTags={detail().tags}
                boardName={view().board.name}
                canEdit={canEdit()}
                myId={me()?.id ?? null}
                myAvatar={me()?.avatar_url ?? null}
                myName={me()?.display_name ?? me()?.email?.split('@')[0] ?? 'You'}
                accessDelegation={view().board.access_delegation}
                isWsAdmin={isWsAdmin()}
                myWsRole={myWsRole()}
                myTeamAdmin={myTeamAdminOnBoard()}
                onAccessGranted={relayMentionGrant}
                onTeamAccessGranted={relayTeamMentionGrant}
                onHover={setHover}
                onOpenCardRef={(num) => {
                  const target = view().cards.find((c) => c.number === num);
                  if (target) openCard(target.id, target.client_op);
                }}
                onOpenCrossCard={(cardId, anchor) => {
                  const target = crossCards().find((c) => c.id === cardId);
                  // Land on the citing comment / description event when the
                  // chip carried its anchor (board backlinks).
                  const extra = anchor?.commentId
                    ? `&comment=${anchor.commentId}`
                    : anchor?.event
                      ? `&event=${anchor.event}`
                      : '';
                  if (target) navigate(`/b/${target.board_id}?card=${target.id}${extra}`);
                }}
                anchorMessageId={chatAnchor}
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
                onDelete={(purge) => void removeBoard(purge)}
                onClose={() => setPanel(null)}
                cardCount={view().cards.length}
                resolvedCards={view().cards.filter((c) => c.resolved_at)}
                lists={view().lists}
                onUnresolve={(cardId) => toggleResolve(cardId, false)}
              />
            </Show>
          </aside>
        </div>
      </Show>

      <FailureToasts failures={engine.failed()} onRetry={engine.retry} onDismiss={engine.dismiss} />
    </>
  );
}

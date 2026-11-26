// Flowdeck board data layer: server functions the UI calls directly.
//
// Reads run through the request-scoped Supabase client, so RLS decides
// what each caller sees (boards: only memberships; cards: only member
// boards). Mutations validate server-side, then log an activity row —
// the human-readable audit trail. The per-board REVISION lives in
// board_revisions (migration 0032): a trigger bumps it in the same
// transaction as every board-scoped change, which the live stream
// carries so clients can tell when a change has been echoed by the
// database.
import { query } from '@solidjs/router';
import { getRequestEvent } from '@solidjs/web';
import { live } from '@solidjs/web/server-functions';

import { applyFold, planFold, type FoldEvent, type TagRow } from './board-fold';
import { createSupabaseRequestClient } from '../server/supabase';
import { friendlyError } from '../server/friendly';
import {
  filterInaccessible,
  mentionedTeams,
  mentionedUsers,
  mentionsAll,
  notifyChatActivity,
  notifyUsers,
} from '../server/notify';
import type { Database } from '../types/database.generated';

export type BoardSummary = Database['public']['Tables']['boards']['Row'];
export type ListRow = Database['public']['Tables']['lists']['Row'];
export type CardRow = Database['public']['Tables']['cards']['Row'];
export type ActivityRow = Database['public']['Tables']['activity']['Row'];

/** A card row plus the derived stats the UI shows (unseen badges). */
/** A tag chip: a stable, workspace-scoped row (cards reference it by id). */
export type TagView = { id: string; name: string };

export type CardView = CardRow & {
  comment_count: number;
  last_comment_at: string | null;
  /** Profiles assigned to this card (user ids — resolve against members). */
  assignees: string[];
  /** Tags linked to this card (stable rows — same name, same id). */
  tags: TagView[];
};

/** One consistent view of a board — the unit the live stream yields. */
export type BoardSnapshot = {
  board: BoardSummary;
  lists: ListRow[];
  cards: CardView[];
  /** Latest activity id — monotonic per board, bumped by every mutation. */
  revision: number;
  /** This viewer's effective access (edit / view / null when none). */
  myAccess: 'edit' | 'view' | null;
  /** True when the caller has NO access at all (the row is invisible). */
  denied: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Perf: reads slower than this log a server-side warning (the client-side
 *  marks in lib/perf.ts carry the full user-perceived latency; these logs
 *  isolate the database's share — see docs/performance.md). */
const SLOW_READ_MS = 500;

function warnSlow(startedAt: number, what: string): void {
  const ms = Date.now() - startedAt;
  if (ms > SLOW_READ_MS) console.warn(`[perf] ${what} took ${ms}ms`);
}
function assertId(id: string, what: string): string {
  if (!UUID.test(id)) throw new Error(`Invalid ${what}`);
  return id;
}

function cleanText(value: unknown, what: string, max: number): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${what} cannot be empty`);
  return text.slice(0, max);
}

// ── reads ────────────────────────────────────────────────────────────────

/** Boards the caller is a member of (RLS decides — no query filters). */
export const getBoards = query(async (): Promise<BoardSummary[]> => {
  'use server';
  const supabase = createSupabaseRequestClient();
  // The current workspace (cookie choice, validated against membership):
  // the dashboard shows this workspace's boards.
  const workspaceId = await currentWorkspaceId(supabase);
  const queryBuilder = supabase
    .from('boards')
    .select(
      'id, name, description, owner_id, workspace_id, created_at, updated_at, client_op, access_delegation',
    );
  const { data, error } = workspaceId
    ? await queryBuilder.eq('workspace_id', workspaceId).order('updated_at', { ascending: false })
    : await queryBuilder.order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}, 'boards');

/** The dashboard's live unit: the current workspace's boards. */
/** Who's on a board, for the dashboard cards: people with explicit
 *  overrides and teams with grants (admins see everyone's; plain members
 *  see what RLS lets them). */
export type BoardAccessInfo = {
  users: { userId: string; access: 'edit' | 'view' }[];
  teams: { teamId: string; name: string; access: 'edit' | 'view' }[];
};

export type BoardsSnapshot = {
  boards: BoardSummary[];
  /** boardId → who has access (what the viewer may see). */
  access: Record<string, BoardAccessInfo>;
};

export const EMPTY_BOARDS: BoardsSnapshot = { boards: [], access: {} };

/**
 * The user's boards as a live source: the first yield is the current list,
 * and every board row change (teammates creating, renaming, deleting)
 * re-emits. No workspace filter: the dashboard filters client-side, so
 * switching workspaces is instant (no resubscribe). Same contract as
 * boardStream — per-viewer producer, caller's JWT, RLS filters rows.
 */
export const boardsStream = live(async function* (): AsyncGenerator<BoardsSnapshot> {
  'use server';
  const supabase = createSupabaseRequestClient();

  // Session must be resident before subscribing (the boardStream lesson).
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Sign in to see boards');

  const control = producerControls();

  const channel = supabase
    .channel('boards:all')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'boards' }, control.onChanged)
    // Access grants are part of the list's shape: a board another admin
    // grants me appears the moment the override row lands (and disappears
    // on revoke) — no refresh needed.
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'board_access' },
      control.onChanged,
    )
    // Role changes and team grants reshape the whole list too (made admin
    // → every workspace board appears, live) — the "whatever screen I'm
    // on updates" rule.
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'workspace_members' },
      control.onChanged,
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, control.onChanged)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'team_members' },
      control.onChanged,
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'board_team_access' },
      control.onChanged,
    )
    // See boardStream: a rejected binding surfaces only as a `system`
    // error after the join reply. Log it loudly.
    .on('system', {}, (payload: { status?: string; message?: string }) => {
      if (payload?.status === 'error') {
        console.error('[boardsStream] realtime system error:', payload.message);
      }
    });
  channel.subscribe((status, err) => {
    if (err) console.error('boardsStream channel error:', err);
    if (status === 'CHANNEL_ERROR') console.error('boardsStream channel error status');
    if (status === 'TIMED_OUT') console.error('boardsStream channel timed out');
  });

  try {
    yield await boardsSnapshot(supabase);
    console.log('[boardsStream] first value yielded (wire)');
    while (true) {
      if (!control.pending) {
        await new Promise<void>((resolve) => {
          control.wake = resolve;
        });
      }
      if (control.dead) return; // client went away — drop the channel
      control.pending = false;
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (!control.pending) {
        console.log('[boardsStream] change detected — re-snapshotting');
        yield await boardsSnapshot(supabase);
      }
    }
  } finally {
    await supabase.removeChannel(channel);
  }
});

/**
 * Wake handoff + disconnect wiring shared by the live producers. The
 * loop sleeps until `onChanged` pings it (a database change, or the
 * transport's death); `dead` ends the loop so the caller's `finally`
 * releases the realtime channel — without it a producer whose consumer
 * vanished would hold the channel (and its socket) forever.
 */
export function producerControls() {
  const control = {
    wake: undefined as (() => void) | undefined,
    pending: false,
    dead: false,
    onChanged: () => {
      control.pending = true;
      if (control.wake) {
        const w = control.wake;
        control.wake = undefined;
        w();
      }
    },
  };
  // The platform Request's abort signal fires when the client disconnects
  // (Workers cancels streams); some dev middleware never aborts, in which
  // case this is inert and the socket idles out on its own.
  const signal = getRequestEvent()?.request.signal;
  signal?.addEventListener('abort', () => {
    control.dead = true;
    control.onChanged();
  });
  return control;
}

async function boardsSnapshot(
  supabase: ReturnType<typeof createSupabaseRequestClient>,
): Promise<BoardsSnapshot> {
  const { data, error } = await supabase
    .from('boards')
    .select(
      'id, name, description, owner_id, workspace_id, created_at, updated_at, client_op, access_delegation',
    )
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  // Who's on each board (what RLS shows this viewer — admins see all
  // overrides, editors see their own; team grants show for team members
  // and board editors).
  const [accessRows, teamAccessRows, teamRows] = await Promise.all([
    supabase.from('board_access').select('board_id, user_id, access'),
    supabase.from('board_team_access').select('board_id, team_id, access'),
    supabase.from('teams').select('id, name'),
  ]);
  const teamNames = new Map((teamRows.data ?? []).map((row) => [row.id as string, row.name]));
  const access: Record<string, BoardAccessInfo> = {};
  for (const row of (accessRows.data ?? []) as {
    board_id: string;
    user_id: string;
    access: 'edit' | 'view';
  }[]) {
    const bucket = access[row.board_id] ?? { users: [], teams: [] };
    bucket.users.push({ userId: row.user_id, access: row.access });
    access[row.board_id] = bucket;
  }
  for (const row of (teamAccessRows.data ?? []) as {
    board_id: string;
    team_id: string;
    access: 'edit' | 'view';
  }[]) {
    const bucket = access[row.board_id] ?? { users: [], teams: [] };
    bucket.teams.push({
      teamId: row.team_id,
      name: teamNames.get(row.team_id) ?? 'team',
      access: row.access,
    });
    access[row.board_id] = bucket;
  }
  return { boards: data ?? [], access };
}

/** All boards + who's on them, for the sync engine's refresh path. */
export async function getBoardsSnapshot(): Promise<BoardsSnapshot> {
  'use server';
  const supabase = createSupabaseRequestClient();
  return boardsSnapshot(supabase);
}

/** The workspace's boards a board page can offer for cross-board
 *  citation: id + name, RLS-filtered to what the viewer can see. The
 *  # menu uses this so board backlinks are reachable from the composer
 *  (a board chip serializes as [name](board:<uuid>)). */
export async function getWorkspaceBoardList(
  workspaceId: string,
): Promise<{ id: string; name: string }[]> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data, error } = await supabase
    .from('boards')
    .select('id, name')
    .eq('workspace_id', assertId(workspaceId, 'workspace id'))
    .order('name');
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({ id: row.id, name: row.name }));
}

/** One board snapshot, for tests and one-off reads. */
export async function getBoardSnapshot(boardId: string): Promise<BoardSnapshot> {
  'use server';
  const supabase = createSupabaseRequestClient();
  return snapshot(supabase, assertId(boardId, 'board id'));
}

/**
 * The board's revision cursor alone (migration 0032) — the durable poll's
 * cheap first read: an unchanged board skips the full snapshot entirely
 * (six reads and the whole board over the wire for one number). Null when
 * the board — or the caller's access to it — doesn't exist; the caller
 * then takes the full path and gets the denied/empty snapshot it should.
 */
export async function getBoardRevision(boardId: string): Promise<number | null> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data, error } = await supabase
    .from('board_revisions')
    .select('revision')
    .eq('board_id', assertId(boardId, 'board id'))
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.revision ?? null;
}

/**
 * The board as a live source. `live()` gives each connected viewer their
 * own producer running under their own request event, so the Supabase
 * realtime subscription below carries the caller's JWT — and Postgres RLS
 * filters exactly the rows that caller is allowed to see.
 *
 * The contract: every connection first yields the current snapshot, then
 * yields a fresh one each time the database says something changed. If the
 * connection drops, `live()` reconnects and this generator starts over —
 * first value current, never behind.
 */
export const boardStream = live(async function* (boardId: string): AsyncGenerator<BoardSnapshot> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(boardId, 'board id');

  // The realtime socket signs on with the caller's token, and the
  // request-scoped client loads its session lazily from cookies — so the
  // session must be resident BEFORE the channel connects, or the socket
  // joins anonymously and RLS silently filters every event to nothing.
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Sign in to view this board');

  // The board's workspace scopes the `tags` subscription (ADR-3 — phase 2):
  // Supabase bindings are fixed at subscribe time, so one tiny row read
  // precedes the channel build. RLS makes this null for access-less
  // callers (the snapshot below reports `denied` either way).
  const { data: scopeRow } = await supabase
    .from('boards')
    .select('workspace_id')
    .eq('id', id)
    .maybeSingle();
  const tagScopeId = scopeRow?.workspace_id ?? null;

  // Change notifications coalesced through a tiny promise handoff: the
  // loop sleeps until a postgres_changes event pings it.
  const control = producerControls();

  // The fold (Phase 2b): events land as FoldEvents, the loop debounces a
  // burst and folds it into the in-memory snapshot instead of re-querying
  // the board — no database work on the hot path, echoes land in the
  // debounce window. A card-tag ATTACH lands raw — its tag name resolves
  // at plan time against the vocabulary below, so the fold stays pure.
  type RawFoldEvent = FoldEvent | { kind: 'card-tag-attach-raw'; cardId: string; tagId: string };
  const batch: RawFoldEvent[] = [];
  const push = (event: RawFoldEvent) => {
    batch.push(event);
    control.onChanged();
  };
  /** How many folded batches pass before a periodic full re-sync — the
   *  drift bound for missed events (net four with the client's durable
   *  poll, the resync events, and reconnect snapshots). */
  const RESYNC_EVERY_BATCHES = 20;
  let batches = 0;

  let channel = supabase
    .channel(`board:${id}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'lists', filter: `board_id=eq.${id}` },
      (payload: { eventType: string; new: unknown; old: { id?: string } }) => {
        if (payload.eventType === 'DELETE')
          push({ kind: 'list-delete', id: String(payload.old?.id) });
        else push({ kind: 'list-upsert', row: payload.new as ListRow });
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'cards', filter: `board_id=eq.${id}` },
      (payload: { eventType: string; new: { id?: string }; old: { id?: string } }) => {
        if (payload.eventType === 'DELETE')
          push({ kind: 'card-delete', id: String(payload.old?.id) });
        else push({ kind: 'card-touch', id: String(payload.new?.id) });
      },
    )
    // Per-board access overrides matter here too: a view→edit change
    // re-shapes what RLS lets this caller see.
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'board_access', filter: `board_id=eq.${id}` },
      () => push({ kind: 'resync' }),
    )
    // Team grants reach this board the same way (a team this viewer is in
    // gains access → the page flips live).
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'board_team_access', filter: `board_id=eq.${id}` },
      () => push({ kind: 'resync' }),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'team_members' }, () =>
      push({ kind: 'resync' }),
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'boards', filter: `id=eq.${id}` },
      (payload: { new: unknown }) => {
        // A DELETE carries no `new` row — nothing to fold. The cascade's
        // list/card deletes still fold (emptying the view), so without
        // this the page sits on a vanished board until the 20s poll
        // flips it to denied. A full re-snapshot answers in ~80ms.
        if (!payload.new) {
          push({ kind: 'resync' });
          return;
        }
        push({ kind: 'board-row', row: payload.new as BoardSummary });
      },
    )
    // Assignments ship their join rows (ADR-3 — phase 2): user ids fold
    // directly — nothing to resolve, no card fetch.
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'card_assignees' },
      (payload: {
        eventType: string;
        new: { card_id?: string; user_id?: string } | null;
        old: { card_id?: string; user_id?: string } | null;
      }) => {
        const row = payload.new ?? payload.old;
        const cardId = String(row?.card_id ?? '');
        const userId = String(row?.user_id ?? '');
        if (!cardId || !userId) return; // a malformed payload — nothing to fold
        push({
          kind: 'card-assignee-set',
          cardId,
          userId,
          assigned: payload.eventType !== 'DELETE',
        });
      },
    )
    // Tag links ship their join rows too (ADR-3 — phase 2). The attach's
    // tag NAME is not in the payload: it lands raw and resolves at plan
    // time against the stream's vocabulary (seeded by the first
    // snapshot, kept current by tag-upserts) — an unresolvable attach
    // degrades to one card fetch, never a guess.
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'card_tags' },
      (payload: {
        eventType: string;
        new: { card_id?: string; tag_id?: string } | null;
        old: { card_id?: string; tag_id?: string } | null;
      }) => {
        const row = payload.new ?? payload.old;
        const cardId = String(row?.card_id ?? '');
        const tagId = String(row?.tag_id ?? '');
        if (!cardId || !tagId) return; // a malformed payload — nothing to fold
        if (payload.eventType === 'DELETE') push({ kind: 'card-tag-detach', cardId, tagId });
        else push({ kind: 'card-tag-attach-raw', cardId, tagId });
      },
    );

  // The workspace's tag VOCABULARY rides scoped row events (ADR-3,
  // phase 2): a rename folds into the chips' embedded names in memory —
  // zero queries, no re-snapshot. Boards without a workspace (no scope
  // to filter on) keep the old resync.
  if (tagScopeId) {
    channel = channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'tags', filter: `workspace_id=eq.${tagScopeId}` },
      (payload: { new: unknown }) => {
        // Tags are never deleted — the 0067 trigger blocks it; upserts only.
        if (payload.new) push({ kind: 'tag-upsert', row: payload.new as TagRow });
      },
    );
  } else {
    channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: 'tags' }, () =>
      push({ kind: 'resync' }),
    );
  }
  channel
    // Comment stats are counters now (ADR-7, migration 0074): the
    // maintenance trigger's UPDATE IS the event — the badge folds in O(1)
    // with no card fetch, for every writer (agents and API included, they
    // all bump the trigger). Comment DELETEs converge the same way — the
    // old card-touch gap ("a DELETE carries no card to touch") is gone.
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'card_counters' },
      (payload: {
        new: { card_id?: string; comment_count?: number; last_comment_at?: string | null } | null;
      }) => {
        const row = payload.new;
        if (!row?.card_id || row.comment_count === undefined) return;
        push({
          kind: 'card-counter',
          cardId: String(row.card_id),
          commentCount: Number(row.comment_count),
          lastCommentAt: row.last_comment_at ?? null,
        });
      },
    )
    // The exact per-board revision (migration 0032) rides every change.
    // A DELETE carries no `new` (and would push a bogus 0) — skip it; the
    // boards handler's resync owns board deletion.
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'board_revisions', filter: `board_id=eq.${id}` },
      (payload: { new: { revision?: number } }) => {
        if (payload.new?.revision !== undefined) {
          push({ kind: 'revision', value: Number(payload.new.revision) });
        }
      },
    )
    // A rejected postgres_changes binding (a table missing from the
    // supabase_realtime publication, for one) arrives as a `system` error
    // AFTER the join reply — the channel still reports SUBSCRIBED and no
    // events ever flow. Log it loudly: it's invisible anywhere else.
    .on('system', {}, (payload: { status?: string; message?: string }) => {
      if (payload?.status === 'error') {
        console.error('[boardStream] realtime system error:', payload.message);
      }
    })
    .subscribe((status, err) => {
      // Observability: connection problems surface in dev logs and Workers
      // observability instead of failing silently.
      if (err) console.error('boardStream channel error:', err);
      if (status === 'CHANNEL_ERROR') console.error('boardStream channel error status');
      if (status === 'TIMED_OUT') console.error('boardStream channel timed out');
    });

  /** The tag vocabulary this stream keeps for join-row resolution
   *  (ADR-3): seeded by every full snapshot's chips, kept current by
   *  tag-upsert events as they fold. Attach events resolve against it
   *  at plan time — by then the whole debounced burst has arrived, so a
   *  tag created and linked in the same window resolves together. */
  const tagNames = new Map<string, string>();
  const seedVocabulary = (value: BoardSnapshot) => {
    for (const card of value.cards) for (const tag of card.tags) tagNames.set(tag.id, tag.name);
  };

  try {
    // Current value first — the reconnect contract.
    let current = await snapshot(supabase, id);
    seedVocabulary(current);
    yield current;
    while (true) {
      if (!control.pending) {
        await new Promise<void>((resolve) => {
          control.wake = resolve;
        });
      }
      if (control.dead) return; // viewer went away — drop the channel
      control.pending = false;
      // Debounce bursts: one fold for a flurry of changes.
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (!control.pending) {
        const raw = batch.splice(0, batch.length);
        // The burst's tag-upserts feed the vocabulary BEFORE attaches
        // resolve: the whole debounced burst has arrived by now, so a tag
        // created and linked in the same window resolves together — no
        // needless card fetch for it.
        for (const event of raw) {
          if (event.kind === 'tag-upsert') tagNames.set(event.row.id, event.row.name);
        }
        // An attach whose name is STILL unknown after that (a race this
        // stream never saw) degrades to a card-touch — one card fetch,
        // never a guessed chip name.
        const events: FoldEvent[] = raw.map((event) => {
          if (event.kind !== 'card-tag-attach-raw') return event;
          const name = tagNames.get(event.tagId);
          return name
            ? {
                kind: 'card-tag-attach',
                cardId: event.cardId,
                tag: { id: event.tagId, name },
              }
            : { kind: 'card-touch', id: event.cardId };
        });
        const plan = planFold(events);
        // Visibility-shaping changes (and the periodic drift bound) fold
        // to a full re-snapshot; everything else applies in memory.
        if (plan.resync || ++batches % RESYNC_EVERY_BATCHES === 0) {
          console.log(
            `[boardStream ${id.slice(0, 8)}] ${plan.resync ? 'visibility change' : 'periodic re-sync'} — re-snapshotting`,
          );
          current = await snapshot(supabase, id);
          seedVocabulary(current);
        } else {
          const views = await fetchCardViews(supabase, id, plan.cardTouches);
          const next: BoardSnapshot = {
            ...current,
            lists: current.lists.slice(),
            cards: current.cards.slice(),
          };
          if (applyFold(next, plan, views)) {
            current = await snapshot(supabase, id);
            seedVocabulary(current);
          } else {
            current = next;
          }
          console.log(
            `[boardStream ${id.slice(0, 8)}] folded ${events.length} events — ${plan.cardTouches.size} card fetch, ${plan.cardDeletes.size} delete`,
          );
        }
        yield current;
      }
      // A change that landed mid-fold leaves `pending` set and the loop
      // takes another turn immediately.
    }
  } finally {
    // The viewer disconnected (or the generator was rejected): close the
    // Supabase channel so the realtime connection doesn't leak.
    void supabase.removeChannel(channel);
  }
});

async function snapshot(
  supabase: ReturnType<typeof createSupabaseRequestClient>,
  boardId: string,
): Promise<BoardSnapshot> {
  const startedAt = Date.now();
  const [boards, lists, cards, revisionRow, access] = await Promise.all([
    supabase.from('boards').select('*').eq('id', boardId).maybeSingle(),
    supabase
      .from('lists')
      .select('*')
      .eq('board_id', boardId)
      .order('position', { ascending: true }),
    // Comment stats ride the counters join (ADR-7, migration 0074) — the
    // old board_card_comment_stats aggregate leg is gone: five queries,
    // not six, and the stats are transactional rows now.
    supabase
      .from('cards')
      .select('*, card_tags(tag_id, tags(id, name)), card_counters(comment_count, last_comment_at)')
      .eq('board_id', boardId)
      .order('position', { ascending: true }),
    // The trustworthy per-board cursor (migration 0032): bumped by a
    // trigger in the same transaction as every board-scoped change —
    // deletions included, unlike the old activity head.
    supabase.from('board_revisions').select('revision').eq('board_id', boardId).maybeSingle(),
    supabase.rpc('user_board_access', { p_board_id: boardId }),
  ]);
  // Deploy-order safety: code can ship before migration 0032 lands — in
  // that window fall back to the old, less trustworthy cursor (the
  // activity head) so the snapshot keeps working.
  let revision = revisionRow.data?.revision ?? 0;
  if (revisionRow.error) {
    const { data: head } = await supabase
      .from('activity')
      .select('id')
      .eq('board_id', boardId)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    revision = head?.id ?? 0;
  }
  // Assignees live in a join table — fetched per board card (RLS-scoped).
  const assignees = await supabase
    .from('card_assignees')
    .select('card_id, user_id')
    .in(
      'card_id',
      (cards.data ?? []).map((card) => card.id).length > 0
        ? (cards.data ?? []).map((card) => card.id)
        : ['00000000-0000-0000-0000-000000000000'],
    );
  // RLS hides the row from access-less callers: that's "no access", not an
  // error — the stream keeps running so a later grant flips the page live.
  // A transient query ERROR (timeout, socket hiccup) is the opposite: data
  // is null but error is set — surfacing that as "no access" would bounce
  // an authorized viewer off the board until the next snapshot. Throw; the
  // stream retries and the previous snapshot stays on screen.
  if (boards.error) throw new Error(boards.error.message);
  if (!boards.data) {
    return {
      board: { ...EMPTY_BOARD, id: boardId },
      lists: [],
      cards: [],
      revision: 0,
      myAccess: null,
      denied: true,
    };
  }
  const assigneeMap = new Map<string, string[]>();
  for (const row of (assignees.data ?? []) as { card_id: string; user_id: string }[]) {
    const list = assigneeMap.get(row.card_id) ?? [];
    list.push(row.user_id);
    assigneeMap.set(row.card_id, list);
  }
  const value: BoardSnapshot = {
    board: boards.data,
    lists: lists.data ?? [],
    cards: (
      cards.data as unknown as (CardRow & {
        card_tags?: { tag_id: string; tags: { id: string; name: string } | null }[];
        card_counters?:
          | { comment_count: number; last_comment_at: string | null }
          | { comment_count: number; last_comment_at: string | null }[]
          | null;
      })[]
    ).map((card) => {
      // The one-to-one counters join: an object when the row exists,
      // null before a card's first comment (count 0, no last). PostgREST
      // shapes it as an object for unique FKs; the array arm is tolerance.
      const counter = Array.isArray(card.card_counters)
        ? card.card_counters[0]
        : card.card_counters;
      const { card_tags: _links, card_counters: _counter, ...row } = card;
      return {
        ...row,
        comment_count: Number(counter?.comment_count ?? 0),
        last_comment_at: counter?.last_comment_at ?? null,
        assignees: assigneeMap.get(card.id) ?? [],
        tags: (_links ?? [])
          .map((link) => link.tags)
          .filter((tag): tag is { id: string; name: string } => tag !== null)
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    }),
    revision,
    myAccess: (access.data as 'edit' | 'view' | null) ?? null,
    denied: false,
  };
  warnSlow(startedAt, `board snapshot (${boardId})`);
  return value;
}

/** Fresh CardViews for exactly the touched cards — the fold's one small
 *  query per burst (the join rows — tags, assignees, comment stats — ride
 *  the view, not the event payload). Board-scoped, so events from other
 *  boards on the unfiltered card-side channels legitimately miss here. */
async function fetchCardViews(
  supabase: ReturnType<typeof createSupabaseRequestClient>,
  boardId: string,
  cardIds: Set<string>,
): Promise<CardView[]> {
  if (cardIds.size === 0) return [];
  const ids = [...cardIds];
  // Comment stats ride the counters join (ADR-7, migration 0074) — the
  // card_comments aggregation leg is gone.
  const [cardsRes, assigneesRes] = await Promise.all([
    supabase
      .from('cards')
      .select('*, card_tags(tag_id, tags(id, name)), card_counters(comment_count, last_comment_at)')
      .eq('board_id', boardId)
      .in('id', ids),
    supabase.from('card_assignees').select('card_id, user_id').in('card_id', ids),
  ]);
  if (cardsRes.error) throw new Error(cardsRes.error.message);
  // Throw-on-error like snapshot(): a transient failure of the assignee
  // query must not fold silently-wrong stats — the throw ends the
  // generator, live() reconnects, and the reconnect's fresh full
  // snapshot restores truth in ~1s instead of waiting for a resync.
  if (assigneesRes.error) throw new Error(assigneesRes.error.message);
  const assigneeMap = new Map<string, string[]>();
  for (const row of (assigneesRes.data ?? []) as { card_id: string; user_id: string }[]) {
    const list = assigneeMap.get(row.card_id) ?? [];
    list.push(row.user_id);
    assigneeMap.set(row.card_id, list);
  }
  return (
    (cardsRes.data ?? []) as unknown as (CardRow & {
      card_tags?: { tag_id: string; tags: { id: string; name: string } | null }[];
      card_counters?:
        | { comment_count: number; last_comment_at: string | null }
        | { comment_count: number; last_comment_at: string | null }[]
        | null;
    })[]
  ).map((card) => {
    const counter = Array.isArray(card.card_counters) ? card.card_counters[0] : card.card_counters;
    const { card_tags: links, card_counters: _counter, ...row } = card;
    return {
      ...row,
      comment_count: Number(counter?.comment_count ?? 0),
      last_comment_at: counter?.last_comment_at ?? null,
      assignees: assigneeMap.get(card.id) ?? [],
      tags: (links ?? [])
        .map((link) => link.tags)
        .filter((tag): tag is { id: string; name: string } => tag !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

const EMPTY_BOARD: BoardSummary = {
  id: '',
  access_delegation: false,
  name: '',
  owner_id: '',
  workspace_id: null,
  created_at: '',
  updated_at: '',
  client_op: null,
  description: '',
};

// ── board mutations ───────────────────────────────────────────────────────

const DEFAULT_LISTS = ['To do', 'In progress', 'Done'];

/** Create a board with default lists. Returns the new board id.
 *  The workspace's board_creation policy gates who may call this
 *  (owners/admins always; team admins and members per the setting), and
 *  team admins can create FOR one of their teams — it gets access
 *  immediately. */
export async function createBoard(
  name: string,
  clientOp?: string | null,
  description?: string,
  teamId?: string | null,
): Promise<string> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const user = await requireUser(supabase);
  const boardName = cleanText(name, 'Board name', 80);

  // Boards belong to the current workspace — the cookie choice, validated
  // against MY membership. A stale/absent cookie must never silently
  // redirect the board into a DIFFERENT workspace (the old fall-back-to-
  // first-workspace did exactly that): the only safe fallback is an
  // account with exactly one workspace; anyone else gets a clear error.
  const cookieWorkspaceId = await currentWorkspaceId(supabase);
  let workspaceTarget: string | null = cookieWorkspaceId;
  if (!workspaceTarget) {
    const { data: mine } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', user.id)
      .order('created_at');
    const mineIds = ((mine ?? []) as { workspace_id: string }[]).map((row) => row.workspace_id);
    if (mineIds.length === 1) {
      workspaceTarget = mineIds[0];
    } else if (mineIds.length === 0) {
      throw new Error('No workspace found for this account');
    } else {
      throw new Error(
        'No workspace is selected — open a workspace (or pick one from the switcher) before creating a board',
      );
    }
  }

  // Who may create boards here? (The GitHub org setting.)
  const [{ data: me }, { data: myAdminTeams }] = await Promise.all([
    supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceTarget)
      .eq('user_id', user.id)
      .maybeSingle(),
    supabase
      .from('team_members')
      .select('team_id, teams!inner(id, workspace_id)')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .eq('teams.workspace_id', workspaceTarget),
  ]);
  const isWsAdmin = me?.role === 'owner' || me?.role === 'admin';
  const adminTeamIds = (myAdminTeams ?? []).map((row) => row.team_id as string);
  if (!isWsAdmin) {
    const { data: workspace } = await supabase
      .from('workspaces')
      .select('board_creation')
      .eq('id', workspaceTarget)
      .maybeSingle();
    const policy = (workspace?.board_creation as string | undefined) ?? 'team_admins';
    const allowed = policy === 'everyone' || (policy === 'team_admins' && adminTeamIds.length > 0);
    if (!allowed) {
      throw new Error('You need the owner or an admin to create boards in this workspace');
    }
  }
  // A team-targeted creation: must be one of MY teams (or I'm a ws admin).
  const targetTeam = teamId && UUID.test(teamId) ? teamId : null;
  if (targetTeam && !isWsAdmin && !adminTeamIds.includes(targetTeam)) {
    throw new Error('You can only create boards for teams you administer');
  }

  const { data: board, error } = await supabase
    .from('boards')
    .insert({
      name: boardName,
      workspace_id: workspaceTarget,
      owner_id: user.id,
      description: String(description ?? '').slice(0, 4000),
      ...(clientOp ? { client_op: clientOp } : {}),
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  await supabase.from('lists').insert(
    DEFAULT_LISTS.map((listName, index) => ({
      board_id: board!.id,
      name: listName,
      position: index + 1,
    })),
  );
  await logActivity(supabase, user.id, board!.id, 'board.created', { name: boardName });
  // Team-scoped creation: the team gets access immediately (and each
  // member hears about it — the setBoardTeamAccess grant path notifies).
  if (targetTeam) {
    try {
      const { setBoardTeamAccess } = await import('./teams');
      await setBoardTeamAccess({ boardId: board!.id, teamId: targetTeam, access: 'edit' });
    } catch (grantError) {
      console.error('team board grant failed:', grantError);
    }
  }
  return board!.id;
}

/** Board settings: rename and/or set the description (editors only).
 *  The access-delegation switch — "anyone with access may grant others"
 *  — is owners/admins only, and enforced server-side. */
export async function updateBoard(
  boardId: string,
  patch: { name?: string; description?: string; accessDelegation?: boolean },
) {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(boardId, 'board id');
  const user = await requireUser(supabase);
  const update: Partial<Pick<BoardSummary, 'name' | 'description' | 'access_delegation'>> = {};
  if (patch.name !== undefined) update.name = cleanText(patch.name, 'Board name', 80);
  if (patch.description !== undefined)
    update.description = String(patch.description).slice(0, 4000);
  if (patch.accessDelegation !== undefined) {
    const { data: boardRow } = await supabase
      .from('boards')
      .select('workspace_id')
      .eq('id', id)
      .maybeSingle();
    const { data: me } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', boardRow?.workspace_id ?? '')
      .eq('user_id', user.id)
      .maybeSingle();
    if (me?.role !== 'owner' && me?.role !== 'admin') {
      throw new Error('Only owners and admins can change who may grant board access');
    }
    update.access_delegation = patch.accessDelegation;
  }
  if (Object.keys(update).length === 0) return;
  const { error } = await supabase.from('boards').update(update).eq('id', id);
  if (error) throw new Error(error.message);
  if (update.name) {
    await logActivity(supabase, user.id, id, 'board.renamed', { name: update.name });
  }
}

/**
 * Delete a board. Without `purge` this refuses while the board holds any
 * card (the capsule's accidental-loss guard). With `purge` it takes the
 * sanctioned end-of-life path (0061's purge_board RPC): the whole board —
 * cards, comments, every event — goes permanently. The UI only passes
 * purge after an explicit typed confirmation; owners / workspace
 * owners+admins only (the RPC re-checks).
 */
export async function deleteBoard(boardId: string, purge?: boolean): Promise<void> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(boardId, 'board id');
  await requireUser(supabase);
  if (purge) {
    const { error } = await supabase.rpc('purge_board', { p_board_id: id });
    if (error) throw new Error(error.message);
    return;
  }
  // The friendly pre-check — the DB trigger (0060) is the guarantee.
  const { count, error: countError } = await supabase
    .from('cards')
    .select('id', { count: 'exact', head: true })
    .eq('board_id', id);
  if (countError) throw new Error(countError.message);
  if ((count ?? 0) > 0) {
    throw friendlyError(
      `This board still holds ${count} card${count === 1 ? '' : 's'} — deleting it would remove them permanently. Confirm the delete to proceed.`,
    );
  }
  const { error } = await supabase.from('boards').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ── list mutations ────────────────────────────────────────────────────────

export async function createList(boardId: string, name: string, clientOp?: string) {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(boardId, 'board id');
  const user = await requireUser(supabase);
  const listName = cleanText(name, 'List name', 80);
  // Atomic append (same allocator pattern as cards): the per-board
  // counter row serializes concurrent list creations.
  const { data: position, error: allocError } = await supabase.rpc('allocate_list_position', {
    p_board_id: id,
  });
  if (allocError || position == null)
    throw new Error(allocError?.message ?? 'position allocation failed');
  const { error } = await supabase.from('lists').insert({
    board_id: id,
    name: listName,
    position,
    ...(clientOp ? { client_op: clientOp } : {}),
  });
  if (error) throw new Error(error.message);
  await logActivity(supabase, user.id, id, 'list.created', { name: listName });
}

/** List settings: rename and/or set the description (editors only). */
export async function updateList(listId: string, patch: { name?: string; description?: string }) {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(listId, 'list id');
  await requireUser(supabase);
  const update: Partial<Pick<ListRow, 'name' | 'description'>> = {};
  if (patch.name !== undefined) update.name = cleanText(patch.name, 'List name', 80);
  if (patch.description !== undefined)
    update.description = String(patch.description).slice(0, 2000);
  if (Object.keys(update).length === 0) return;
  const { error } = await supabase.from('lists').update(update).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteList(listId: string) {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(listId, 'list id');
  await requireUser(supabase);
  // The time capsule (0059): a list never takes its cards with it —
  // refuse while it holds ANY card (resolved or not).
  const { count, error: countError } = await supabase
    .from('cards')
    .select('id', { count: 'exact', head: true })
    .eq('list_id', id);
  if (countError) throw new Error(countError.message);
  if ((count ?? 0) > 0) {
    throw friendlyError(
      `This list still holds ${count} card${count === 1 ? '' : 's'} — move or resolve them first`,
    );
  }
  const { error } = await supabase.from('lists').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ── card mutations ────────────────────────────────────────────────────────

/** Add a card at the end of a list. Returns the card id. */
export async function createCard(
  listId: string,
  title: string,
  clientOp?: string,
): Promise<string> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(listId, 'list id');
  const user = await requireUser(supabase);
  const cardTitle = cleanText(title, 'Card title', 200);

  const { data: list } = await supabase.from('lists').select('board_id').eq('id', id).maybeSingle();
  if (!list) throw new Error('List not found');

  // Atomic append: the allocator serializes concurrent creators on a
  // per-list counter row, so parallel creates can't land on the same
  // position (agents and humans alike).
  const { data: position, error: allocError } = await supabase.rpc('allocate_card_position', {
    p_list_id: id,
  });
  if (allocError || position == null)
    throw new Error(allocError?.message ?? 'position allocation failed');

  const { data: card, error } = await supabase
    .from('cards')
    .insert({
      board_id: list.board_id,
      list_id: id,
      title: cardTitle,
      position,
      created_by: user.id,
      ...(clientOp ? { client_op: clientOp } : {}),
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  await logActivity(supabase, user.id, list.board_id, 'card.created', { title: cardTitle });
  await logCardEvent(supabase, {
    cardId: card.id,
    boardId: list.board_id,
    actorId: user.id,
    kind: 'created',
    detail: { title: cardTitle },
  });
  return card!.id;
}

export async function updateCard(
  cardId: string,
  patch: {
    title?: string;
    description?: string;
    priority?: string | null;
    /** Stable tag ids (the workspace's shared vocabulary). */
    tagIds?: string[];
    assignees?: string[];
  },
  clientOp?: string | null,
) {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(cardId, 'card id');
  const user = await requireUser(supabase);
  const update: Partial<Pick<CardRow, 'title' | 'description' | 'priority'>> = {};
  if (patch.title !== undefined) update.title = cleanText(patch.title, 'Card title', 200);
  if (patch.description !== undefined)
    update.description = String(patch.description).slice(0, 8000);
  if (patch.priority !== undefined) {
    if (patch.priority !== null && !['low', 'medium', 'high', 'urgent'].includes(patch.priority)) {
      throw new Error('Unknown priority');
    }
    update.priority = patch.priority;
  }
  // A card opened mid-provisional still carries its temp id — the durable
  // row (same client_op) is already in the database; resolve to it.
  const resolved = await resolveCardId(supabase, id, clientOp);
  // The timeline needs the BEFORE state (diffs read "from → to").
  const { data: card } = await supabase
    .from('cards')
    .select('board_id, title, priority, description')
    .eq('id', resolved)
    .maybeSingle();
  if (Object.keys(update).length > 0) {
    const { error } = await supabase.from('cards').update(update).eq('id', resolved);
    if (error) throw new Error(error.message);
  }
  // Timeline: renames and priority changes (after the write above — the
  // "from" side was captured in `card`).
  if (card?.board_id) {
    if (update.title !== undefined && update.title !== card.title) {
      await logCardEvent(supabase, {
        cardId: resolved,
        boardId: card.board_id,
        actorId: user.id,
        kind: 'renamed',
        detail: { from: card.title, to: update.title },
      });
    }
    if (update.priority !== undefined && update.priority !== card.priority) {
      await logCardEvent(supabase, {
        cardId: resolved,
        boardId: card.board_id,
        actorId: user.id,
        kind: 'priority',
        detail: { from: card.priority, to: update.priority },
      });
    }
    if (update.description !== undefined && update.description !== card.description) {
      await logCardEvent(supabase, {
        cardId: resolved,
        boardId: card.board_id,
        actorId: user.id,
        kind: 'description',
        // Snapshots: the trail renders a collapsed from/to diff — the
        // text must survive even after the card changes again.
        detail: { from: card.description ?? '', to: update.description },
      });
      // Mention backlinks: cards cited in the new description get a
      // 'mentioned' row in their own trail (best-effort, idempotent on
      // the host card pair). rpc() reports failures in the result — it
      // never throws — so the error is read, not caught.
      const { error: cardBacklinkError } = await supabase.rpc('log_card_mentions', {
        p_body: update.description,
        p_where: 'description',
        p_board_id: card.board_id,
        p_card_id: resolved,
        p_source_id: resolved,
      });
      if (cardBacklinkError) {
        console.error('description mention backlinks failed:', cardBacklinkError.message);
      }
      // Board backlinks: boards cited in the description get a message
      // in their own chat (same best-effort contract).
      const { error: boardBacklinkError } = await supabase.rpc('log_board_mentions', {
        p_body: update.description,
        p_where: 'description',
        p_board_id: card.board_id,
        p_card_id: resolved,
        p_source_id: resolved,
      });
      if (boardBacklinkError) {
        console.error('description board backlinks failed:', boardBacklinkError.message);
      }
    }
  }
  // Assignments: replace the set (the assignees live in a join table).
  if (patch.assignees !== undefined) {
    const next = [...new Set(patch.assignees)].filter((userId) => /^[0-9a-f-]{36}$/i.test(userId));
    const { data: previous } = await supabase
      .from('card_assignees')
      .select('user_id')
      .eq('card_id', resolved);
    const { error: delError } = await supabase
      .from('card_assignees')
      .delete()
      .eq('card_id', resolved);
    if (delError) throw new Error(delError.message);
    if (next.length > 0) {
      const { error: insError } = await supabase
        .from('card_assignees')
        .insert(next.map((userId) => ({ card_id: resolved, user_id: userId })));
      if (insError) throw new Error(insError.message);
    }
    // Notify the people newly assigned to this card.
    const before = new Set((previous ?? []).map((row) => row.user_id as string));
    const added = next.filter((userId) => !before.has(userId));
    if (added.length > 0 && card?.board_id) {
      try {
        await notifyUsers({
          recipients: added,
          kind: 'assignment',
          cardId: resolved,
          boardId: card.board_id,
          actorId: user.id,
        });
      } catch (notifyError) {
        console.error('assignment notifications failed:', notifyError);
      }
    }
    // Timeline: who got assigned / unassigned — ids + name snapshots
    // (0058: chips resolve the CURRENT name by id; the snapshot is the
    // fallback when the person is gone).
    if (card?.board_id) {
      const removed = [...before].filter((userId) => !next.includes(userId));
      if (added.length > 0 || removed.length > 0) {
        const ids = [...new Set([...added, ...removed])];
        const { data: people } = await supabase
          .from('profiles')
          .select('id, display_name, email')
          .in('id', ids);
        const nameOf = (personId: string) => {
          const person = (people ?? []).find((entry) => entry.id === personId);
          return person?.display_name ?? person?.email?.split('@')[0] ?? 'someone';
        };
        await logCardEvent(supabase, {
          cardId: resolved,
          boardId: card.board_id,
          actorId: user.id,
          kind: 'assignees',
          detail: {
            added: added.map((userId) => ({ id: userId, name: nameOf(userId) })),
            removed: removed.map((userId) => ({ id: userId, name: nameOf(userId) })),
          },
        });
      }
    }
  }
  // Description mentions: everyone @referenced in a NEW description.
  if (patch.description !== undefined && card?.board_id) {
    try {
      const mentioned = mentionedUsers(patch.description);
      const teams = mentionedTeams(patch.description);
      if (mentioned.length > 0 || teams.length > 0) {
        const invisible = new Set(await filterInaccessible(supabase, card.board_id, mentioned));
        const direct = mentioned.filter((userId) => !invisible.has(userId));
        let teamMentions: string[] = [];
        if (teams.length > 0) {
          const { data: teamRows } = await supabase
            .from('team_members')
            .select('user_id')
            .in('team_id', teams);
          teamMentions = [...new Set((teamRows ?? []).map((row) => row.user_id as string))].filter(
            (userId) => !invisible.has(userId),
          );
        }
        // Description mentions respect each person's card level; the
        // audience is just the mention targets (no quiet rows for edits).
        await notifyChatActivity(supabase, {
          scopeType: 'card',
          boardId: card.board_id,
          cardId: resolved,
          actorId: user.id,
          body: patch.description.slice(0, 200),
          audience: [...new Set([...direct, ...teamMentions])],
          directMentions: direct,
          teamMentions,
          mentionsAll: mentionsAll(patch.description),
        });
      }
    } catch (notifyError) {
      console.error('mention notifications failed:', notifyError);
    }
  }
  // Tags: replace the linked set (tags themselves are shared rows).
  if (patch.tagIds !== undefined) {
    const next = [...new Set(patch.tagIds)].filter((tagId) => /^[0-9a-f-]{36}$/i.test(tagId));
    // Timeline: the BEFORE set must be read before the replace lands.
    const { data: beforeRows } = await supabase
      .from('card_tags')
      .select('tag_id')
      .eq('card_id', resolved);
    const beforeIds = new Set(
      ((beforeRows ?? []) as { tag_id: string }[]).map((row) => row.tag_id),
    );
    const { error: delError } = await supabase.from('card_tags').delete().eq('card_id', resolved);
    if (delError) throw new Error(delError.message);
    if (next.length > 0) {
      const { error: insError } = await supabase
        .from('card_tags')
        .insert(next.map((tagId) => ({ card_id: resolved, tag_id: tagId })));
      if (insError) throw new Error(insError.message);
    }
    // Timeline: tags added / removed — ids + name snapshots (0058: chips
    // resolve the CURRENT name by id; the snapshot is the fallback).
    if (card?.board_id) {
      try {
        const addedIds = next.filter((tagId) => !beforeIds.has(tagId));
        const removedIds = [...beforeIds].filter((tagId) => !next.includes(tagId));
        if (addedIds.length > 0 || removedIds.length > 0) {
          const { data: tagRows } = await supabase
            .from('tags')
            .select('id, name')
            .in('id', [...new Set([...addedIds, ...removedIds])]);
          const nameOf = (tagId: string) =>
            (tagRows ?? []).find((row) => row.id === tagId)?.name ?? 'a tag';
          await logCardEvent(supabase, {
            cardId: resolved,
            boardId: card.board_id,
            actorId: user.id,
            kind: 'tags',
            detail: {
              added: addedIds.map((tagId) => ({ id: tagId, name: nameOf(tagId) })),
              removed: removedIds.map((tagId) => ({ id: tagId, name: nameOf(tagId) })),
            },
          });
        }
      } catch (cause) {
        console.error('tag timeline failed:', cause);
      }
    }
  }
}

/** Find or create a workspace tag by name — the shared vocabulary: the
 *  same name always resolves to the same stable id. The description only
 *  rides the CREATE (re-using a tag never clobbers its description). */
export async function findOrCreateTag(
  workspaceId: string,
  rawName: string,
  description?: string,
): Promise<{ id: string; name: string; description: string }> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const wsId = assertId(workspaceId, 'workspace id');
  const name = cleanText(rawName, 'Tag', 24).trim().toLowerCase();
  if (!name) throw new Error('Tag name is empty');
  const { data: existing } = await supabase
    .from('tags')
    .select('id, name, description')
    .eq('workspace_id', wsId)
    .eq('name', name)
    .maybeSingle();
  if (existing)
    return { id: existing.id, name: existing.name, description: existing.description ?? '' };
  const { data, error } = await supabase
    .from('tags')
    .insert({ workspace_id: wsId, name, description: String(description ?? '').slice(0, 500) })
    .select('id, name, description')
    .single();
  if (error || !data) {
    // A teammate created the same name in the same instant — re-read it.
    const { data: raced } = await supabase
      .from('tags')
      .select('id, name, description')
      .eq('workspace_id', wsId)
      .eq('name', name)
      .maybeSingle();
    if (raced) return { id: raced.id, name: raced.name, description: raced.description ?? '' };
    throw new Error(error?.message ?? 'Could not save the tag');
  }
  return { id: data.id, name: data.name, description: data.description ?? '' };
}

/** One entry in the card's activity timeline (the Settings tab streams
 *  these live). `detail` carries display-ready values (names, not ids) —
 *  the trail must read correctly long after the rows it describes are
 *  gone. */
export type CardEventRow = {
  id: string;
  kind: string;
  detail: Record<string, unknown>;
  actor_id: string | null;
  created_at: string;
  /** True when the change was made through an MCP connection (an agent). */
  agent?: boolean;
};

/** The card's timeline — newest last (a trail reads chronologically). */
export async function getCardEvents(cardId: string): Promise<CardEventRow[]> {
  'use server';
  return fetchCardEvents(cardId);
}

/** The timeline fetch as a PLAIN function — the live producer calls this
 *  (a 'use server' function called from producer context resolves as a
 *  self-RPC that never lands; producers must do plain work). */
async function fetchCardEvents(cardId: string): Promise<CardEventRow[]> {
  const startedAt = Date.now();
  const supabase = createSupabaseRequestClient();
  const { data, error } = await supabase
    .from('card_events')
    .select('id, kind, detail, actor_id, created_at, agent')
    .eq('card_id', assertId(cardId, 'card id'))
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) throw new Error(error.message);
  warnSlow(startedAt, `card events (${cardId})`);
  return (data ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    detail: (row.detail ?? {}) as Record<string, unknown>,
    actor_id: row.actor_id,
    created_at: row.created_at,
    agent: row.agent ?? false,
  }));
}

/** Best-effort event write — an audit row never blocks the mutation. */
async function logCardEvent(
  supabase: ReturnType<typeof createSupabaseRequestClient>,
  input: {
    cardId: string;
    boardId: string;
    actorId: string;
    kind: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { error } = await supabase.from('card_events').insert({
      card_id: input.cardId,
      board_id: input.boardId,
      actor_id: input.actorId,
      kind: input.kind,
      detail: (input.detail ?? {}) as Record<string, unknown> as never,
    });
    if (error) console.error('card event failed:', error.message);
  } catch (cause) {
    console.error('card event failed:', cause);
  }
}

/** The card's durable id: the given id, or — when the caller opened the
 *  card while its provisional (relayed) row was still in view — the row
 *  carrying the same client_op. RLS gates the fallback to visible cards. */ async function resolveCardId(
  supabase: ReturnType<typeof createSupabaseRequestClient>,
  cardId: string,
  clientOp?: string | null,
): Promise<string> {
  const { data } = await supabase.from('cards').select('id').eq('id', cardId).maybeSingle();
  if (data) return cardId;
  if (clientOp) {
    const fallback = await supabase
      .from('cards')
      .select('id')
      .eq('client_op', clientOp)
      .maybeSingle();
    if (fallback.data) return fallback.data.id;
  }
  return cardId; // not found — let the caller's write surface the error
}

/**
 * Resolve a card — hide it from the board without deleting anything
 * (the time capsule, 0059). The RPC checks access, stamps the card, and
 * logs the "resolved" event; the row stays fully editable.
 */
export async function resolveCard(cardId: string): Promise<void> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(cardId, 'card id');
  await requireUser(supabase);
  const { error } = await supabase.rpc('resolve_card', { p_card_id: id });
  if (error) throw new Error(error.message);
}

/**
 * Unresolve a card — back to its frozen list. The RPC heals the position
 * when the old slot collided with neighbors that moved, falls back to
 * the board's first list when the frozen list is gone (legacy), and logs
 * every part of it.
 */
export async function unresolveCard(cardId: string): Promise<void> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(cardId, 'card id');
  await requireUser(supabase);
  const { error } = await supabase.rpc('unresolve_card', { p_card_id: id });
  if (error) throw new Error(error.message);
}

/**
 * Move a card to a list at a fractional position. The client computes the
 * midpoint between neighbours (see board-store.ts); the server trusts the
 * number but re-validates the ids and, via RLS, that the caller is an
 * editor of the card's board.
 */
export async function moveCard(cardId: string, toListId: string, position: number) {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(cardId, 'card id');
  const listId = assertId(toListId, 'list id');
  const user = await requireUser(supabase);
  if (!Number.isFinite(position) || position <= 0 || position >= 1e15) {
    throw new Error('Invalid position');
  }
  // Timeline: read the source list BEFORE the write flips it.
  const [{ data: target }, { data: cardBefore }] = await Promise.all([
    supabase.from('lists').select('board_id, name').eq('id', listId).maybeSingle(),
    supabase.from('cards').select('board_id, lists(name)').eq('id', id).maybeSingle(),
  ]);
  if (!target) throw new Error('List not found');
  // A card's list must stay on the card's board — a cross-board list_id
  // would orphan the card between boards (the DB trigger double-checks).
  if (cardBefore && target.board_id !== cardBefore.board_id) {
    throw new Error('That list belongs to a different board');
  }
  // The time capsule (0059): resolved cards are hidden from the board —
  // they come back through unresolveCard, not by being moved in place.
  const { data: resolved } = await supabase
    .from('cards')
    .select('resolved_at')
    .eq('id', id)
    .maybeSingle();
  if (resolved?.resolved_at) throw friendlyError('This card is resolved — unresolve it first');
  const fromName =
    ((cardBefore?.lists as { name: string | null } | null | undefined)?.name as
      string | undefined) ?? null;
  const { error } = await supabase.from('cards').update({ list_id: listId, position }).eq('id', id);
  if (error) throw new Error(error.message);
  await logActivity(supabase, user.id, target.board_id, 'card.moved', {});
  // Only real list changes enter the timeline — same-list reorders are
  // noise (they'd drown the trail during a sort).
  if (fromName !== null && fromName !== target.name) {
    await logCardEvent(supabase, {
      cardId: id,
      boardId: target.board_id,
      actorId: user.id,
      kind: 'moved',
      detail: { from: fromName, to: target.name },
    });
  }
}

// ── comments ─────────────────────────────────────────────────────────────

/** The drawer's comment row. */
export type CommentRow = {
  id: string;
  body: string;
  author: string;
  created_at: string;
  /** Set when the body was edited after posting (the "(edited)" marker). */
  edited_at: string | null;
  /** True when posted through an MCP connection (an agent). */
  agent?: boolean;
  /** Server-assigned send order (chat_seq). Absent while a provisional
   * row has not been echoed by the database yet. */
  seq?: number | null;
  client_op: string | null;
  /** The author's id + avatar — the chat-style rendering needs both. */
  author_id: string | null;
  avatar_url: string | null;
  /** Tombstone: set when the row was deleted — the body reads empty and
   *  the UI renders the deletion trail instead. */
  deleted_at?: string | null;
  deleted_by?: string | null;
  deleted_as?: 'author' | 'owner' | 'admin' | 'team_admin' | null;
  deleted_as_team_id?: string | null;
};

/** One card's comments with author names, newest last. */
export async function getCardComments(
  cardId: string,
  cardClientOp?: string | null,
  /** Pagination cursor: only comments with a LOWER send sequence. */
  before?: number,
  /** Page size — long discussions load incrementally. */
  limit = 30,
): Promise<CommentRow[]> {
  'use server';
  const supabase = createSupabaseRequestClient();
  // A card opened mid-provisional still carries its temp id — resolve the
  // durable row by client_op (RLS gates the lookup to visible cards).
  const resolved = await resolveCardId(supabase, assertId(cardId, 'card id'), cardClientOp);
  let query = supabase
    .from('card_comments')
    .select(
      'id, body, created_at, edited_at, deleted_at, deleted_by, deleted_as, deleted_as_team_id, seq, client_op, user_id, agent, profiles!card_comments_user_id_fkey(display_name, avatar_url)',
    )
    .eq('card_id', resolved)
    .order('seq', { ascending: false })
    .limit(limit);
  if (before) query = query.lt('seq', before);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  // Newest-first from the database → chronological for display.
  return (data ?? [])
    .slice()
    .reverse()
    .map((row) => ({
      id: row.id,
      body: row.deleted_at ? '' : row.body,
      created_at: row.created_at,
      edited_at: row.edited_at,
      deleted_at: row.deleted_at,
      deleted_by: row.deleted_by,
      deleted_as: (row.deleted_as as CommentRow['deleted_as']) ?? null,
      deleted_as_team_id: row.deleted_as_team_id,
      seq: row.seq,
      agent: row.agent ?? false,
      client_op: row.client_op,
      author_id: row.user_id ?? null,
      avatar_url:
        (row.profiles as { display_name: string | null; avatar_url: string | null } | null)
          ?.avatar_url ?? null,
      author: (row.profiles as { display_name: string | null } | null)?.display_name ?? 'Someone',
    }));
}

/**
 * A card's comments as a live source: newest last, refreshed the moment a
 * comment lands. The drawer's engine drives this; the board relay makes
 * posting instant. Same producer pattern as boardStream.
 */
export const cardCommentsStream = live(async function* (
  cardId: string,
  cardClientOp?: string | null,
) {
  'use server';
  const supabase = createSupabaseRequestClient();
  // The card may still be known by its provisional (temp) id — resolve the
  // durable row BEFORE binding the channel filter, so the stream lives on
  // the real card's comments regardless of when the client-side echo swaps.
  const id = await resolveCardId(supabase, assertId(cardId, 'card id'), cardClientOp);

  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Sign in to view comments');

  const control = producerControls();
  const channel = supabase
    .channel(`comments:${id}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'card_comments', filter: `card_id=eq.${id}` },
      control.onChanged,
    )
    .on('system', {}, (payload: { status?: string; message?: string }) => {
      if (payload?.status === 'error') {
        console.error('[cardCommentsStream] realtime system error:', payload.message);
      }
    })
    .subscribe((status, err) => {
      if (err) console.error('cardCommentsStream channel error:', err);
      if (status === 'CHANNEL_ERROR') console.error('cardCommentsStream channel error status');
    });

  async function comments(): Promise<CommentRow[]> {
    // Latest page only — long discussions load older comments on demand
    // (the drawer's "load earlier" feeds them through the engine).
    const startedAt = Date.now();
    const { data, error } = await supabase
      .from('card_comments')
      .select(
        'id, body, created_at, edited_at, deleted_at, deleted_by, deleted_as, deleted_as_team_id, seq, client_op, user_id, agent, profiles!card_comments_user_id_fkey(display_name, avatar_url)',
      )
      .eq('card_id', id)
      .order('seq', { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    warnSlow(startedAt, `card comments page (${id})`);
    return (data ?? [])
      .slice()
      .reverse()
      .map((row) => ({
        id: row.id,
        body: row.deleted_at ? '' : row.body,
        created_at: row.created_at,
        edited_at: row.edited_at,
        deleted_at: row.deleted_at,
        deleted_by: row.deleted_by,
        deleted_as: (row.deleted_as as CommentRow['deleted_as']) ?? null,
        deleted_as_team_id: row.deleted_as_team_id,
        seq: row.seq,
        client_op: row.client_op,
        agent: row.agent ?? false,
        author_id: row.user_id ?? null,
        avatar_url:
          (row.profiles as { display_name: string | null; avatar_url: string | null } | null)
            ?.avatar_url ?? null,
        author: (row.profiles as { display_name: string | null } | null)?.display_name ?? 'Someone',
      }));
  }

  try {
    yield await comments();
    while (true) {
      if (!control.pending) {
        await new Promise<void>((resolve) => {
          control.wake = resolve;
        });
      }
      if (control.dead) return;
      control.pending = false;
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (!control.pending) {
        yield await comments();
      }
    }
  } finally {
    void supabase.removeChannel(channel);
  }
});

/** Post a comment. Returns the minted row (for instant relays). */
export async function addComment(
  cardId: string,
  body: string,
  clientOp?: string,
  cardClientOp?: string | null,
): Promise<{
  id: string;
  createdAt: string;
  author: string;
  authorId: string;
  avatarUrl: string | null;
}> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(cardId, 'card id');
  const text = cleanText(body, 'Comment', 4000);
  // The card may still be known by its provisional (temp) id — the durable
  // row carries the same client_op. RLS gates the fallback.
  const resolved = await resolveCardId(supabase, id, cardClientOp);
  const { data: card } = await supabase
    .from('cards')
    .select('board_id, created_by')
    .eq('id', resolved)
    .maybeSingle();
  if (!card) throw new Error('Card not found');
  const user = await requireUser(supabase);
  // Server-assigned send order: parallel posters serialize on the
  // per-card chat_seq counter, so a burst of comments keeps its order.
  const { data: seq, error: seqError } = await supabase.rpc('allocate_chat_seq', {
    p_kind: 'card_comment',
    p_scope: resolved,
  });
  if (seqError || seq == null) throw new Error(seqError?.message ?? 'sequence allocation failed');
  const { data: comment, error } = await supabase
    .from('card_comments')
    .insert({
      card_id: resolved,
      user_id: user.id,
      body: text,
      seq,
      ...(clientOp ? { client_op: clientOp } : {}),
    })
    .select(
      'id, created_at, user_id, profiles!card_comments_user_id_fkey(display_name, avatar_url)',
    )
    .single();
  if (error || !comment) throw new Error(error?.message ?? 'Could not post the comment');
  await logActivity(supabase, user.id, card.board_id, 'comment.created', {});
  // Notifications by each person's CARD level (the same Slack-style
  // settings as board chat): mentions stay loud; the card's followers
  // (creator + assignees) default to 'all' — quiet chat rows.
  try {
    const { data: assigneeRows } = await supabase
      .from('card_assignees')
      .select('user_id')
      .eq('card_id', resolved);
    const followers = [
      card.created_by ?? '',
      ...(assigneeRows ?? []).map((row) => row.user_id as string),
    ].filter(Boolean);
    const mentioned = mentionedUsers(text);
    const teamIds = mentionedTeams(text);
    // The audience: everyone who can see the board (blocked people are
    // surfaced to the AUTHOR instead — the drawer's access panel).
    const board = await supabase
      .from('boards')
      .select('workspace_id')
      .eq('id', card.board_id)
      .maybeSingle();
    const { data: memberRows } = await supabase
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', board.data?.workspace_id ?? '');
    const candidates = (memberRows ?? []).map((row) => row.user_id as string);
    const blocked = new Set(await filterInaccessible(supabase, card.board_id, candidates));
    const audience = candidates.filter((userId) => !blocked.has(userId));
    let teamMentions: string[] = [];
    if (teamIds.length > 0) {
      const { data: teamRows } = await supabase
        .from('team_members')
        .select('user_id')
        .in('team_id', teamIds);
      teamMentions = [...new Set((teamRows ?? []).map((row) => row.user_id as string))].filter(
        (userId) => audience.includes(userId),
      );
    }
    await notifyChatActivity(supabase, {
      scopeType: 'card',
      boardId: card.board_id,
      cardId: resolved,
      actorId: user.id,
      body: text,
      audience,
      directMentions: mentioned.filter((userId) => audience.includes(userId)),
      teamMentions,
      mentionsAll: mentionsAll(text),
      followers,
    });
  } catch (notifyError) {
    console.error('comment notifications failed:', notifyError);
  }
  // Mention backlinks: cards cited in the comment get a 'mentioned' row
  // in their own trail (best-effort — never blocks the comment). rpc()
  // reports failures in the result — it never throws.
  const { error: cardBacklinkError } = await supabase.rpc('log_card_mentions', {
    p_body: text,
    p_where: 'comment',
    p_board_id: card.board_id,
    p_card_id: resolved,
    p_source_id: comment.id,
  });
  if (cardBacklinkError) {
    console.error('comment mention backlinks failed:', cardBacklinkError.message);
  }
  // Board backlinks: boards cited in the comment get a message in their
  // own chat (best-effort — never blocks the comment).
  const { error: boardBacklinkError } = await supabase.rpc('log_board_mentions', {
    p_body: text,
    p_where: 'comment',
    p_board_id: card.board_id,
    p_card_id: resolved,
    p_source_id: comment.id,
  });
  if (boardBacklinkError) {
    console.error('comment board backlinks failed:', boardBacklinkError.message);
  }
  return {
    id: comment.id,
    createdAt: comment.created_at,
    authorId: comment.user_id ?? user.id,
    avatarUrl: (comment.profiles as { avatar_url: string | null } | null)?.avatar_url ?? null,
    author: (comment.profiles as { display_name: string | null } | null)?.display_name ?? 'Someone',
  };
}

/**
 * Edit a comment. RLS decides who may: the author always; anyone's for
 * workspace owners/admins (the same policies the MCP ops run under).
 * Edits stamp edited_at — the "(edited)" marker.
 */
export async function editComment(commentId: string, body: string): Promise<void> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(commentId, 'comment id');
  const text = cleanText(body, 'Comment', 4000);
  await requireUser(supabase);
  // An unchanged body is a no-op — no edit marker for a save that didn't
  // change anything.
  const { data: current } = await supabase
    .from('card_comments')
    .select('body, card_id, cards(board_id)')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!current) throw new Error('Comment not found or no access');
  if (current.body === text) return;
  const { data, error } = await supabase
    .from('card_comments')
    .update({ body: text, edited_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error('Comment not found or no access');
  // The EDIT writes backlinks too — idempotent on the comment anchor.
  const hostBoardId = (current.cards as { board_id: string } | null)?.board_id;
  if (hostBoardId) {
    const { error: cardBacklinkError } = await supabase.rpc('log_card_mentions', {
      p_body: text,
      p_where: 'comment',
      p_board_id: hostBoardId,
      p_card_id: current.card_id,
      p_source_id: id,
    });
    if (cardBacklinkError) {
      console.error('edit comment backlinks failed:', cardBacklinkError.message);
    }
    const { error: boardBacklinkError } = await supabase.rpc('log_board_mentions', {
      p_body: text,
      p_where: 'comment',
      p_board_id: hostBoardId,
      p_card_id: current.card_id,
      p_source_id: id,
    });
    if (boardBacklinkError) {
      console.error('edit comment board backlinks failed:', boardBacklinkError.message);
    }
  }
}

/**
 * Soft-delete a comment through the role-scoped RPC (0057): the author
 * always; anyone's for workspace owners/admins and team admins on
 * boards their team can edit. The row becomes a tombstone.
 */
export async function deleteComment(commentId: string): Promise<void> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(commentId, 'comment id');
  await requireUser(supabase);
  const { error } = await supabase.rpc('delete_comment', { p_id: id });
  if (error) throw new Error(error.message);
}

// ── board chat ────────────────────────────────────────────────────────────

/** A board-chat row — same shape as a comment, attached to the board. */
export type BoardMessageRow = {
  id: string;
  body: string;
  author: string;
  author_id: string | null;
  avatar_url: string | null;
  created_at: string;
  /** Server-assigned send order (chat_seq); absent while provisional. */
  seq?: number | null;
  client_op: string | null;
  /** True when posted through an MCP connection (an agent). */
  agent?: boolean;
  /** Set when the body was edited after posting (the "(edited)" marker). */
  edited_at: string | null;
  /** Tombstone: set when the row was deleted — the body reads empty and
   *  the UI renders the deletion trail instead. */
  deleted_at?: string | null;
  deleted_by?: string | null;
  deleted_as?: 'author' | 'owner' | 'admin' | 'team_admin' | null;
  deleted_as_team_id?: string | null;
};

/**
 * Chat sort key: durable rows sort by their server-assigned send
 * sequence; provisional rows (not yet echoed by the database) sort after
 * everything, by send time. created_at alone cannot order a burst of
 * messages sent within the same instant.
 */
export const chatSeq = (row: { seq?: number | null; created_at: string }): number =>
  row.seq != null ? row.seq : Number.MAX_SAFE_INTEGER;

async function boardChatSnapshot(
  supabase: ReturnType<typeof createSupabaseRequestClient>,
  boardId: string,
): Promise<BoardMessageRow[]> {
  const startedAt = Date.now();
  const { data, error } = await supabase
    .from('board_messages')
    .select(
      'id, body, created_at, edited_at, deleted_at, deleted_by, deleted_as, deleted_as_team_id, seq, client_op, user_id, agent, profiles!board_messages_user_id_fkey(display_name, avatar_url)',
    )
    .eq('board_id', boardId)
    .order('seq', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  warnSlow(startedAt, `board chat snapshot (${boardId})`);
  return (data ?? [])
    .slice()
    .reverse()
    .map((row) => ({
      id: row.id,
      body: row.deleted_at ? '' : row.body,
      created_at: row.created_at,
      edited_at: row.edited_at,
      deleted_at: row.deleted_at,
      deleted_by: row.deleted_by,
      deleted_as: (row.deleted_as as BoardMessageRow['deleted_as']) ?? null,
      deleted_as_team_id: row.deleted_as_team_id,
      seq: row.seq,
      agent: row.agent ?? false,
      client_op: row.client_op,
      author_id: row.user_id ?? null,
      avatar_url:
        (row.profiles as { display_name: string | null; avatar_url: string | null } | null)
          ?.avatar_url ?? null,
      author: (row.profiles as { display_name: string | null } | null)?.display_name ?? 'Someone',
    }));
}

/** The board's chat as a live source (same producer pattern as comments). */
export const boardChatStream = live(async function* (
  boardId: string,
): AsyncGenerator<BoardMessageRow[]> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(boardId, 'board id');
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Sign in to view this board');

  const control = producerControls();
  const channel = supabase
    .channel(`board-chat:${id}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'board_messages', filter: `board_id=eq.${id}` },
      control.onChanged,
    )
    .on('system', {}, (payload: { status?: string; message?: string }) => {
      if (payload?.status === 'error') {
        console.error('[boardChatStream] realtime system error:', payload.message);
      }
    })
    .subscribe((status, err) => {
      if (err) console.error('boardChatStream channel error:', err);
      if (status === 'CHANNEL_ERROR') console.error('boardChatStream channel error status');
    });

  try {
    yield await boardChatSnapshot(supabase, id);
    while (true) {
      if (!control.pending) {
        await new Promise<void>((resolve) => {
          control.wake = resolve;
        });
      }
      if (control.dead) return;
      control.pending = false;
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (!control.pending) {
        yield await boardChatSnapshot(supabase, id);
      }
    }
  } finally {
    void supabase.removeChannel(channel);
  }
});

/** The board's chat as a one-shot snapshot (the sync engine's refresh). */
export async function getBoardChatSnapshot(boardId: string): Promise<BoardMessageRow[]> {
  'use server';
  const supabase = createSupabaseRequestClient();
  return boardChatSnapshot(supabase, assertId(boardId, 'board id'));
}

/** Post to the board chat. Returns the minted row (for optimistic adds). */
export async function postBoardMessage(
  boardId: string,
  body: string,
  clientOp?: string,
): Promise<{
  id: string;
  createdAt: string;
  authorId: string;
  avatarUrl: string | null;
  author: string;
}> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(boardId, 'board id');
  const text = cleanText(body, 'Message', 4000);
  const user = await requireUser(supabase);
  // Server-assigned send order: parallel posters serialize on the
  // per-board chat_seq counter, so a burst of messages keeps its order.
  const { data: seq, error: seqError } = await supabase.rpc('allocate_chat_seq', {
    p_kind: 'board_message',
    p_scope: id,
  });
  if (seqError || seq == null) throw new Error(seqError?.message ?? 'sequence allocation failed');
  const { data: message, error } = await supabase
    .from('board_messages')
    .insert({
      board_id: id,
      user_id: user.id,
      body: text,
      seq,
      ...(clientOp ? { client_op: clientOp } : {}),
    })
    .select(
      'id, created_at, user_id, profiles!board_messages_user_id_fkey(display_name, avatar_url)',
    )
    .single();
  if (error || !message) throw new Error(error?.message ?? 'Could not post the message');
  await logActivity(supabase, user.id, id, 'chat.message', {});
  // Notifications by each person's board-chat level (Slack-style):
  // mentions stay loud, 'all' subscribers get quiet chat rows.
  try {
    const board = await supabase.from('boards').select('workspace_id').eq('id', id).maybeSingle();
    const { data: memberRows } = await supabase
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', board.data?.workspace_id ?? '');
    const candidates = (memberRows ?? []).map((row) => row.user_id as string);
    const blocked = new Set(await filterInaccessible(supabase, id, candidates));
    const audience = candidates.filter((userId) => !blocked.has(userId));
    const directMentions = mentionedUsers(text).filter((userId) => audience.includes(userId));
    const teamIds = mentionedTeams(text);
    let teamMentions: string[] = [];
    if (teamIds.length > 0) {
      const { data: teamRows } = await supabase
        .from('team_members')
        .select('user_id')
        .in('team_id', teamIds);
      teamMentions = [...new Set((teamRows ?? []).map((row) => row.user_id as string))].filter(
        (userId) => audience.includes(userId),
      );
    }
    await notifyChatActivity(supabase, {
      scopeType: 'board',
      boardId: id,
      cardId: null,
      actorId: user.id,
      body: text,
      audience,
      directMentions,
      teamMentions,
      mentionsAll: mentionsAll(text),
    });
  } catch (notifyError) {
    console.error('board chat notifications failed:', notifyError);
  }
  // Mention backlinks: cards cited in the message get a 'mentioned' row
  // in their own trail (best-effort — never blocks the message). rpc()
  // reports failures in the result — it never throws.
  const { error: cardBacklinkError } = await supabase.rpc('log_card_mentions', {
    p_body: text,
    p_where: 'chat',
    p_board_id: id,
    p_source_id: message.id,
  });
  if (cardBacklinkError) {
    console.error('chat mention backlinks failed:', cardBacklinkError.message);
  }
  // Board backlinks: boards cited in the message get a message in their
  // own chat (best-effort — never blocks the message).
  const { error: boardBacklinkError } = await supabase.rpc('log_board_mentions', {
    p_body: text,
    p_where: 'chat',
    p_board_id: id,
    p_source_id: message.id,
  });
  if (boardBacklinkError) {
    console.error('chat board backlinks failed:', boardBacklinkError.message);
  }
  return {
    id: message.id,
    createdAt: message.created_at,
    authorId: message.user_id ?? user.id,
    avatarUrl: (message.profiles as { avatar_url: string | null } | null)?.avatar_url ?? null,
    author: (message.profiles as { display_name: string | null } | null)?.display_name ?? 'Someone',
  };
}

/**
 * Edit a board message. RLS decides who may: the author always; anyone's
 * for workspace owners/admins (the same policies the MCP ops run under,
 * migration 0038). Edits stamp edited_at — the "(edited)" marker.
 */
export async function editBoardMessage(messageId: string, body: string): Promise<void> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(messageId, 'message id');
  const text = cleanText(body, 'Message', 4000);
  await requireUser(supabase);
  // An unchanged body is a no-op — no edit marker for a save that didn't
  // change anything.
  const { data: current } = await supabase
    .from('board_messages')
    .select('body, board_id')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!current) throw new Error('Message not found or no access');
  if (current.body === text) return;
  const { data, error } = await supabase
    .from('board_messages')
    .update({ body: text, edited_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error('Message not found or no access');
  // The EDIT writes backlinks too: a citation added by editing is a
  // live chip — its trail row and board message must exist behind it.
  // Both are idempotent on the message anchor.
  const { error: cardBacklinkError } = await supabase.rpc('log_card_mentions', {
    p_body: text,
    p_where: 'chat',
    p_board_id: current.board_id,
    p_source_id: id,
  });
  if (cardBacklinkError) {
    console.error('edit mention backlinks failed:', cardBacklinkError.message);
  }
  const { error: boardBacklinkError } = await supabase.rpc('log_board_mentions', {
    p_body: text,
    p_where: 'chat',
    p_board_id: current.board_id,
    p_source_id: id,
  });
  if (boardBacklinkError) {
    console.error('edit board backlinks failed:', boardBacklinkError.message);
  }
}

/**
 * Soft-delete a board message through the role-scoped RPC (0057): the
 * author always; anyone's for workspace owners/admins and team admins
 * on boards their team can edit. The row becomes a tombstone — who
 * deleted it and in what role — instead of vanishing.
 */
export async function deleteBoardMessage(messageId: string): Promise<void> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(messageId, 'message id');
  await requireUser(supabase);
  const { error } = await supabase.rpc('delete_board_message', { p_id: id });
  if (error) throw new Error(error.message);
}

// ── helpers ───────────────────────────────────────────────────────────────

async function requireUser(supabase: ReturnType<typeof createSupabaseRequestClient>) {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('Sign in first');
  return data.user;
}

/**
 * The workspace this device is pointed at: the cookie choice when it names
 * a workspace the caller belongs to, else null.
 */
async function currentWorkspaceId(
  supabase: ReturnType<typeof createSupabaseRequestClient>,
): Promise<string | null> {
  const event = getRequestEvent();
  const header = event?.request.headers.get('cookie') ?? '';
  const match = header.match(/(?:^|;\s*)fd_ws=([0-9a-f-]{36})/);
  const candidate = match?.[1];
  if (!candidate) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', candidate)
    // RLS shows peers' rows too — only MY membership makes a workspace
    // "current". A stale cookie (workspace deleted and recreated, or I
    // was removed from it) must NOT resolve.
    .eq('user_id', user.id)
    .maybeSingle();
  return data?.workspace_id ?? null;
}

async function logActivity(
  supabase: ReturnType<typeof createSupabaseRequestClient>,
  userId: string,
  boardId: string,
  type: string,
  payload: Record<string, string | number | boolean | null>,
) {
  // RLS: only members insert activity; the caller just performed a member
  // action, so their own identity satisfies the policy. Failures are
  // logged, not thrown — an activity row must never fail a mutation.
  const { error } = await supabase
    .from('activity')
    .insert({ board_id: boardId, user_id: userId, type, payload });
  if (error) console.error('activity log failed:', error.message);
}

// ── cross-board references + workspace search ─────────────────────────────

/** A card reference target: any card on any board this caller can see. */
export type CrossCard = {
  id: string;
  number: number | null;
  title: string;
  board_id: string;
  board_name: string;
};

/** Every card the caller can see across the workspace's boards — the
 *  chatbox's # dropdown (cross-board references) searches this list. */
export async function getCrossBoardCards(workspaceId: string): Promise<CrossCard[]> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const wsId = assertId(workspaceId, 'workspace id');
  const { data, error } = await supabase
    .from('cards')
    .select('id, number, title, boards!inner(id, name, workspace_id)')
    .eq('boards.workspace_id', wsId)
    .not('number', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => {
    const board = row.boards as unknown as { id: string; name: string };
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      board_id: board.id,
      board_name: board.name,
    };
  });
}

/** One search hit: a card across the workspace, with everything the
 *  results list shows. */
export type SearchHit = {
  id: string;
  number: number | null;
  title: string;
  board_id: string;
  board_name: string;
  priority: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Set when the card is resolved (hidden from its board — 0059). */
  resolved_at: string | null;
  assignees: string[];
  tags: { id: string; name: string }[];
  comment_count: number;
};

/** Workspace-wide card search — the GitHub-issues view: any card on any
 *  board the caller can see, filtered by text, tags, priority, assignee,
 *  creator, or board. RLS scopes every row. */
export async function searchCards(filters: {
  query?: string;
  tagIds?: string[];
  /** Legacy single-select values (kept for older callers). */
  priority?: string;
  assigneeId?: string;
  creatorId?: string;
  /** Multi-select facets; a '__none' entry means "missing this thing". */
  priorities?: string[];
  assigneeIds?: string[];
  creatorIds?: string[];
  boardId?: string;
  /** Multi-board facet (a superset of boardId). */
  boardIds?: string[];
  /** Resolved state (0059): unresolved (the default) / resolved / both. */
  resolved?: 'unresolved' | 'resolved' | 'both';
  /** Cardinality filters: cards missing the thing. */
  unassigned?: boolean;
  noPriority?: boolean;
  untagged?: boolean;
}): Promise<SearchHit[]> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const user = await requireUser(supabase);

  let query = supabase
    .from('cards')
    .select(
      'id, number, title, priority, resolved_at, created_by, created_at, updated_at, boards!inner(id, name), card_assignees(user_id), card_tags(tags(id, name))',
    )
    .order('updated_at', { ascending: false })
    .limit(200);
  // The time capsule (0059): the default view is unresolved cards only;
  // the resolved shelf and the "both" view opt in explicitly.
  if (filters.resolved !== 'both') {
    query =
      filters.resolved === 'resolved'
        ? query.not('resolved_at', 'is', null)
        : query.is('resolved_at', null);
  }
  if (filters.boardIds && filters.boardIds.length > 0) {
    query = query.in('board_id', filters.boardIds);
  }

  const text = filters.query?.trim();
  if (text) {
    const asNumber = text.startsWith('#') ? Number(text.slice(1)) : NaN;
    if (Number.isFinite(asNumber)) {
      query = query.eq('number', asNumber);
    } else {
      query = query.or(`title.ilike.%${text}%,description.ilike.%${text}%`);
    }
  }
  // Creator facet: multi-select union (legacy single value rides along).
  const creatorIds = [
    ...(filters.creatorIds ?? []),
    ...(filters.creatorId ? [filters.creatorId] : []),
  ].filter((id) => id && id !== '__none');
  if (creatorIds.length > 0) query = query.in('created_by', creatorIds);
  if (filters.boardId) query = query.eq('boards.id', filters.boardId);
  // Priority facet: a set of priorities plus (optionally) "no priority".
  const priorities = [
    ...(filters.priorities ?? []),
    ...(filters.priority && filters.priority !== '__none' ? [filters.priority] : []),
  ].filter((v) => v && v !== '__none');
  const includeNoPriority =
    (filters.priorities ?? []).includes('__none') ||
    filters.priority === '__none' ||
    filters.noPriority === true;
  // The pure "no priority" case is a cheap SQL filter; mixed selections
  // (some priorities + no priority) resolve in the post-filter below.
  if (priorities.length === 0 && includeNoPriority) query = query.is('priority', null);
  // Assignee facet: union of the selected people's cards; '__none' (the
  // "Unassigned" leading option) adds cards with no assignees. When it's
  // mixed with people, the SQL pre-filter can't express the union, so the
  // post-filter settles it.
  const assigneeIds = [
    ...(filters.assigneeIds ?? []),
    ...(filters.assigneeId ? [filters.assigneeId] : []),
  ].filter((id) => id && id !== '__none');
  const includeUnassigned =
    (filters.assigneeIds ?? []).includes('__none') || filters.unassigned === true;
  if (assigneeIds.length > 0 && !includeUnassigned) {
    const { data: mine } = await supabase
      .from('card_assignees')
      .select('card_id')
      .in('user_id', assigneeIds);
    query = query.in('id', [...new Set((mine ?? []).map((row) => row.card_id as string))]);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const tagFilter = new Set(filters.tagIds ?? []);
  return (data ?? [])
    .map((row) => {
      const board = row.boards as unknown as { id: string; name: string };
      const tags = ((row.card_tags ?? []) as { tags: { id: string; name: string } | null }[])
        .map((link) => link.tags)
        .filter((tag): tag is { id: string; name: string } => tag !== null);
      return {
        id: row.id,
        number: row.number,
        title: row.title,
        board_id: board.id,
        board_name: board.name,
        priority: row.priority,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        resolved_at: row.resolved_at,
        assignees: ((row.card_assignees ?? []) as { user_id: string }[]).map((a) => a.user_id),
        tags,
        comment_count: 0,
      };
    })
    .filter((hit) => {
      if (tagFilter.size > 0 && !hit.tags.some((tag) => tagFilter.has(tag.id))) return false;
      if (filters.unassigned && hit.assignees.length > 0) return false;
      if (filters.unassigned === false && hit.assignees.length === 0) return false;
      if (filters.untagged && hit.tags.length > 0) return false;
      if (priorities.length > 0 || includeNoPriority) {
        const ok =
          priorities.includes(hit.priority ?? '') || (includeNoPriority && hit.priority == null);
        if (!ok) return false;
      }
      if (assigneeIds.length > 0 || includeUnassigned) {
        const ok =
          hit.assignees.some((a) => assigneeIds.includes(a)) ||
          (includeUnassigned && hit.assignees.length === 0);
        if (!ok) return false;
      }
      return true;
    });
}

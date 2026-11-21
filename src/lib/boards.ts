// Flowdeck board data layer: server functions the UI calls directly.
//
// Reads run through the request-scoped Supabase client, so RLS decides
// what each caller sees (boards: only memberships; cards: only member
// boards). Mutations validate server-side, then log an activity row —
// the activity id doubles as the board's revision number, which the
// live stream carries so clients can tell when a change has been echoed
// by the database (see board-store.ts's `until` guards).
import { query } from '@solidjs/router';
import { live } from '@solidjs/web/server-functions';

import { createSupabaseRequestClient } from '../server/supabase';
import type { Database } from '../types/database.generated';

export type BoardSummary = Database['public']['Tables']['boards']['Row'];
export type ListRow = Database['public']['Tables']['lists']['Row'];
export type CardRow = Database['public']['Tables']['cards']['Row'];
export type ActivityRow = Database['public']['Tables']['activity']['Row'];

/** One consistent view of a board — the unit the live stream yields. */
export type BoardSnapshot = {
  board: BoardSummary;
  lists: ListRow[];
  cards: CardRow[];
  /** Latest activity id — monotonic per board, bumped by every mutation. */
  revision: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const { data, error } = await supabase
    .from('boards')
    .select('id, name, owner_id, created_at, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}, 'boards');

/** One board snapshot, for tests and one-off reads. */
export async function getBoardSnapshot(
  boardId: string,
): Promise<BoardSnapshot> {
  'use server';
  const supabase = createSupabaseRequestClient();
  return snapshot(supabase, assertId(boardId, 'board id'));
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
export const boardStream = live(async function* (
  boardId: string,
): AsyncGenerator<BoardSnapshot> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(boardId, 'board id');

  // The realtime socket signs on with the caller's token, and the
  // request-scoped client loads its session lazily from cookies — so the
  // session must be resident BEFORE the channel connects, or the socket
  // joins anonymously and RLS silently filters every event to nothing.
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Sign in to view this board');

  // Change notifications coalesced through a tiny promise handoff: the
  // loop sleeps until a postgres_changes event pings it.
  let wake: (() => void) | undefined;
  let pending = false;
  const onChanged = () => {
    pending = true;
    if (wake) {
      const w = wake;
      wake = undefined;
      w();
    }
  };

  const channel = supabase
    .channel(`board:${id}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'lists', filter: `board_id=eq.${id}` },
      onChanged,
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'cards', filter: `board_id=eq.${id}` },
      onChanged,
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'board_members', filter: `board_id=eq.${id}` },
      onChanged,
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'boards', filter: `id=eq.${id}` },
      onChanged,
    )
    .subscribe((status, err) => {
      // Observability: connection problems surface in dev logs and Workers
      // observability instead of failing silently.
      if (err) console.error('boardStream channel error:', err);
      if (status === 'CHANNEL_ERROR') console.error('boardStream channel error status');
      if (status === 'TIMED_OUT') console.error('boardStream channel timed out');
    });

  try {
    // Current value first — the reconnect contract.
    yield await snapshot(supabase, id);
    while (true) {
      if (!pending) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      pending = false;
      // Debounce bursts: one snapshot for a flurry of changes.
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (!pending) {
        yield await snapshot(supabase, id);
      }
      // A change that landed mid-snapshot leaves `pending` set and the
      // loop takes another turn immediately.
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
  const [boards, lists, cards, activity] = await Promise.all([
    supabase.from('boards').select('*').eq('id', boardId).maybeSingle(),
    supabase.from('lists').select('*').eq('board_id', boardId).order('position', { ascending: true }),
    supabase.from('cards').select('*').eq('board_id', boardId).order('position', { ascending: true }),
    supabase
      .from('activity')
      .select('id')
      .eq('board_id', boardId)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!boards.data) throw new Error('Board not found');
  return {
    board: boards.data,
    lists: lists.data ?? [],
    cards: cards.data ?? [],
    revision: activity.data?.id ?? 0,
  };
}

// ── board mutations ───────────────────────────────────────────────────────

const DEFAULT_LISTS = ['To do', 'In progress', 'Done'];

/** Create a board with default lists. Returns the new board id. */
export async function createBoard(name: string): Promise<string> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const user = await requireUser(supabase);
  const boardName = cleanText(name, 'Board name', 80);

  const { data: board, error } = await supabase
    .from('boards')
    .insert({ name: boardName, owner_id: user.id })
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
  return board!.id;
}

export async function renameBoard(boardId: string, name: string) {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(boardId, 'board id');
  const user = await requireUser(supabase);
  const boardName = cleanText(name, 'Board name', 80);
  const { error } = await supabase.from('boards').update({ name: boardName }).eq('id', id);
  if (error) throw new Error(error.message);
  await logActivity(supabase, user.id, id, 'board.renamed', { name: boardName });
}

export async function deleteBoard(boardId: string) {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(boardId, 'board id');
  await requireUser(supabase);
  const { error } = await supabase.from('boards').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ── list mutations ────────────────────────────────────────────────────────

export async function createList(boardId: string, name: string) {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(boardId, 'board id');
  const user = await requireUser(supabase);
  const listName = cleanText(name, 'List name', 80);
  const { data: last } = await supabase
    .from('lists')
    .select('position')
    .eq('board_id', id)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  const { error } = await supabase
    .from('lists')
    .insert({ board_id: id, name: listName, position: (last?.position ?? 0) + 1 });
  if (error) throw new Error(error.message);
  await logActivity(supabase, user.id, id, 'list.created', { name: listName });
}

export async function renameList(listId: string, name: string) {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(listId, 'list id');
  await requireUser(supabase);
  const listName = cleanText(name, 'List name', 80);
  const { error } = await supabase.from('lists').update({ name: listName }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteList(listId: string) {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(listId, 'list id');
  await requireUser(supabase);
  const { error } = await supabase.from('lists').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ── card mutations ────────────────────────────────────────────────────────

/** Add a card at the end of a list. Returns the card id. */
export async function createCard(listId: string, title: string): Promise<string> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(listId, 'list id');
  const user = await requireUser(supabase);
  const cardTitle = cleanText(title, 'Card title', 200);

  const { data: list } = await supabase
    .from('lists')
    .select('board_id')
    .eq('id', id)
    .maybeSingle();
  if (!list) throw new Error('List not found');

  const { data: last } = await supabase
    .from('cards')
    .select('position')
    .eq('list_id', id)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: card, error } = await supabase
    .from('cards')
    .insert({
      board_id: list.board_id,
      list_id: id,
      title: cardTitle,
      position: (last?.position ?? 0) + 1,
      created_by: user.id,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  await logActivity(supabase, user.id, list.board_id, 'card.created', { title: cardTitle });
  return card!.id;
}

export async function updateCard(
  cardId: string,
  patch: { title?: string; description?: string },
) {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(cardId, 'card id');
  await requireUser(supabase);
  const update: Partial<Pick<CardRow, 'title' | 'description'>> = {};
  if (patch.title !== undefined) update.title = cleanText(patch.title, 'Card title', 200);
  if (patch.description !== undefined)
    update.description = String(patch.description).slice(0, 8000);
  const { error } = await supabase.from('cards').update(update).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteCard(cardId: string) {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(cardId, 'card id');
  await requireUser(supabase);
  const { error } = await supabase.from('cards').delete().eq('id', id);
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
  const { data: list } = await supabase.from('lists').select('board_id').eq('id', listId).maybeSingle();
  if (!list) throw new Error('List not found');
  const { error } = await supabase
    .from('cards')
    .update({ list_id: listId, position })
    .eq('id', id);
  if (error) throw new Error(error.message);
  await logActivity(supabase, user.id, list.board_id, 'card.moved', {});
}

// ── comments ─────────────────────────────────────────────────────────────

/** A card's comments with author names, newest last. */
export const getCardComments = query(async (cardId: string) => {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data, error } = await supabase
    .from('card_comments')
    .select('id, body, created_at, profiles(display_name)')
    .eq('card_id', assertId(cardId, 'card id'))
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id,
    body: row.body,
    created_at: row.created_at,
    author: row.profiles?.display_name ?? 'Someone',
  }));
}, 'card-comments');

export async function addComment(cardId: string, body: string) {
  'use server';
  const supabase = createSupabaseRequestClient();
  const id = assertId(cardId, 'card id');
  const text = cleanText(body, 'Comment', 4000);
  const { data: card } = await supabase
    .from('cards')
    .select('board_id')
    .eq('id', id)
    .maybeSingle();
  if (!card) throw new Error('Card not found');
  const user = await requireUser(supabase);
  const { error } = await supabase.from('card_comments').insert({
    card_id: id,
    user_id: user.id,
    body: text,
  });
  if (error) throw new Error(error.message);
  await logActivity(supabase, user.id, card.board_id, 'comment.created', {});
}

// ── helpers ───────────────────────────────────────────────────────────────

async function requireUser(supabase: ReturnType<typeof createSupabaseRequestClient>) {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('Sign in first');
  return data.user;
}

async function logActivity(
  supabase: ReturnType<typeof createSupabaseRequestClient>,
  userId: string,
  boardId: string,
  type: string,
  payload: Record<string, string | number | boolean | null>,
) {  // RLS: only members insert activity; the caller just performed a member
  // action, so their own identity satisfies the policy. Failures are
  // logged, not thrown — an activity row must never fail a mutation.
  const { error } = await supabase
    .from('activity')
    .insert({ board_id: boardId, user_id: userId, type, payload });
  if (error) console.error('activity log failed:', error.message);
}

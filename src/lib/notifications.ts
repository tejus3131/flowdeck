// Notifications — the team heartbeat: mentions, assignments, and comments
// on cards someone follows become rows addressed to them. The dashboard's
// Updates section reads the inbox; the app-level feed turns fresh rows
// into toasts + sound (Slack-style).
import { live } from '@solidjs/web/server-functions';

import { producerControls } from './boards';
import { createSupabaseRequestClient, createSupabaseServiceClient } from '../server/supabase';

type Client = ReturnType<typeof createSupabaseRequestClient>;

export type NotificationRow = {
  id: string;
  kind:
    | 'mention'
    | 'assignment'
    | 'comment'
    | 'access_request'
    | 'access_provided'
    | 'access_denied'
    | 'access_granted'
    | 'access_revoked'
    | 'role_changed'
    | 'chat'
    | 'team_added'
    | 'team_removed'
    | 'invite';
  card_id: string | null;
  board_id: string | null;
  actor_id: string | null;
  /** Who the row is ABOUT (the user an access request concerns). */
  subject_id: string | null;
  body: string | null;
  created_at: string;
  seen_at: string | null;
  actor_name: string | null;
  /** The subject's CURRENT display name (access request rows). */
  subject_name: string | null;
  /** The TEAM a row is about, when it's a team request. */
  subject_team_id: string | null;
  subject_team_name: string | null;
  /** A direct click target (invites carry their accept URL). */
  href: string | null;
  card_number: number | null;
  card_title: string | null;
  board_name: string | null;
};

/** My inbox with everything a row's display needs (actor, card, board). */
export async function getMyInbox(): Promise<NotificationRow[]> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Sign in first');
  const { data, error } = await supabase
    .from('notifications')
    .select(
      'id, kind, card_id, board_id, actor_id, subject_id, subject_team_id, body, created_at, seen_at, href, actor_profile:profiles!notifications_actor_id_fkey(display_name), subject_profile:profiles!notifications_subject_id_fkey(display_name), subject_team:teams!notifications_subject_team_id_fkey(name), cards!card_id(number, title), boards!board_id(name)',
    )
    .eq('user_id', auth.user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row): NotificationRow => ({
    id: row.id,
    kind: row.kind as NotificationRow['kind'],
    card_id: row.card_id,
    board_id: row.board_id,
    actor_id: row.actor_id,
    subject_id: row.subject_id ?? null,
    subject_team_id: row.subject_team_id ?? null,
    href: row.href ?? null,
    subject_team_name:
      (row.subject_team as unknown as { name: string | null } | null)?.name ?? null,
    body: row.body,
    created_at: row.created_at,
    seen_at: row.seen_at,
    actor_name:
      (row.actor_profile as unknown as { display_name: string | null } | null)?.display_name ?? null,
    subject_name:
      (row.subject_profile as unknown as { display_name: string | null } | null)?.display_name ?? null,
    card_number: (row.cards as unknown as { number: number | null } | null)?.number ?? null,
    card_title: (row.cards as unknown as { title: string | null } | null)?.title ?? null,
    board_name: (row.boards as unknown as { name: string | null } | null)?.name ?? null,
  }));
}

/** Mark everything in my inbox read. */
export async function markInboxSeen(): Promise<void> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return;
  await supabase
    .from('notifications')
    .update({ seen_at: new Date().toISOString() })
    .eq('user_id', auth.user.id)
    .is('seen_at', null);
}

/** The inbox as a live source: first the current rows, then realtime. */
export const notificationsStream = live(async function* (): AsyncGenerator<NotificationRow[]> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Sign in first');

  const control = producerControls();

  const channel = supabase
    .channel('inbox')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${auth.user.id}` },
      control.onChanged,
    )
    .on('system', {}, (payload: { status?: string; message?: string }) => {
      if (payload?.status === 'error') {
        console.error('[notificationsStream] realtime system error:', payload.message);
      }
    })
    .subscribe((status, err) => {
      if (err) console.error('notificationsStream channel error:', err);
      if (status === 'TIMED_OUT') console.error('notificationsStream channel timed out');
    });

  async function snapshot(): Promise<NotificationRow[]> {
    const user = auth.user;
    if (!user) return [];
    const { data, error } = await supabase
      .from('notifications')
      .select(
        'id, kind, card_id, board_id, actor_id, subject_id, subject_team_id, body, created_at, seen_at, href, actor_profile:profiles!notifications_actor_id_fkey(display_name), subject_profile:profiles!notifications_subject_id_fkey(display_name), subject_team:teams!notifications_subject_team_id_fkey(name), cards!card_id(number, title), boards!board_id(name)',
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    const rows = (data ?? []).map((row): NotificationRow => ({
      id: row.id,
      kind: row.kind as NotificationRow['kind'],
      card_id: row.card_id,
      board_id: row.board_id,
      actor_id: row.actor_id,
      subject_id: row.subject_id ?? null,
      subject_team_id: row.subject_team_id ?? null,
      href: row.href ?? null,
      subject_team_name:
        (row.subject_team as unknown as { name: string | null } | null)?.name ?? null,
      body: row.body,
      created_at: row.created_at,
      seen_at: row.seen_at,
      actor_name:
        (row.actor_profile as unknown as { display_name: string | null } | null)?.display_name ??
        null,
      subject_name:
        (row.subject_profile as unknown as { display_name: string | null } | null)?.display_name ??
        null,
      card_number: (row.cards as unknown as { number: number | null } | null)?.number ?? null,
      card_title: (row.cards as unknown as { title: string | null } | null)?.title ?? null,
      board_name: (row.boards as unknown as { name: string | null } | null)?.name ?? null,
    }));
    // Profiles are only readable between WORKSPACE peers, so an actor the
    // recipient doesn't share a workspace with (an inviter, a cross-board
    // stranger) embeds as null. Names are the notification's whole story —
    // fill them from the service client (display names only).
    const missing = [
      ...new Set(
        rows
          .flatMap((row) => [row.actor_name ? null : row.actor_id, row.subject_name ? null : row.subject_id])
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
    if (missing.length > 0) {
      const { data: names } = await createSupabaseServiceClient()
        .from('profiles')
        .select('id, display_name')
        .in('id', missing);
      const byId = new Map((names ?? []).map((entry) => [entry.id, entry.display_name]));
      for (const row of rows) {
        if (!row.actor_name && row.actor_id) row.actor_name = byId.get(row.actor_id) ?? null;
        if (!row.subject_name && row.subject_id) row.subject_name = byId.get(row.subject_id) ?? null;
      }
    }
    return rows;
  }

  try {
    yield await snapshot();
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
        yield await snapshot();
      }
    }
  } finally {
    void supabase.removeChannel(channel);
  }
});

/** Mark one row read (a click-through). */
export async function markNotificationSeen(id: string): Promise<void> {
  'use server';
  const supabase = createSupabaseRequestClient();
  await supabase
    .from('notifications')
    .update({ seen_at: new Date().toISOString() })
    .eq('id', id);
}

/** Opening a card = seeing everything about it: auto-mark-read. */
export async function markCardNotificationsSeen(cardId: string): Promise<void> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return;
  await supabase
    .from('notifications')
    .update({ seen_at: new Date().toISOString() })
    .eq('user_id', auth.user.id)
    .eq('card_id', cardId)
    .is('seen_at', null);
}

/** Opening a board = seeing its board-level rows (access granted, access
 *  provided, requests you were shown) — auto-mark-read. Card rows stay
 *  unread until the card itself is opened. */
export async function markBoardNotificationsSeen(boardId: string): Promise<void> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return;
  await supabase
    .from('notifications')
    .update({ seen_at: new Date().toISOString() })
    .eq('user_id', auth.user.id)
    .eq('board_id', boardId)
    .is('card_id', null)
    .is('seen_at', null);
}

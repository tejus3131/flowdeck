// The mention-access flow — the "they can't see this board" moment.
//
// A mention on a board the mentioned user can't see never notifies them
// (boards.ts filters those out). Instead the author's drawer learns who
// was blocked and can, depending on the board's access_delegation
// setting (admins manage it in board settings):
//   * delegation ON (or the author is a workspace owner/admin): grant
//     board access + notify — the mention lands the moment access does;
//   * delegation OFF: ask the workspace owners/admins — every one of them
//     gets an access_request, and whoever acts first resolves it for
//     everyone: the request disappears from all their lists, the asker
//     is told, and the mentioned person finally gets their mention.
import { createSupabaseRequestClient } from '../server/supabase';
import {
  dismissAccessRequests,
  filterInaccessible,
  insertNotifications,
  type NewNotification,
} from '../server/notify';

/** A team mentioned on a board it can't see — the same panel as users. */
export type BlockedTeam = { teamId: string; name: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Someone the author mentioned who cannot see the board. */
export type BlockedMention = { userId: string; name: string };

/** Which of these mentioned users can't see the board (with names). */
export async function checkMentionAccess(
  boardId: string,
  userIds: string[],
): Promise<BlockedMention[]> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return [];
  if (!UUID.test(boardId)) return [];
  const ids = [...new Set(userIds)].filter((id) => UUID.test(id));
  if (ids.length === 0) return [];
  const blocked = await filterInaccessible(supabase, boardId, ids);
  if (blocked.length === 0) return [];
  const { data: members } = await supabase
    .from('workspace_members')
    .select('user_id, workspace_id, profiles(display_name, email)')
    .in('user_id', blocked)
    .order('created_at');
  const names = new Map(
    (members ?? []).map((row) => {
      const profile = row.profiles as { display_name: string | null; email: string | null } | null;
      return [
        row.user_id as string,
        profile?.display_name ?? profile?.email?.split('@')[0] ?? 'a member',
      ];
    }),
  );
  return blocked.map((userId) => ({ userId, name: names.get(userId) ?? 'a member' }));
}

/**
 * Grant board access to the blocked users and notify everyone: they get
 * their (withheld) mention + an access note, and the granter gets a
 * confirmation row. Board RLS enforces who may call this (delegation ON
 * + editor, or workspace owner/admin).
 */
export async function grantMentionAccess(input: {
  boardId: string;
  userIds: string[];
  cardId?: string | null;
  body?: string | null;
}): Promise<{ granted: BlockedMention[] }> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Sign in first');
  if (!UUID.test(input.boardId)) throw new Error('Invalid board id');
  const blocked = await checkMentionAccess(input.boardId, input.userIds);
  if (blocked.length === 0) return { granted: [] };
  const { error } = await supabase.from('board_access').upsert(
    blocked.map((person) => ({
      board_id: input.boardId,
      user_id: person.userId,
      access: 'edit' as const,
    })),
    { onConflict: 'board_id,user_id' },
  );
  if (error) throw new Error(error.message);
  const rows: NewNotification[] = [];
  for (const person of blocked) {
    // The withheld mention, delivered at last.
    rows.push({
      userId: person.userId,
      kind: 'mention',
      cardId: input.cardId ?? null,
      boardId: input.boardId,
      actorId: auth.user.id,
      body: input.body ?? null,
    });
    rows.push({
      userId: person.userId,
      kind: 'access_granted',
      boardId: input.boardId,
      actorId: auth.user.id,
      subjectId: null,
    });
    // The granter's confirmation ("you provided the access").
    rows.push({
      userId: auth.user.id,
      kind: 'access_provided',
      cardId: input.cardId ?? null,
      boardId: input.boardId,
      actorId: auth.user.id,
      subjectId: person.userId,
    });
  }
  await insertNotifications(rows);
  return { granted: blocked };
}

/**
 * Ask the workspace owners/admins to grant access: every one of them gets
 * an access_request notification (except the author). Any of them can
 * then grant or deny from their notification — resolving it dismisses it
 * from every admin's list at once.
 */
export async function requestMentionAccess(input: {
  boardId: string;
  userIds: string[];
  cardId?: string | null;
  body?: string | null;
}): Promise<{ asked: number }> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Sign in first');
  if (!UUID.test(input.boardId)) throw new Error('Invalid board id');
  const { data: board } = await supabase
    .from('boards')
    .select('workspace_id')
    .eq('id', input.boardId)
    .maybeSingle();
  if (!board?.workspace_id) throw new Error('Board not found');
  const blocked = await checkMentionAccess(input.boardId, input.userIds);
  if (blocked.length === 0) return { asked: 0 };
  const { data: admins } = await supabase
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', board.workspace_id)
    .in('role', ['owner', 'admin'])
    .neq('user_id', auth.user.id);
  const recipients = [...new Set((admins ?? []).map((row) => row.user_id as string))];
  if (recipients.length === 0) throw new Error('No workspace admins to ask');
  const rows: NewNotification[] = [];
  for (const adminId of recipients) {
    for (const person of blocked) {
      rows.push({
        userId: adminId,
        kind: 'access_request',
        cardId: input.cardId ?? null,
        boardId: input.boardId,
        actorId: auth.user.id,
        subjectId: person.userId,
        body: input.body ?? null,
      });
    }
  }
  await insertNotifications(rows);
  return { asked: recipients.length };
}

/**
 * An admin resolves an access request (a person OR a team): grant clears
 * it for every admin (the asker is told, the subject gets their mention +
 * access), deny clears it too (the asker is told). Server-side role
 * check — the UI only shows the buttons to owners/admins, but RLS isn't
 * available for notification writes, so this re-verifies.
 */
export async function resolveAccessRequest(input: {
  boardId: string;
  userId?: string | null;
  teamId?: string | null;
  grant: boolean;
}): Promise<{ ok: true }> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Sign in first');
  if (!UUID.test(input.boardId)) throw new Error('Invalid request');
  const isTeam = Boolean(input.teamId && UUID.test(input.teamId));
  if (!isTeam && !(input.userId && UUID.test(input.userId))) {
    throw new Error('Invalid request');
  }
  const { data: board } = await supabase
    .from('boards')
    .select('workspace_id')
    .eq('id', input.boardId)
    .maybeSingle();
  if (!board?.workspace_id) throw new Error('Board not found');
  const { data: me } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', board.workspace_id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (me?.role !== 'owner' && me?.role !== 'admin') {
    throw new Error('Only owners and admins can resolve access requests');
  }
  const pending =
    (await dismissAccessRequests(input.boardId, {
      userId: input.userId ?? null,
      teamId: input.teamId ?? null,
    })) ?? [];
  const rows: NewNotification[] = [];
  const askers = [
    ...new Set(pending.map((row) => row.actor_id).filter((id): id is string => !!id)),
  ];
  if (input.grant) {
    if (isTeam) {
      const { error } = await supabase
        .from('board_team_access')
        .upsert(
          { board_id: input.boardId, team_id: input.teamId!, access: 'edit' as const },
          { onConflict: 'board_id,team_id' },
        );
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase
        .from('board_access')
        .upsert(
          { board_id: input.boardId, user_id: input.userId!, access: 'edit' as const },
          { onConflict: 'board_id,user_id' },
        );
      if (error) throw new Error(error.message);
    }
    // Every asker learns the request succeeded ("you provided the access").
    for (const asker of askers) {
      rows.push({
        userId: asker,
        kind: 'access_provided',
        boardId: input.boardId,
        actorId: auth.user.id,
        subjectId: isTeam ? null : (input.userId ?? null),
        subjectTeamId: isTeam ? input.teamId : null,
        cardId: pending.find((row) => row.actor_id === asker)?.card_id ?? null,
      });
    }
    // The mentioned subject gets their mention — per card it happened on —
    // credited to whoever mentioned them, plus the access note.
    if (isTeam) {
      const { data: members } = await supabase
        .from('team_members')
        .select('user_id')
        .eq('team_id', input.teamId!);
      const memberIds = [...new Set((members ?? []).map((row) => row.user_id as string))];
      const mentionRows = pending.filter((row) => row.actor_id && row.card_id);
      for (const row of new Map(
        mentionRows.map((row) => [`${row.actor_id}:${row.card_id}`, row]),
      ).values()) {
        for (const memberId of memberIds) {
          rows.push({
            userId: memberId,
            kind: 'mention',
            cardId: row.card_id,
            boardId: input.boardId,
            actorId: row.actor_id,
          });
        }
      }
      for (const memberId of memberIds) {
        rows.push({
          userId: memberId,
          kind: 'access_granted',
          boardId: input.boardId,
          actorId: auth.user.id,
        });
      }
    } else {
      const mentionRows = pending.filter((row) => row.actor_id && row.card_id);
      for (const row of new Map(
        mentionRows.map((row) => [`${row.actor_id}:${row.card_id}`, row]),
      ).values()) {
        rows.push({
          userId: input.userId!,
          kind: 'mention',
          cardId: row.card_id,
          boardId: input.boardId,
          actorId: row.actor_id,
        });
      }
      rows.push({
        userId: input.userId!,
        kind: 'access_granted',
        boardId: input.boardId,
        actorId: auth.user.id,
      });
    }
  } else {
    for (const asker of askers) {
      rows.push({
        userId: asker,
        kind: 'access_denied',
        boardId: input.boardId,
        actorId: auth.user.id,
        subjectId: isTeam ? null : (input.userId ?? null),
        subjectTeamId: isTeam ? input.teamId : null,
      });
    }
  }
  await insertNotifications(rows);
  return { ok: true };
}

/** Which of these @mentioned teams can't see the board (with names)? */
export async function checkTeamMentionAccess(
  boardId: string,
  teamIds: string[],
): Promise<BlockedTeam[]> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return [];
  if (!UUID.test(boardId)) return [];
  const ids = [...new Set(teamIds)].filter((id) => UUID.test(id));
  if (ids.length === 0) return [];
  const { data: grants } = await supabase
    .from('board_team_access')
    .select('team_id')
    .eq('board_id', boardId)
    .in('team_id', ids);
  const granted = new Set((grants ?? []).map((row) => row.team_id as string));
  const blocked = ids.filter((id) => !granted.has(id));
  if (blocked.length === 0) return [];
  const { data: teams } = await supabase.from('teams').select('id, name').in('id', blocked);
  return (teams ?? []).map((team) => ({ teamId: team.id, name: team.name }));
}

/**
 * Grant the mentioned teams access and notify everyone: each member gets
 * their (withheld) mention + an access note, the granter gets one
 * confirmation row per team. RLS enforces who may call this.
 */
export async function grantTeamMentionAccess(input: {
  boardId: string;
  teamIds: string[];
  cardId?: string | null;
  body?: string | null;
}): Promise<{ granted: BlockedTeam[] }> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Sign in first');
  if (!UUID.test(input.boardId)) throw new Error('Invalid board id');
  const blocked = await checkTeamMentionAccess(input.boardId, input.teamIds);
  if (blocked.length === 0) return { granted: [] };
  const { error } = await supabase.from('board_team_access').upsert(
    blocked.map((team) => ({
      board_id: input.boardId,
      team_id: team.teamId,
      access: 'edit' as const,
    })),
    { onConflict: 'board_id,team_id' },
  );
  if (error) throw new Error(error.message);
  const rows: NewNotification[] = [];
  for (const team of blocked) {
    const { data: members } = await supabase
      .from('team_members')
      .select('user_id')
      .eq('team_id', team.teamId);
    for (const member of (members ?? []) as { user_id: string }[]) {
      // The withheld team mention, delivered at last.
      rows.push({
        userId: member.user_id,
        kind: 'mention',
        cardId: input.cardId ?? null,
        boardId: input.boardId,
        actorId: auth.user.id,
        body: input.body ?? null,
      });
      rows.push({
        userId: member.user_id,
        kind: 'access_granted',
        boardId: input.boardId,
        actorId: auth.user.id,
      });
    }
    rows.push({
      userId: auth.user.id,
      kind: 'access_provided',
      cardId: input.cardId ?? null,
      boardId: input.boardId,
      actorId: auth.user.id,
      subjectTeamId: team.teamId,
    });
  }
  await insertNotifications(rows);
  return { granted: blocked };
}

/**
 * Ask the workspace owners/admins to grant a TEAM access: every one of
 * them gets an access_request about the team, resolvable like the user
 * flavor (grant dismisses it from all their lists at once).
 */
export async function requestTeamMentionAccess(input: {
  boardId: string;
  teamIds: string[];
  cardId?: string | null;
  body?: string | null;
}): Promise<{ asked: number }> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Sign in first');
  if (!UUID.test(input.boardId)) throw new Error('Invalid board id');
  const { data: board } = await supabase
    .from('boards')
    .select('workspace_id')
    .eq('id', input.boardId)
    .maybeSingle();
  if (!board?.workspace_id) throw new Error('Board not found');
  const blocked = await checkTeamMentionAccess(input.boardId, input.teamIds);
  if (blocked.length === 0) return { asked: 0 };
  const { data: admins } = await supabase
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', board.workspace_id)
    .in('role', ['owner', 'admin'])
    .neq('user_id', auth.user.id);
  const recipients = [...new Set((admins ?? []).map((row) => row.user_id as string))];
  if (recipients.length === 0) throw new Error('No workspace admins to ask');
  const rows: NewNotification[] = [];
  for (const adminId of recipients) {
    for (const team of blocked) {
      rows.push({
        userId: adminId,
        kind: 'access_request',
        cardId: input.cardId ?? null,
        boardId: input.boardId,
        actorId: auth.user.id,
        subjectTeamId: team.teamId,
        body: input.body ?? null,
      });
    }
  }
  await insertNotifications(rows);
  return { asked: recipients.length };
}

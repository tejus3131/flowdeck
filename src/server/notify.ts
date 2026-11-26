// Server-only: fan notifications out to recipients. Called from inside
// addComment/updateCard and the mention-access flow — failures never
// break the write that caused them. Every insert also fires a web push
// to the recipient's browsers (best effort, prunes dead endpoints).
import 'server-only';

import { createSupabaseRequestClient, createSupabaseServiceClient } from './supabase';
import { pushToUsers, type PushPayload } from './push';

/** Parse mention targets from a markdown body ([Name](user:id) links). */
export function mentionedUsers(body: string): string[] {
  const ids: string[] = [];
  for (const match of body.matchAll(/\]\(user:([0-9a-f-]{36})\)/g)) {
    ids.push(match[1]);
  }
  return ids;
}

/** Parse TEAM mention targets ([Team](team:id) links). */
export function mentionedTeams(body: string): string[] {
  const ids: string[] = [];
  for (const match of body.matchAll(/\]\(team:([0-9a-f-]{36})\)/g)) {
    ids.push(match[1]);
  }
  return ids;
}

/** True when the text contains an @all broadcast ([All](all:everyone)). */
export function mentionsAll(body: string): boolean {
  return /\]\(all:everyone\)/i.test(body);
}

type Client = ReturnType<typeof createSupabaseRequestClient>;

/**
 * Which of these users CANNOT see the board — no per-board override and
 * neither workspace owner/admin nor the board owner (mirrors the
 * user_board_access() rules). A mention that lands on them must not
 * notify; the author gets the blocked list back instead.
 */
export async function filterInaccessible(
  supabase: Client,
  boardId: string,
  userIds: string[],
): Promise<string[]> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const { data: board } = await supabase
    .from('boards')
    .select('owner_id, workspace_id')
    .eq('id', boardId)
    .maybeSingle();
  if (!board?.workspace_id) return ids; // invisible/odd board — treat as blocked
  const { data: members } = await supabase
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', board.workspace_id)
    .in('user_id', ids);
  const roles = new Map((members ?? []).map((row) => [row.user_id as string, row.role as string]));
  const { data: overrides } = await supabase
    .from('board_access')
    .select('user_id')
    .eq('board_id', boardId)
    .in('user_id', ids);
  const granted = new Set((overrides ?? []).map((row) => row.user_id as string));
  // Team grants: membership in a team with access to this board counts.
  const { data: teamGrants } = await supabase
    .from('board_team_access')
    .select('team_id')
    .eq('board_id', boardId);
  const grantedTeams = new Set((teamGrants ?? []).map((row) => row.team_id as string));
  if (grantedTeams.size > 0) {
    const { data: teamRows } = await supabase
      .from('team_members')
      .select('team_id, user_id')
      .in('user_id', ids);
    for (const row of (teamRows ?? []) as { team_id: string; user_id: string }[]) {
      if (grantedTeams.has(row.team_id)) granted.add(row.user_id);
    }
  }
  return ids.filter((id) => {
    if (granted.has(id)) return false;
    if (board.owner_id === id) return false;
    const role = roles.get(id);
    return role !== 'owner' && role !== 'admin';
  });
}

// ── notification rows + their push payloads ────────────────────────────────

export type NotifyKind =
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
  | 'workspace_purged'
  | 'invite';

export type NewNotification = {
  userId: string;
  kind: NotifyKind;
  cardId?: string | null;
  boardId?: string | null;
  actorId?: string | null;
  /** Who the row is ABOUT (the person an access request concerns). */
  subjectId?: string | null;
  /** The TEAM a row is about (team access requests, team membership). */
  subjectTeamId?: string | null;
  /** A direct click target (invites carry their accept URL). */
  href?: string | null;
  body?: string | null;
};

type Ctx = {
  boardId: string | null;
  cardId: string | null;
  url: string;
  cardLabel: string;
  cardTitle: string;
  boardName: string;
  actorName: string;
  subjectName: string;
  teamName: string;
};

async function contextFor(supabase: Client, row: NewNotification): Promise<Ctx> {
  const boardId = row.boardId ?? null;
  const cardId = row.cardId ?? null;
  const actorId = row.actorId ?? null;
  const subjectId = row.subjectId ?? null;
  // Board-scope rows (chat + its mentions) land with the chat panel open.
  const url = boardId ? (cardId ? `/b/${boardId}?card=${cardId}` : `/b/${boardId}?chat=1`) : '/';
  const teamId = row.subjectTeamId ?? null;
  const [board, card, actor, subject, team] = await Promise.all([
    boardId
      ? supabase.from('boards').select('name').eq('id', boardId).maybeSingle()
      : Promise.resolve({ data: null }),
    cardId
      ? supabase.from('cards').select('number, title').eq('id', cardId).maybeSingle()
      : Promise.resolve({ data: null }),
    actorId
      ? supabase.from('profiles').select('display_name').eq('id', actorId).maybeSingle()
      : Promise.resolve({ data: null }),
    subjectId
      ? supabase.from('profiles').select('display_name').eq('id', subjectId).maybeSingle()
      : Promise.resolve({ data: null }),
    teamId
      ? supabase.from('teams').select('name').eq('id', teamId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const cardRow = card.data as { number: number | null; title: string | null } | null;
  const boardName = (board.data as { name: string | null } | null)?.name ?? 'a board';
  const cardLabel =
    cardRow?.number !== null && cardRow?.number !== undefined ? `#${cardRow.number}` : boardName;
  return {
    boardId: boardId,
    cardId: cardId,
    url,
    cardLabel,
    cardTitle: cardRow?.title ?? '',
    boardName,
    actorName: (actor.data as { display_name: string | null } | null)?.display_name ?? 'Someone',
    subjectName:
      (subject.data as { display_name: string | null } | null)?.display_name ?? 'someone',
    teamName: (team.data as { name: string | null } | null)?.name ?? 'a team',
  };
}

/** The OS-level notification text for a row addressed to `recipient`. */
function payloadFor(row: NewNotification, ctx: Ctx, recipient: string): PushPayload {
  const where = ctx.cardLabel;
  const fallbackBody = row.body ?? ctx.cardTitle;
  switch (row.kind) {
    case 'mention':
      return {
        title: `${ctx.actorName} mentioned you on ${where}`,
        body: fallbackBody,
        url: ctx.url,
        tag: row.cardId ?? row.boardId ?? row.kind,
      };
    case 'assignment':
      return {
        title: `${ctx.actorName} assigned you to ${where}`,
        body: ctx.cardTitle,
        url: ctx.url,
        tag: row.cardId ?? row.boardId ?? row.kind,
      };
    case 'comment':
      return {
        title: `${ctx.actorName} commented on ${where}`,
        body: fallbackBody,
        url: ctx.url,
        tag: row.cardId ?? row.boardId ?? row.kind,
      };
    case 'access_request':
      return {
        title: `${ctx.actorName} asked you to grant ${ctx.subjectName} access to ${ctx.boardName}`,
        body: fallbackBody,
        url: row.boardId ? `/b/${row.boardId}` : '/',
        tag: `${row.boardId}:${row.subjectId}:${row.subjectTeamId ?? ''}`,
      };
    case 'access_provided':
      return {
        title:
          recipient === row.actorId
            ? `You gave ${ctx.subjectName} access to ${ctx.boardName}`
            : `${ctx.actorName} granted ${ctx.subjectName} access to ${ctx.boardName}`,
        body: row.cardId ? `They can now see ${where}` : '',
        url: ctx.url,
        tag: `${row.boardId}:${row.subjectId}:provided`,
      };
    case 'access_denied':
      return {
        title: `${ctx.actorName} denied ${ctx.subjectName}'s access request`,
        body: `for ${ctx.boardName}`,
        url: '/',
        tag: `${row.boardId}:${row.subjectId}:${row.subjectTeamId ?? ''}:denied`,
      };
    case 'access_granted':
      return {
        title: `${ctx.actorName} gave you access to ${ctx.boardName}`,
        body: '',
        url: ctx.url,
        tag: row.boardId ?? row.kind,
      };
    case 'access_revoked':
      return {
        title: `${ctx.actorName} removed your access to ${ctx.boardName}`,
        body: '',
        url: '/',
        tag: row.boardId ?? row.kind,
      };
    case 'role_changed':
      return {
        title: `${ctx.actorName} made you ${row.body ?? 'a member'}`,
        body: '',
        url: '/',
        tag: 'role',
      };
    case 'chat':
      // Quiet activity — never pushed, shown in the inbox's chat section.
      return {
        title: `${ctx.actorName} on ${ctx.boardName}`,
        body: fallbackBody,
        url: ctx.url,
        tag: row.boardId ?? row.cardId ?? 'chat',
      };
    case 'team_added':
      return {
        title: `${ctx.actorName} added you to @${ctx.teamName}`,
        body: '',
        url: '/',
        tag: row.subjectTeamId ?? 'team',
      };
    case 'team_removed':
      return {
        title: `${ctx.actorName} removed you from @${ctx.teamName}`,
        body: '',
        url: '/',
        tag: row.subjectTeamId ?? 'team',
      };
    case 'workspace_purged':
      // 0071: the row is SQL-inserted by purge_workspace_boards, so it
      // never rides this path today — the shape keeps the unions honest.
      return {
        title: `${ctx.actorName} purged every board in this workspace`,
        body: row.body ?? '',
        url: '/',
        tag: 'workspace_purged',
      };
    case 'invite':
      return {
        title: `${ctx.actorName} invited you to ${row.body ?? 'a workspace'}`,
        body: 'Tap to accept',
        url: row.href ?? '/',
        tag: 'invite',
      };
  }
}

/**
 * Insert notification rows exactly as given (no self-filter — the access
 * flow legitimately notifies the actor) and web-push each recipient.
 * Best effort by contract: logged, never thrown.
 */
export async function insertNotifications(rows: NewNotification[]): Promise<void> {
  if (rows.length === 0) return;
  const supabase = createSupabaseRequestClient();
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    if (
      !row.userId ||
      seen.has(`${row.userId}:${row.kind}:${row.cardId ?? ''}:${row.subjectId ?? ''}`)
    ) {
      return false;
    }
    seen.add(`${row.userId}:${row.kind}:${row.cardId ?? ''}:${row.subjectId ?? ''}`);
    return true;
  });
  try {
    const { error } = await supabase.from('notifications').insert(
      unique.map((row) => ({
        user_id: row.userId,
        kind: row.kind,
        card_id: row.cardId ?? null,
        board_id: row.boardId ?? null,
        actor_id: row.actorId ?? null,
        subject_id: row.subjectId ?? null,
        subject_team_id: row.subjectTeamId ?? null,
        href: row.href ?? null,
        body: (row.body ?? '').slice(0, 200) || null,
      })),
    );
    if (error) {
      console.error('insertNotifications failed:', error.message);
      return;
    }
    // Pushes: one payload per recipient (self-addressed rows say "You").
    // 'chat' rows are the quiet section — they never push (Slack-style:
    // muted-channel activity doesn't reach your lock screen).
    await Promise.allSettled(
      unique
        .filter((row) => row.kind !== 'chat')
        .map(async (row) => {
          const ctx = await contextFor(supabase, row);
          await pushToUsers([row.userId], payloadFor(row, ctx, row.userId));
        }),
    );
  } catch (error) {
    console.error('insertNotifications failed:', error);
  }
}

export async function notifyUsers(input: {
  recipients: string[];
  kind: 'mention' | 'assignment' | 'comment';
  cardId: string;
  boardId: string;
  actorId: string;
  body?: string;
}): Promise<void> {
  const recipients = [...new Set(input.recipients)].filter(
    (userId) => userId && userId !== input.actorId,
  );
  await insertNotifications(
    recipients.map((userId) => ({
      userId,
      kind: input.kind,
      cardId: input.cardId,
      boardId: input.boardId,
      actorId: input.actorId,
      body: input.body ?? null,
    })),
  );
}

/**
 * A @team mention fans out to every member of the team — each as their OWN
 * notification row (Slack user-group behavior: one person marking it read
 * never touches anyone else's). Members who can't see the board (no team
 * grant, no personal access) are skipped, exactly like user mentions.
 */
export async function notifyTeamMentions(
  supabase: Client,
  input: {
    teamIds: string[];
    cardId: string | null;
    boardId: string;
    actorId: string;
    body?: string | null;
  },
): Promise<void> {
  if (input.teamIds.length === 0) return;
  const { data: memberRows } = await supabase
    .from('team_members')
    .select('user_id')
    .in('team_id', input.teamIds);
  const candidates = [...new Set((memberRows ?? []).map((row) => row.user_id as string))].filter(
    (userId) => userId && userId !== input.actorId,
  );
  if (candidates.length === 0) return;
  const invisible = new Set(await filterInaccessible(supabase, input.boardId, candidates));
  await insertNotifications(
    candidates
      .filter((userId) => !invisible.has(userId))
      .map((userId) => ({
        userId,
        kind: 'mention' as const,
        cardId: input.cardId,
        boardId: input.boardId,
        actorId: input.actorId,
        body: input.body ?? null,
      })),
  );
}

// ── the access flow's cross-user bookkeeping (service client) ─────────────

/**
 * Dismiss every pending access_request for (board, subject) from every
 * admin's list. The rows belong to several users, so this goes through
 * the service client — the one place the access flow touches other
 * people's rows, and only ever to remove a satisfied request.
 */
export async function dismissAccessRequests(
  boardId: string,
  subject: { userId?: string | null; teamId?: string | null },
): Promise<
  | {
      user_id: string;
      actor_id: string | null;
      card_id: string | null;
      subject_id: string | null;
      subject_team_id: string | null;
    }[]
  | null
> {
  const supabase = createSupabaseServiceClient();
  let select = supabase
    .from('notifications')
    .select('user_id, actor_id, card_id, subject_id, subject_team_id')
    .eq('kind', 'access_request')
    .eq('board_id', boardId)
    .is('seen_at', null);
  if (subject.teamId) select = select.eq('subject_team_id', subject.teamId);
  else select = select.eq('subject_id', subject.userId ?? '');
  const { data: rows, error } = await select;
  if (error) {
    console.error('dismissAccessRequests failed:', error.message);
    return null;
  }
  type Pending = {
    user_id: string;
    actor_id: string | null;
    card_id: string | null;
    subject_id: string | null;
    subject_team_id: string | null;
  };
  const pending = (rows ?? []) as Pending[];
  if (pending.length === 0) return null;
  let remove = supabase
    .from('notifications')
    .delete()
    .eq('kind', 'access_request')
    .eq('board_id', boardId)
    .in(
      'user_id',
      pending.map((row) => row.user_id),
    );
  if (subject.teamId) remove = remove.eq('subject_team_id', subject.teamId);
  else remove = remove.eq('subject_id', subject.userId ?? '');
  const { error: delError } = await remove;
  if (delError) console.error('dismissAccessRequests delete failed:', delError.message);
  return pending;
}

// ── Slack-style chat notification levels ───────────────────────────────────
// Per user, per scope (a board's chat or a card's comments):
//   all            — every message (as a quiet 'chat' row) + mentions
//   mentions_team  — direct + team mentions (loud)
//   direct         — direct mentions only
//   none           — nothing at all
// Mentions are loud at every level except none; 'chat' rows are the quiet
// inbox section (no sound, no toast, no push).

export type ChatLevel = 'all' | 'mentions_team' | 'direct' | 'none';

/** The user's effective level for a scope (their saved pref, or the
 *  default — 'all' for card followers, 'mentions_team' otherwise). */
export async function chatLevelFor(
  supabase: Client,
  userId: string,
  scopeType: 'board' | 'card',
  scopeId: string,
  defaultLevel: ChatLevel = 'mentions_team',
): Promise<ChatLevel> {
  const { data } = await supabase
    .from('chat_prefs')
    .select('level')
    .eq('user_id', userId)
    .eq('scope_type', scopeType)
    .eq('scope_id', scopeId)
    .maybeSingle();
  return (data?.level as ChatLevel | undefined) ?? defaultLevel;
}

/**
 * Fan a chat/comment out to its audience by each person's level.
 * `audience` must already be ACCESSIBLE (can see the board) and exclude
 * the author. Mentions (direct and team) always win over quiet rows;
 * direct mentions respect levels 'direct' and up, team mentions
 * 'mentions_team' and up.
 */
export async function notifyChatActivity(
  supabase: Client,
  input: {
    scopeType: 'board' | 'card';
    boardId: string;
    cardId?: string | null;
    actorId: string;
    body: string;
    audience: string[];
    directMentions: string[];
    teamMentions: string[];
    /** An @all broadcast: every audience member is a direct mention
     *  (people at 'none' still hear nothing — Slack's @channel rule). */
    mentionsAll?: boolean;
    /** Card followers (creator + assignees) default to 'all'. */
    followers?: string[];
  },
): Promise<void> {
  const followers = new Set(input.followers ?? []);
  const direct = new Set(input.directMentions);
  const teamMentioned = new Set(input.teamMentions);
  const rows: NewNotification[] = [];
  for (const userId of [...new Set(input.audience)]) {
    if (!userId || userId === input.actorId) continue;
    const level = await chatLevelFor(
      supabase,
      userId,
      input.scopeType,
      input.scopeType === 'board' ? input.boardId : (input.cardId ?? ''),
      followers.has(userId) ? 'all' : 'mentions_team',
    );
    if (level === 'none') continue;
    const base = {
      cardId: input.cardId ?? null,
      boardId: input.boardId,
      actorId: input.actorId,
      body: input.body.slice(0, 200),
    };
    if (direct.has(userId) || input.mentionsAll) {
      rows.push({ userId, kind: 'mention', ...base });
      continue;
    }
    if (teamMentioned.has(userId) && (level === 'mentions_team' || level === 'all')) {
      rows.push({ userId, kind: 'mention', ...base });
      continue;
    }
    if (level === 'all') {
      rows.push({ userId, kind: 'chat', ...base });
    }
  }
  await insertNotifications(rows);
}

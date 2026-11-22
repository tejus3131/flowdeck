// The workspace layer: memberships, roles, invites, per-board access.
// RLS is the security layer for every row op; these server functions add
// the human rules on top (owner-only actions, self-service limits, friendly
// errors) and send invite email through Resend when configured.
import { query } from '@solidjs/router';
import { getRequestEvent, redirect } from '@solidjs/web';
import { stringifySetCookie } from 'cookie';

import { createSupabaseRequestClient, createSupabaseServiceClient } from '../server/supabase';
import { filterInaccessible, insertNotifications } from '../server/notify';
import { env } from 'virtual:solid-env/server';
import { live } from '@solidjs/web/server-functions';
import { producerControls } from './boards';

export type WorkspaceRole = 'owner' | 'admin' | 'member';
export type InviteRole = 'admin' | 'member';

export const WORKSPACE_COOKIE = 'fd_ws';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── current workspace (cookie-persisted choice) ────────────────────────────

function readWorkspaceCookie(): string | null {
  const header = getRequestEvent()?.request.headers.get('cookie') ?? '';
  const match = header.match(/(?:^|;\s*)fd_ws=([0-9a-f-]{36})/);
  return match?.[1] ?? null;
}

async function myRoleIn(supabase: Awaited<ReturnType<typeof createSupabaseRequestClient>>, workspaceId: string): Promise<WorkspaceRole | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  // RLS shows every peer's membership row — filter to the caller's own or
  // maybeSingle() breaks the moment a second member joins.
  const { data } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle();
  return (data?.role as WorkspaceRole) ?? null;
}

// ── queries ────────────────────────────────────────────────────────────────

export type MyWorkspace = {
  id: string;
  name: string;
  role: WorkspaceRole;
  current: boolean;
  /** Who may create boards here (the GitHub org-style setting). */
  board_creation: 'admins' | 'team_admins' | 'everyone';
  /** Teams this user ADMINS in the workspace (creation targets). */
  team_admin_of: { id: string; name: string }[];
};

/** Every workspace I'm in, with the cookie-marked current choice. */
export const getMyWorkspaces = query(async (): Promise<MyWorkspace[]> => {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from('workspace_members')
    .select('role, workspaces(id, name, board_creation)')
    .eq('user_id', user.id) // RLS shows every peer's row too — keep only mine
    .order('created_at');
  // The teams this user administers, per workspace (creation powers).
  const { data: adminRows } = await supabase
    .from('team_members')
    .select('team_id, teams(id, name, workspace_id)')
    .eq('user_id', user.id)
    .eq('role', 'admin');
  const adminTeams = new Map<string, { id: string; name: string }[]>();
  for (const row of (adminRows ?? []) as {
    team_id: string;
    teams: { id: string; name: string; workspace_id: string | null } | null;
  }[]) {
    if (!row.teams?.workspace_id) continue;
    const bucket = adminTeams.get(row.teams.workspace_id) ?? [];
    bucket.push({ id: row.teams.id, name: row.teams.name });
    adminTeams.set(row.teams.workspace_id, bucket);
  }
  const current = readWorkspaceCookie();
  const list = (data ?? []).flatMap((row) => {
    // The generated types type the join as always-present; it isn't when
    // a membership row lost its workspace (impossible today, but typed so).
    const ws = row.workspaces as { id: string; name: string; board_creation: string } | null;
    return ws
      ? [
          {
            id: ws.id,
            name: ws.name,
            role: row.role as WorkspaceRole,
            current: false,
            board_creation: (ws.board_creation as MyWorkspace['board_creation']) ?? 'team_admins',
            team_admin_of: adminTeams.get(ws.id) ?? [],
          },
        ]
      : [];
  });
  // Only the cookie choice is "current" — a stale/absent cookie means
  // NO workspace is selected, and the dashboard shows the picker.
  return list.map((w) => ({ ...w, current: w.id === current }));
}, 'workspaces');

export type Member = {
  user_id: string;
  role: WorkspaceRole;
  display_name: string | null;
  username: string | null;
  email: string | null;
  avatar_url: string | null;
  created_at: string;
};

export type Invite = {
  id: string;
  email: string;
  role: InviteRole;
  token: string;
  created_at: string;
};

export type WorkspaceDetail = {
  workspace: {
    id: string;
    name: string;
    invite_domains: string[];
    board_creation: 'admins' | 'team_admins' | 'everyone';
  };
  myRole: WorkspaceRole | null;
  members: Member[];
  invites: Invite[];
  boards: { id: string; name: string }[];
  access: Record<string, 'edit' | 'view'>; // `${boardId}:${userId}` → override
  /** The workspace's tag vocabulary (stable rows shared by all cards). */
  tags: { id: string; name: string; description: string }[];
  /** Teams: the org's grouping layer (name, members, per-board grants). */
  teams: TeamView[];
  /** Decommissioned teams — kept so old mentions resolve; reinstatable. */
  deactivatedTeams: { id: string; name: string; deactivated_at: string }[];
  /** `${boardId}` → the teams with access to that board (and what level). */
  teamAccess: Record<string, { teamId: string; access: 'edit' | 'view' }[]>;
};

/** A team: who's on it (with their team role) and its identity. */
export type TeamView = {
  id: string;
  name: string;
  description: string;
  members: { user_id: string; role: 'admin' | 'member' }[];
};

/**
 * The workspace page's data, fetched under the caller's session: members,
 * invites (admins see pending ones — RLS), boards, per-board overrides.
 * Shared by the query (SSR + refresh), the plain snapshot fn (the sync
 * engine's refresh), and the live producer's snapshots.
 */
async function loadWorkspaceDetail(
  supabase: Awaited<ReturnType<typeof createSupabaseRequestClient>>,
  workspaceId: string,
): Promise<WorkspaceDetail | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const myRole = await myRoleIn(supabase, workspaceId);
  if (!myRole) return null;

  const [{ data: workspace }, { data: members }, { data: invites }, { data: boards }, { data: tags }] =
    await Promise.all([
      supabase.from('workspaces').select('id, name, invite_domains, board_creation').eq('id', workspaceId).maybeSingle(),
      supabase
        .from('workspace_members')
        .select(
          'user_id, role, created_at, profiles(display_name, username, email, avatar_url)',
        )
        .eq('workspace_id', workspaceId)
        .order('created_at'),
      // RLS hides pending invites from non-admins — that's fine, the UI
      // only shows them to owners/admins anyway.
      supabase
        .from('workspace_invites')
        .select('id, email, role, token, created_at')
        .eq('workspace_id', workspaceId)
        .eq('status', 'pending')
        .order('created_at'),
      supabase.from('boards').select('id, name').eq('workspace_id', workspaceId).order('name'),
      supabase
        .from('tags')
        .select('id, name, description')
        .eq('workspace_id', workspaceId)
        .order('name'),
    ]);

  // board_access rows for these boards. The API can't join through boards,
  // so fetch the rows this caller can see and filter to these boards —
  // editors of the boards (workspace admins/owners qualify) see them all.
  const boardIds = (boards ?? []).map((b) => b.id);
  let overrides: { board_id: string; user_id: string; access: 'edit' | 'view' }[] = [];
  if (boardIds.length > 0) {
    const { data: rows } = await supabase
      .from('board_access')
      .select('board_id, user_id, access');
    overrides = (rows ?? []).filter((r) => boardIds.includes(r.board_id)) as typeof overrides;
  }

  // Teams and their memberships; per-board team grants are filtered to
  // this workspace's boards (RLS shows what this viewer may see).
  const { data: teamRows } = await supabase
    .from('teams')
    .select('id, name, description, deactivated_at')
    .eq('workspace_id', workspaceId)
    .order('name');
  const deactivatedTeams = (teamRows ?? [])
    .filter((team) => team.deactivated_at !== null)
    .map((team) => ({
      id: team.id,
      name: team.name,
      deactivated_at: team.deactivated_at as string,
    }));
  const teamIds = (teamRows ?? []).map((t) => t.id);
  const [{ data: teamMemberRows }, { data: teamAccessRows }] = await Promise.all([
    teamIds.length > 0
      ? supabase.from('team_members').select('team_id, user_id, role').in('team_id', teamIds)
      : Promise.resolve({ data: [] as never[] }),
    boardIds.length > 0
      ? supabase.from('board_team_access').select('board_id, team_id, access')
      : Promise.resolve({ data: [] as never[] }),
  ]);
  const teamViews: TeamView[] = (teamRows ?? [])
    .filter((team) => team.deactivated_at === null)
    .map((team) => ({
    id: team.id,
    name: team.name,
    description: team.description ?? '',
    members: (teamMemberRows ?? [])
      .filter((row) => row.team_id === team.id)
      .map((row) => ({ user_id: row.user_id, role: row.role as 'admin' | 'member' })),
  }));
  const teamAccess: Record<string, { teamId: string; access: 'edit' | 'view' }[]> = {};
  for (const row of (teamAccessRows ?? []) as { board_id: string; team_id: string; access: 'edit' | 'view' }[]) {
    if (!boardIds.includes(row.board_id)) continue;
    const list = teamAccess[row.board_id] ?? [];
    list.push({ teamId: row.team_id, access: row.access });
    teamAccess[row.board_id] = list;
  }

  return {
    workspace: workspace
      ? { ...workspace, board_creation: (workspace.board_creation ?? 'team_admins') as WorkspaceDetail['workspace']['board_creation'] }
      : { id: workspaceId, name: '', invite_domains: [], board_creation: 'team_admins' },
    myRole,
    members: (members ?? []).map((m) => {
      const joined = m.profiles as {
        display_name: string | null;
        username: string | null;
        email: string | null;
        avatar_url: string | null;
      } | null;
      return {
        user_id: m.user_id,
        role: m.role as WorkspaceRole,
        display_name: joined?.display_name ?? null,
        username: joined?.username ?? null,
        email: joined?.email ?? null,
        avatar_url: joined?.avatar_url ?? null,
        created_at: m.created_at,
      };
    }),
    invites: (invites ?? []) as Invite[],
    boards: boards ?? [],
    access: Object.fromEntries(overrides.map((o) => [`${o.board_id}:${o.user_id}`, o.access])),
    tags: (tags ?? []) as { id: string; name: string; description: string }[],
    teams: teamViews,
    deactivatedTeams,
    teamAccess,
  };
}

/** The members/settings page data (SSR + the engine's refresh). */
export const getWorkspaceDetail = query(
  async (workspaceId: string): Promise<WorkspaceDetail | null> => {
    'use server';
    const supabase = createSupabaseRequestClient();
    return loadWorkspaceDetail(supabase, workspaceId);
  },
  'workspace-detail',
);

/** A one-shot durable snapshot for the sync engine's refresh path. */
export async function getWorkspaceSnapshot(
  workspaceId: string,
): Promise<WorkspaceDetail | null> {
  'use server';
  const supabase = createSupabaseRequestClient();
  return loadWorkspaceDetail(supabase, workspaceId);
}

/**
 * The caller's own membership row for the invite-accept relay: the newly
 * joined member announces themselves to everyone viewing the members page.
 */
export async function myProfileForRelay(
  workspaceId: string,
): Promise<{
  userId: string;
  role: WorkspaceRole;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
} | null> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const role = await myRoleIn(supabase, workspaceId);
  if (!role) return null;
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, email, avatar_url')
    .eq('id', user.id)
    .maybeSingle();
  return {
    userId: user.id,
    role,
    displayName: profile?.display_name ?? null,
    email: profile?.email ?? null,
    avatarUrl: profile?.avatar_url ?? null,
  };
}
/**
 * The workspace page as a live source: first the current detail, then a
 * fresh one on every membership/invite/access/board change. Same contract
 * as boardStream — per-viewer producer under the caller's JWT, RLS
 * decides visibility (non-admins simply see no pending invites).
 */
export const workspaceStream = live(
  async function* (workspaceId: string): AsyncGenerator<WorkspaceDetail> {
    'use server';
    const supabase = createSupabaseRequestClient();

    // An empty/unknown key (a board page before its snapshot lands) has no
    // workspace to watch — end quietly instead of binding uuid filters to
    // '' (a hard realtime error, and noise in every log).
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return;

    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) throw new Error('Sign in to view this workspace');

    const control = producerControls();

    const channel = supabase
      .channel(`ws-delta:${workspaceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'workspace_members', filter: `workspace_id=eq.${workspaceId}` },
        control.onChanged,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'workspace_invites', filter: `workspace_id=eq.${workspaceId}` },
        control.onChanged,
      )
      // Access overrides can target any board; the row-level filter can't
      // express "boards of this workspace", so the producer subscribes
      // broadly and the snapshot re-fetch filters (RLS limits what this
      // viewer sees anyway).
      .on('postgres_changes', { event: '*', schema: 'public', table: 'board_access' }, control.onChanged)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'workspaces', filter: `id=eq.${workspaceId}` },
        control.onChanged,
      )
      // The workspace's tag vocabulary changes reshuffle every tag picker.
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tags', filter: `workspace_id=eq.${workspaceId}` },
        control.onChanged,
      )
      // Teams re-shape the management surface live.
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'teams', filter: `workspace_id=eq.${workspaceId}` },
        control.onChanged,
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_members' }, control.onChanged)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'board_team_access' }, control.onChanged)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'boards', filter: `workspace_id=eq.${workspaceId}` },
        control.onChanged,
      )
      // A rejected binding surfaces only as a `system` error after the join
      // reply — log it loudly (see boardStream's hard-won lesson).
      .on('system', {}, (payload: { status?: string; message?: string }) => {
        if (payload?.status === 'error') {
          console.error('[workspaceStream] realtime system error:', payload.message);
        }
      })
      .subscribe((status, err) => {
        if (err) console.error('workspaceStream channel error:', err);
        if (status === 'CHANNEL_ERROR') console.error('workspaceStream channel error status');
        if (status === 'TIMED_OUT') console.error('workspaceStream channel timed out');
      });

    try {
      const first = await loadWorkspaceDetail(supabase, workspaceId);
      // The caller's membership can vanish (removed, left) — the stream
      // ends and the UI shows the not-a-member state via the engine's
      // refresh/merge of a null snapshot.
      if (!first) return;
      yield first;
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
          const next = await loadWorkspaceDetail(supabase, workspaceId);
          if (!next) return; // no longer a member — the stream ends
          yield next;
        }
      }
    } finally {
      void supabase.removeChannel(channel);
    }
  },
);

/** Watches MY membership rows: when one vanishes (removed, left, or the
 *  workspace was deleted — the cascade deletes memberships), every page
 *  hears about it and the app can fall back to the workspace picker. One
 *  yield per disappearance; the client decides what to do. */
export const myMembershipWatch = live(
  async function* (): AsyncGenerator<'removed'> {
    'use server';
    const supabase = createSupabaseRequestClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const control = producerControls();
    const channel = supabase
      .channel(`my-memberships:${user.id}`)
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'workspace_members', filter: `user_id=eq.${user.id}` },
        (payload) => {
          // The DELETE payload carries the row's key columns.
          const old = payload.old as { workspace_id?: string } | null;
          if (old?.workspace_id) control.onChanged();
        },
      )
      .on('system', {}, (payload: { status?: string; message?: string }) => {
        if (payload?.status === 'error') {
          console.error('[myMembershipWatch] realtime system error:', payload.message);
        }
      })
      .subscribe();
    try {
      while (true) {
        await new Promise<void>((resolve) => {
          control.wake = resolve;
        });
        if (control.dead) return;
        // A beat of quiet: a workspace delete cascades one membership per
        // member, and revalidating once is enough.
        await new Promise((resolve) => setTimeout(resolve, 200));
        yield 'removed';
      }
    } finally {
      void supabase.removeChannel(channel);
    }
  },
);

// ── mutations ──────────────────────────────────────────────────────────────
/** Remember the chosen workspace for this device (cookie), then refetch. */
export async function switchWorkspace(workspaceId: string): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const role = await myRoleIn(supabase, workspaceId);
  if (!role) throw new Error('You are not a member of that workspace');
  const event = getRequestEvent();
  event?.response.headers.append(
    'set-cookie',
    stringifySetCookie({ name: WORKSPACE_COOKIE, value: workspaceId, path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 }),
  );
  return true;
}

/** Create a workspace — the signer becomes its owner. New accounts start
 *  with nothing and create (or accept an invite to) one when ready. */
export async function createWorkspace(name: string): Promise<{ id: string }> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to sign in first');
  const clean = String(name ?? '').trim().slice(0, 80);
  if (!clean) throw new Error('Workspace name cannot be empty');
  const slug = `ws-${user.id.slice(0, 8)}-${Date.now().toString(36)}`;
  const { data, error } = await supabase
    .from('workspaces')
    .insert({ name: clean, slug, owner_id: user.id })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Could not create the workspace');
  const { error: memberError } = await supabase
    .from('workspace_members')
    .insert({ workspace_id: data.id, user_id: user.id, role: 'owner' });
  if (memberError) throw new Error(memberError.message);
  const event = getRequestEvent();
  event?.response.headers.append(
    'set-cookie',
    stringifySetCookie({ name: WORKSPACE_COOKIE, value: data.id, path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 }),
  );
  return { id: data.id };
}

/** Rename a workspace (owners only). */
export async function renameWorkspace(workspaceId: string, name: string): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  if (!UUID.test(workspaceId)) throw new Error('Invalid workspace');
  const role = await myRoleIn(supabase, workspaceId);
  if (role !== 'owner') throw new Error('Only owners can rename the workspace');
  const clean = String(name ?? '').trim().slice(0, 80);
  if (!clean) throw new Error('Workspace name cannot be empty');
  const { error } = await supabase.from('workspaces').update({ name: clean }).eq('id', workspaceId);
  if (error) throw new Error(error.message);
  return true;
}

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Set who may create boards in this workspace (owners only): owners and
 *  admins always can; "team_admins" adds team maintainers; "everyone"
 *  adds every member — the GitHub org setting. */
export async function updateBoardCreation(
  workspaceId: string,
  policy: 'admins' | 'team_admins' | 'everyone',
): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  if (!UUID.test(workspaceId)) throw new Error('Invalid workspace');
  const role = await myRoleIn(supabase, workspaceId);
  if (role !== 'owner') throw new Error('Only owners can change who can create boards');
  const { error } = await supabase
    .from('workspaces')
    .update({ board_creation: policy })
    .eq('id', workspaceId);
  if (error) throw new Error(error.message);
  return true;
}

/** Set the invite domain allowlist (owners only). Empty = any address may
 *  be invited; otherwise only addresses at these domains may be. */
export async function updateInviteDomains(
  workspaceId: string,
  domains: string[],
): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  if (!UUID.test(workspaceId)) throw new Error('Invalid workspace');
  const role = await myRoleIn(supabase, workspaceId);
  if (role !== 'owner') throw new Error('Only owners can manage the invite allowlist');
  const clean = [...new Set((domains ?? []).map((d) => String(d).trim().toLowerCase().replace(/^@/, '')))]
    .filter((d) => d.length > 0 && d.length <= 100 && DOMAIN.test(d))
    .slice(0, 50);
  const { error } = await supabase
    .from('workspaces')
    .update({ invite_domains: clean })
    .eq('id', workspaceId);
  if (error) throw new Error(error.message);
  return true;
}

/** Delete a workspace (owners only). Everything inside goes with it. */
export async function deleteWorkspace(workspaceId: string): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  if (!UUID.test(workspaceId)) throw new Error('Invalid workspace');
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to sign in first');
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('owner_id')
    .eq('id', workspaceId)
    .maybeSingle();
  if (!workspace) throw new Error('Workspace not found');
  if (workspace.owner_id !== user.id) {
    throw new Error('Only the workspace owner can delete it');
  }
  const { error } = await supabase.from('workspaces').delete().eq('id', workspaceId);
  if (error) throw new Error(error.message);
  if (readWorkspaceCookie() === workspaceId) {
    const event = getRequestEvent();
    event?.response.headers.append(
      'set-cookie',
      stringifySetCookie({ name: WORKSPACE_COOKIE, value: '', path: '/', sameSite: 'lax', maxAge: 0 }),
    );
  }
  return true;
}

async function sendInviteEmail(to: string, workspaceName: string, acceptUrl: string) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: [to],
        subject: `You're invited to "${workspaceName}" on Flowdeck`,
        html: [
          '<div style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">',
          `<h2 style="margin:0 0 8px">You've been invited to <b>${escapeHtml(workspaceName)}</b> on Flowdeck</h2>`,
          '<p style="color:#555;margin:0 0 20px">Flowdeck is a realtime kanban board your team can work on together.</p>',
          `<a href="${acceptUrl}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Accept invitation</a>`,
          `<p style="color:#999;font-size:12px;margin-top:20px">Or paste this link: ${acceptUrl}</p>`,
          '</div>',
        ].join(''),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Invite by email. Re-inviting the same email resets the pending invite with
 * a fresh token. Returns the invite row (id/token for instant relays) plus
 * the accept link so the UI can show a copyable fallback when email isn't
 * configured.
 */
export async function inviteMember(input: {
  workspaceId: string;
  email: string;
  role: InviteRole;
}): Promise<{ acceptUrl: string; emailed: boolean; id: string; token: string; createdAt: string }> {
  'use server';
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address');
  }
  const role: InviteRole = input.role === 'admin' ? 'admin' : 'member';

  const supabase = createSupabaseRequestClient();
  const myRole = await myRoleIn(supabase, input.workspaceId);
  if (myRole !== 'owner' && myRole !== 'admin') {
    throw new Error('Only owners and admins can invite people');
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to sign in first');

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('name, invite_domains')
    .eq('id', input.workspaceId)
    .maybeSingle();

  // Domain allowlist: when set, only these domains may be invited.
  const allowlist = (workspace?.invite_domains ?? []).filter(Boolean);
  if (allowlist.length > 0) {
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    if (!allowlist.includes(domain)) {
      throw new Error(
        `Only addresses at ${allowlist.join(', ')} can be invited to this workspace`,
      );
    }
  }

  // Reset-or-create: the unique (workspace_id, email) makes re-invites reuse
  // the row with a fresh token and pending status.
  // Already a member? Say so instead of sending a doomed invite.
  // The email→user lookup needs the service client: profiles are only
  // readable for people you SHARE a workspace with, and the invite target
  // by definition isn't a member yet — the user-scoped read always came
  // back null here, which silently skipped the invite notification.
  const admin = createSupabaseServiceClient();
  const { data: profile } = await admin
    .from('profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (profile?.id) {
    const { data: member } = await supabase
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', input.workspaceId)
      .eq('user_id', profile.id)
      .maybeSingle();
    if (member) throw new Error('That person is already in this workspace');
  }

  const { data: invite, error } = await supabase
    .from('workspace_invites')
    .upsert(
      {
        workspace_id: input.workspaceId,
        email,
        role,
        status: 'pending',
        invited_by: user.id,
      },
      { onConflict: 'workspace_id,email' },
    )
    .select('id, token, created_at')
    .single();
  if (error || !invite) throw new Error(error?.message ?? 'Could not create the invitation');

  // The in-app half of the invite: existing users hear about it in the
  // bell too (email still goes out separately when configured).
  if (profile?.id) {
    try {
      const acceptUrl = `${new URL(getRequestEvent()?.request.url ?? 'http://localhost:3000').origin}/invite/${invite.token}`;
      await insertNotifications([
        {
          userId: profile.id,
          kind: 'invite',
          actorId: user.id,
          body: workspace?.name ?? 'a workspace',
          href: acceptUrl,
        },
      ]);
    } catch (notifyError) {
      console.error('invite notification failed:', notifyError);
    }
  }

  const origin = new URL(getRequestEvent()?.request.url ?? 'http://localhost:3000').origin;
  const acceptUrl = `${origin}/invite/${invite.token}`;
  const emailed = await sendInviteEmail(email, workspace?.name ?? 'a workspace', acceptUrl);
  return {
    acceptUrl,
    emailed,
    id: invite.id,
    token: invite.token,
    createdAt: invite.created_at,
  };
}

export async function revokeInvite(inviteId: string): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { error } = await supabase.from('workspace_invites').delete().eq('id', inviteId);
  if (error) throw new Error(error.message);
  return true;
}


/** Remove a person's board overrides and team memberships in a workspace
 *  (used when they leave or are removed — a returning member starts
 *  fresh; their PROFILE stays, so old @mentions still name them). */
async function stripWorkspaceAccess(
  supabase: Awaited<ReturnType<typeof createSupabaseRequestClient>>,
  workspaceId: string,
  userId: string,
): Promise<void> {
  try {
    const { data: boards } = await supabase
      .from('boards')
      .select('id')
      .eq('workspace_id', workspaceId);
    const boardIds = (boards ?? []).map((board) => board.id);
    if (boardIds.length > 0) {
      await supabase.from('board_access').delete().eq('user_id', userId).in('board_id', boardIds);
    }
    const { data: teams } = await supabase
      .from('teams')
      .select('id')
      .eq('workspace_id', workspaceId);
    const teamIds = (teams ?? []).map((team) => team.id);
    if (teamIds.length > 0) {
      await supabase.from('team_members').delete().eq('user_id', userId).in('team_id', teamIds);
    }
  } catch (error) {
    console.error('stripWorkspaceAccess failed:', error);
  }
}

/**
 * Change a member's role. Owners manage the owner tier: promoting a member
 * grants co-ownership; demoting an owner is a transfer of responsibility —
 * another owner takes over workspaces.owner_id and the workspace always
 * keeps at least one owner. Nobody changes their own role here (leave or
 * transfer instead).
 */
export async function updateMemberRole(input: {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to sign in first');
  if (input.userId === user.id) throw new Error('You cannot change your own role');

  const myRole = await myRoleIn(supabase, input.workspaceId);
  if (myRole !== 'owner' && myRole !== 'admin') {
    throw new Error('Only owners and admins can change roles');
  }
  const { data: target } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', input.workspaceId)
    .eq('user_id', input.userId)
    .maybeSingle();
  if (!target) throw new Error('That person is not a member');

  // The owner tier is owner-managed: only an owner grants, changes or
  // takes away 'owner' — but any owner can, including for other owners.
  if ((input.role === 'owner' || target.role === 'owner') && myRole !== 'owner') {
    throw new Error('Only an owner can change owner access');
  }

  // Demoting an owner may not leave the workspace ownerless, and if the
  // demoted owner holds workspaces.owner_id, that pointer must move to a
  // remaining owner — the transfer part of the transfer.
  if (target.role === 'owner' && input.role !== 'owner') {
    const { data: otherOwners } = await supabase
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', input.workspaceId)
      .eq('role', 'owner')
      .neq('user_id', input.userId)
      .limit(1);
    if (!otherOwners || otherOwners.length === 0) {
      throw new Error('The workspace needs at least one owner — promote someone else first');
    }
    const { data: workspace } = await supabase
      .from('workspaces')
      .select('owner_id')
      .eq('id', input.workspaceId)
      .maybeSingle();
    if (workspace?.owner_id === input.userId) {
      const { error: moveError } = await supabase
        .from('workspaces')
        .update({ owner_id: otherOwners[0].user_id })
        .eq('id', input.workspaceId);
      if (moveError) throw new Error(moveError.message);
    }
  }

  const { error } = await supabase
    .from('workspace_members')
    .update({ role: input.role })
    .eq('workspace_id', input.workspaceId)
    .eq('user_id', input.userId);
  if (error) throw new Error(error.message);
  // Promoted to owner/admin? Strip their personal board overrides in this
  // workspace: a leftover 'view' from their member days outranks the role
  // in user_board_access() and would freeze them out of boards they now
  // administer. With the overrides gone, the role speaks for itself.
  if (input.role === 'owner' || input.role === 'admin') {
    try {
      const { data: boards } = await supabase
        .from('boards')
        .select('id')
        .eq('workspace_id', input.workspaceId);
      const ids = (boards ?? []).map((row) => row.id as string);
      if (ids.length > 0) {
        await supabase
          .from('board_access')
          .delete()
          .eq('user_id', input.userId)
          .in('board_id', ids);
      }
    } catch (stripError) {
      console.error('override strip on promotion failed:', stripError);
    }
  }
  // The person learns their new role wherever they are.
  try {
    await insertNotifications([
      {
        userId: input.userId,
        kind: 'role_changed',
        actorId: user.id,
        body: input.role === 'owner' ? 'an owner' : input.role === 'admin' ? 'an admin' : 'a member',
      },
    ]);
  } catch (notifyError) {
    console.error('role_changed notification failed:', notifyError);
  }
  return true;
}

/**
 * Leave a workspace (self-service). An owner can leave when another owner
    remains — the workspace's owner_id moves to them; the last owner must
    transfer or delete their account instead (no ownerless workspaces).
 */
export async function leaveWorkspace(workspaceId: string): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to sign in first');

  const myRole = await myRoleIn(supabase, workspaceId);
  if (!myRole) throw new Error('You are not a member of that workspace');

  if (myRole === 'owner') {
    const { data: otherOwners } = await supabase
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', workspaceId)
      .eq('role', 'owner')
      .neq('user_id', user.id)
      .limit(1);
    if (!otherOwners || otherOwners.length === 0) {
      throw new Error(
        "You're the only owner — promote someone else first, or delete your account to remove the workspace entirely",
      );
    }
    // The leaving owner may hold workspaces.owner_id — hand it over.
    const { data: workspace } = await supabase
      .from('workspaces')
      .select('owner_id')
      .eq('id', workspaceId)
      .maybeSingle();
    if (workspace?.owner_id === user.id) {
      const { error: moveError } = await supabase
        .from('workspaces')
        .update({ owner_id: otherOwners[0].user_id })
        .eq('id', workspaceId);
      if (moveError) throw new Error(moveError.message);
    }
  }

  const { error } = await supabase
    .from('workspace_members')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id);
  if (error) throw new Error(error.message);
  await stripWorkspaceAccess(supabase, workspaceId, user.id);

  // This device shouldn't stay pointed at a workspace it left.
  if (readWorkspaceCookie() === workspaceId) {
    const event = getRequestEvent();
    event?.response.headers.append(
      'set-cookie',
      stringifySetCookie({ name: WORKSPACE_COOKIE, value: '', path: '/', sameSite: 'lax', maxAge: 0 }),
    );
  }
  return true;
}

/**
 * Remove a member (admins only; owners must be demoted first — use the
 * role change, or the member leaves themselves). Self-exit goes through
 * leaveWorkspace, which handles the owner handover.
 */
export async function removeMember(input: {
  workspaceId: string;
  userId: string;
}): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to sign in first');
  if (input.userId === user.id) throw new Error('Use Leave workspace to remove yourself');

  const myRole = await myRoleIn(supabase, input.workspaceId);
  if (myRole !== 'owner' && myRole !== 'admin') {
    throw new Error('Only owners and admins can remove members');
  }
  // An owner must be demoted first — prevents ownerless workspaces and
  // non-owner admins booting an owner out from under the workspace.
  const { data: target } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', input.workspaceId)
    .eq('user_id', input.userId)
    .maybeSingle();
  if (!target) throw new Error('That person is not a member');
  if (target.role === 'owner') {
    throw new Error('An owner must be demoted first');
  }

  const { error } = await supabase
    .from('workspace_members')
    .delete()
    .eq('workspace_id', input.workspaceId)
    .eq('user_id', input.userId);
  if (error) throw new Error(error.message);
  await stripWorkspaceAccess(supabase, input.workspaceId, input.userId);
  return true;
}

/** Set (or clear with null) a member's per-board access override. When
 *  someone goes from NO access to some, they get an access_granted
 *  notification — the moment lands as a toast on whatever screen
 *  they're on. */
export async function setBoardAccess(input: {
  boardId: string;
  userId: string;
  access: 'edit' | 'view' | null;
}): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  if (input.access === null) {
    const { error } = await supabase
      .from('board_access')
      .delete()
      .eq('board_id', input.boardId)
      .eq('user_id', input.userId);
    if (error) throw new Error(error.message);
    // Tell the person when the revoke actually locked them out (people
    // whose role or team still grants access hear nothing).
    try {
      const {
        data: { user: actor },
      } = await supabase.auth.getUser();
      const blocked = await filterInaccessible(supabase, input.boardId, [input.userId]);
      if (actor && blocked.includes(input.userId)) {
        await insertNotifications([
          {
            userId: input.userId,
            kind: 'access_revoked',
            boardId: input.boardId,
            actorId: actor.id,
          },
        ]);
      }
    } catch (notifyError) {
      console.error('access_revoked notification failed:', notifyError);
    }
    return true;
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Was this their first access to the board? People whose role already
  // implies write (owners/admins/board owner) never need the note. The
  // previous state is read BEFORE the write.
  let firstGrant = false;
  if (user) {
    try {
      const { data: board } = await supabase
        .from('boards')
        .select('owner_id, workspace_id')
        .eq('id', input.boardId)
        .maybeSingle();
      const [{ data: member }, { data: previous }] = await Promise.all([
        supabase
          .from('workspace_members')
          .select('role')
          .eq('workspace_id', board?.workspace_id ?? input.boardId)
          .eq('user_id', input.userId)
          .maybeSingle(),
        supabase
          .from('board_access')
          .select('access')
          .eq('board_id', input.boardId)
          .eq('user_id', input.userId)
          .maybeSingle(),
      ]);
      const implicit =
        board?.owner_id === input.userId ||
        member?.role === 'owner' ||
        member?.role === 'admin';
      firstGrant = !previous && !implicit;
    } catch {
      firstGrant = false; // the note is a nicety; never block the grant
    }
  }
  const { error } = await supabase.from('board_access').upsert(
    {
      board_id: input.boardId,
      user_id: input.userId,
      access: input.access,
    },
    { onConflict: 'board_id,user_id' },
  );
  if (error) throw new Error(error.message);
  if (user && firstGrant) {
    try {
      await insertNotifications([
        {
          userId: input.userId,
          kind: 'access_granted',
          boardId: input.boardId,
          actorId: user.id,
        },
      ]);
    } catch (notifyError) {
      console.error('access_granted notification failed:', notifyError);
    }
  }
  return true;
}

/** Accept an invitation with its token; lands the user on the workspace. */
export async function acceptInvite(token: string): Promise<{ workspaceId: string }> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    // Sign-in first; the invite page keeps the token in the URL.
    throw redirect(`/sign-in?next=/invite/${token}`);
  }
  const { data, error } = await supabase.rpc('accept_workspace_invite', { p_token: token });
  if (error || !data) {
    throw new Error('That invite is invalid, revoked, or already used.');
  }
  // Switch this device to the newly joined workspace.
  const event = getRequestEvent();
  event?.response.headers.append(
    'set-cookie',
    stringifySetCookie({
      name: WORKSPACE_COOKIE,
      value: String(data),
      path: '/',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    }),
  );
  return { workspaceId: String(data) };
}

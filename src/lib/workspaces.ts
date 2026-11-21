// The workspace layer: memberships, roles, invites, per-board access.
// RLS is the security layer for every row op; these server functions add
// the human rules on top (owner-only actions, self-service limits, friendly
// errors) and send invite email through Resend when configured.
import { query } from '@solidjs/router';
import { getRequestEvent, redirect } from '@solidjs/web';
import { stringifySetCookie } from 'cookie';

import { createSupabaseRequestClient } from '../server/supabase';
import { env } from 'virtual:solid-env/server';

export type WorkspaceRole = 'owner' | 'admin' | 'member';
export type InviteRole = 'admin' | 'member';

export const WORKSPACE_COOKIE = 'fd_ws';

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
    .select('role, workspaces(id, name)')
    .eq('user_id', user.id) // RLS shows every peer's row too — keep only mine
    .order('created_at');
  const current = readWorkspaceCookie();
  const list = (data ?? []).flatMap((row) => {
    // The generated types type the join as always-present; it isn't when
    // a membership row lost its workspace (impossible today, but typed so).
    const ws = row.workspaces as { id: string; name: string } | null;
    return ws ? [{ id: ws.id, name: ws.name, role: row.role as WorkspaceRole, current: false }] : [];
  });
  const marked = list.map((w) => ({ ...w, current: w.id === current }));
  // No cookie (or stale cookie): the first workspace is current.
  if (!marked.some((w) => w.current) && marked.length > 0) marked[0].current = true;
  return marked;
}, 'workspaces');

export type Member = {
  user_id: string;
  role: WorkspaceRole;
  display_name: string | null;
  username: string | null;
  email: string | null;
  avatar_url: string | null;
};

export type Invite = {
  id: string;
  email: string;
  role: InviteRole;
  token: string;
  created_at: string;
};

export type WorkspaceDetail = {
  workspace: { id: string; name: string };
  myRole: WorkspaceRole;
  members: Member[];
  invites: Invite[];
  boards: { id: string; name: string }[];
  access: Record<string, 'edit' | 'view'>; // `${boardId}:${userId}` → override
};

/** The members/settings page data: members, pending invites, boards, overrides. */
export const getWorkspaceDetail = query(
  async (workspaceId: string): Promise<WorkspaceDetail | null> => {
    'use server';
    const supabase = createSupabaseRequestClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const myRole = await myRoleIn(supabase, workspaceId);
    if (!myRole) return null;

    const [{ data: workspace }, { data: members }, { data: invites }, { data: boards }] =
      await Promise.all([
        supabase.from('workspaces').select('id, name').eq('id', workspaceId).maybeSingle(),
        supabase
          .from('workspace_members')
          .select(
            'user_id, role, profiles(display_name, username, email, avatar_url)',
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

    return {
      workspace: workspace ?? { id: workspaceId, name: '' },
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
        };
      }),
      invites: (invites ?? []) as Invite[],
      boards: boards ?? [],
      access: Object.fromEntries(overrides.map((o) => [`${o.board_id}:${o.user_id}`, o.access])),
    };
  },
  'workspace-detail',
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
 * a fresh token. Returns the accept link so the UI can show a copyable
 * fallback when email isn't configured.
 */
export async function inviteMember(input: {
  workspaceId: string;
  email: string;
  role: InviteRole;
}): Promise<{ acceptUrl: string; emailed: boolean }> {
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
    .select('name')
    .eq('id', input.workspaceId)
    .maybeSingle();

  // Reset-or-create: the unique (workspace_id, email) makes re-invites reuse
  // the row with a fresh token and pending status.
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
    .select('id, token')
    .single();
  if (error || !invite) throw new Error(error?.message ?? 'Could not create the invitation');

  const origin = new URL(getRequestEvent()?.request.url ?? 'http://localhost:3000').origin;
  const acceptUrl = `${origin}/invite/${invite.token}`;
  const emailed = await sendInviteEmail(email, workspace?.name ?? 'a workspace', acceptUrl);
  return { acceptUrl, emailed };
}

export async function revokeInvite(inviteId: string): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { error } = await supabase.from('workspace_invites').delete().eq('id', inviteId);
  if (error) throw new Error(error.message);
  return true;
}

/**
 * Change a member's role. Only the owner can grant or take away 'owner';
 * nobody can change their own role here (leave instead).
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
  if (input.role === 'owner' && myRole !== 'owner') {
    throw new Error('Only the owner can grant owner access');
  }
  // Demoting an existing owner is also owner-only: check the target.
  const { data: target } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', input.workspaceId)
    .eq('user_id', input.userId)
    .maybeSingle();
  if (!target) throw new Error('That person is not a member');
  if (target.role === 'owner' && myRole !== 'owner') {
    throw new Error('Only the owner can change another owner');
  }

  const { error } = await supabase
    .from('workspace_members')
    .update({ role: input.role })
    .eq('workspace_id', input.workspaceId)
    .eq('user_id', input.userId);
  if (error) throw new Error(error.message);
  return true;
}

/** Remove a member (admins) or leave the workspace (self). Owners can't leave. */
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

  if (input.userId !== user.id) {
    const myRole = await myRoleIn(supabase, input.workspaceId);
    if (myRole !== 'owner' && myRole !== 'admin') {
      throw new Error('Only owners and admins can remove members');
    }
  }
  // Either way, an owner must first be demoted (by the owner) — prevents
  // ownerless workspaces and non-owner admins booting the owner.
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
  return true;
}

/** Set (or clear with null) a member's per-board access override. */
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
    return true;
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

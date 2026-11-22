// Teams — the GitHub org-teams model (per their docs): workspace
// owners/admins create teams; team admins (maintainers) manage
// membership; boards grant access to a team so every member inherits it;
// a board can belong to many teams. Team admins may also grant their
// team's access to boards they can edit.
import { createSupabaseRequestClient } from '../server/supabase';
import { filterInaccessible, insertNotifications } from '../server/notify';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Client = ReturnType<typeof createSupabaseRequestClient>;

async function requireUser(supabase: Client) {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('Sign in first');
  return data.user;
}

async function requireWsRole(
  supabase: Client,
  workspaceId: string,
  roles: string[],
): Promise<void> {
  const user = await requireUser(supabase);
  const { data } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!data || !roles.includes(data.role)) {
    throw new Error('Only workspace owners and admins can do that');
  }
}

async function teamWorkspaceId(supabase: Client, teamId: string): Promise<string> {
  const { data } = await supabase
    .from('teams')
    .select('workspace_id, deactivated_at')
    .eq('id', teamId)
    .maybeSingle();
  if (!data?.workspace_id) throw new Error('Team not found');
  return data.workspace_id;
}

/** The caller's workspace role, or null when not a member. */
async function myWsRole(
  supabase: Client,
  workspaceId: string,
): Promise<'owner' | 'admin' | 'member' | null> {
  const user = await requireUser(supabase);
  const { data } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle();
  return (data?.role as 'owner' | 'admin' | 'member' | undefined) ?? null;
}

/** Create a team (workspace owners/admins). The creator becomes its admin. */
export async function createTeam(input: {
  workspaceId: string;
  name: string;
  description?: string;
}): Promise<{ id: string }> {
  'use server';
  const supabase = createSupabaseRequestClient();
  if (!UUID.test(input.workspaceId)) throw new Error('Invalid workspace');
  await requireWsRole(supabase, input.workspaceId, ['owner', 'admin']);
  const name = String(input.name ?? '').trim().slice(0, 60);
  if (!name) throw new Error('Team name cannot be empty');
  const { data, error } = await supabase
    .from('teams')
    .insert({
      workspace_id: input.workspaceId,
      name,
      description: String(input.description ?? '').slice(0, 500),
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Could not create the team');
  // The workspace OWNER isn't auto-added: they manage every team through
  // workspace powers (the GitHub org-owner model) and stay out of the
  // member list — and out of @team mentions — unless they join on
  // purpose. Ws admins and team creators still become team admin.
  const user = await requireUser(supabase);
  const role = await myWsRole(supabase, input.workspaceId);
  if (role !== 'owner') {
    await supabase
      .from('team_members')
      .upsert(
        { team_id: data.id, user_id: user.id, role: 'admin' as const },
        { onConflict: 'team_id,user_id' },
      );
  }
  return { id: data.id };
}

/** Rename a team / edit its description (ws owner/admin or team admin). */
export async function updateTeam(input: {
  teamId: string;
  name?: string;
  description?: string;
}): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  if (!UUID.test(input.teamId)) throw new Error('Invalid team');
  await requireUser(supabase);
  const patch: { name?: string; description?: string } = {};
  if (input.name !== undefined) {
    const name = String(input.name ?? '').trim().slice(0, 60);
    if (!name) throw new Error('Team name cannot be empty');
    patch.name = name;
  }
  if (input.description !== undefined) {
    patch.description = String(input.description ?? '').slice(0, 500);
  }
  if (Object.keys(patch).length === 0) return true;
  const { error } = await supabase.from('teams').update(patch).eq('id', input.teamId);
  if (error) throw new Error(error.message);
  return true;
}

/** Decommission a team (workspace owners/admins): the row STAYS with a
 *  deactivated_at stamp — old @mentions keep resolving the name — while
 *  members and board grants are dropped (a reinstate starts fresh). */
export async function deleteTeam(teamId: string): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  if (!UUID.test(teamId)) throw new Error('Invalid team');
  const workspaceId = await teamWorkspaceId(supabase, teamId);
  await requireWsRole(supabase, workspaceId, ['owner', 'admin']);
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('teams')
    .update({ deactivated_at: now })
    .eq('id', teamId)
    .is('deactivated_at', null);
  if (error) throw new Error(error.message);
  // Fresh slate: no members, no board grants.
  await supabase.from('team_members').delete().eq('team_id', teamId);
  await supabase.from('board_team_access').delete().eq('team_id', teamId);
  return true;
}

/** Reinstate a decommissioned team: same id, same name — mentions in old
 *  messages link up again; membership is granted fresh. */
export async function reinstateTeam(teamId: string): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  if (!UUID.test(teamId)) throw new Error('Invalid team');
  const workspaceId = await teamWorkspaceId(supabase, teamId);
  await requireWsRole(supabase, workspaceId, ['owner', 'admin']);
  const { error } = await supabase
    .from('teams')
    .update({ deactivated_at: null })
    .eq('id', teamId)
    .not('deactivated_at', 'is', null);
  if (error) throw new Error(error.message);
  return true;
}

/** Add a member to a team (ws owner/admin or team admin). */
export async function addTeamMember(input: {
  teamId: string;
  userId: string;
  role?: 'admin' | 'member';
}): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  if (!UUID.test(input.teamId) || !UUID.test(input.userId)) throw new Error('Invalid member');
  await requireUser(supabase);
  const workspaceId = await teamWorkspaceId(supabase, input.teamId);
  // The person must belong to the workspace.
  const { data: member } = await supabase
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', input.userId)
    .maybeSingle();
  if (!member) throw new Error('That person is not a workspace member');
  const { error } = await supabase.from('team_members').upsert(
    {
      team_id: input.teamId,
      user_id: input.userId,
      role: input.role === 'admin' ? 'admin' : 'member',
    },
    { onConflict: 'team_id,user_id' },
  );
  if (error) throw new Error(error.message);
  // The person learns they're on the team (a toast wherever they are).
  try {
    const actor = await requireUser(supabase);
    await insertNotifications([
      {
        userId: input.userId,
        kind: 'team_added',
        actorId: actor.id,
        subjectTeamId: input.teamId,
      },
    ]);
  } catch (notifyError) {
    console.error('team_added notification failed:', notifyError);
  }
  return true;
}

/** Change a member's team role (ws owner/admin, or team admin for members). */
export async function setTeamMemberRole(input: {
  teamId: string;
  userId: string;
  role: 'admin' | 'member';
}): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  if (!UUID.test(input.teamId) || !UUID.test(input.userId)) throw new Error('Invalid member');
  await requireUser(supabase);
  const { error } = await supabase
    .from('team_members')
    .update({ role: input.role })
    .eq('team_id', input.teamId)
    .eq('user_id', input.userId);
  if (error) throw new Error(error.message);
  return true;
}

/** Remove a member from a team (ws owner/admin, or team admin for members). */
export async function removeTeamMember(input: {
  teamId: string;
  userId: string;
}): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  if (!UUID.test(input.teamId) || !UUID.test(input.userId)) throw new Error('Invalid member');
  await requireUser(supabase);
  const { error } = await supabase
    .from('team_members')
    .delete()
    .eq('team_id', input.teamId)
    .eq('user_id', input.userId);
  if (error) throw new Error(error.message);
  try {
    const actor = await requireUser(supabase);
    await insertNotifications([
      {
        userId: input.userId,
        kind: 'team_removed',
        actorId: actor.id,
        subjectTeamId: input.teamId,
      },
    ]);
  } catch (notifyError) {
    console.error('team_removed notification failed:', notifyError);
  }
  return true;
}

/**
 * Grant (or clear with null) a team's access to a board. Members who
 * gain or lose their ONLY way in are notified (the access-change rule,
 * team edition).
 */
export async function setBoardTeamAccess(input: {
  boardId: string;
  teamId: string;
  access: 'edit' | 'view' | null;
}): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  if (!UUID.test(input.boardId) || !UUID.test(input.teamId)) throw new Error('Invalid grant');
  const user = await requireUser(supabase);
  const { data: members } = await supabase
    .from('team_members')
    .select('user_id')
    .eq('team_id', input.teamId);
  const memberIds = (members ?? []).map((row) => row.user_id as string);
  if (input.access === null) {
    const { error } = await supabase
      .from('board_team_access')
      .delete()
      .eq('board_id', input.boardId)
      .eq('team_id', input.teamId);
    if (error) throw new Error(error.message);
    // Who actually lost access? Those now blocked (no override, no role).
    const affected = await filterInaccessible(supabase, input.boardId, memberIds);
    if (affected.length > 0) {
      await insertNotifications(
        affected.map((userId) => ({
          userId,
          kind: 'access_revoked' as const,
          boardId: input.boardId,
          actorId: user.id,
        })),
      );
    }
    return true;
  }
  // Grant: notify members who couldn't see the board before.
  const gaining = await filterInaccessible(supabase, input.boardId, memberIds);
  const { error } = await supabase.from('board_team_access').upsert(
    {
      board_id: input.boardId,
      team_id: input.teamId,
      access: input.access,
    },
    { onConflict: 'board_id,team_id' },
  );
  if (error) throw new Error(error.message);
  if (gaining.length > 0) {
    await insertNotifications(
      gaining.map((userId) => ({
        userId,
        kind: 'access_granted' as const,
        boardId: input.boardId,
        actorId: user.id,
      })),
    );
  }
  return true;
}

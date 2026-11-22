// The public profile view: identity, live status, and the teams we share
// (scoped to MY workspaces — the page is reachable for people you can
// already see). Also powers the hover card's richer, future home.
import { createSupabaseRequestClient } from '../server/supabase';

export type SharedTeam = {
  workspaceId: string;
  workspaceName: string;
  teamId: string;
  teamName: string;
  role: 'admin' | 'member';
};

export type PublicProfile = {
  id: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  status: { emoji: string | null; label: string | null; dnd: boolean; clearAt: string | null } | null;
  teams: SharedTeam[];
};

export async function userProfile(userId: string): Promise<PublicProfile | null> {
  'use server';
  const supabase = createSupabaseRequestClient();
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  // RLS shows only peers (plus yourself) — a non-peer renders as null.
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, display_name, email, avatar_url')
    .eq('id', userId)
    .maybeSingle();
  if (!profile) return null;
  // Live status (expiry respected).
  let status: PublicProfile['status'] = null;
  const { data: statusRow } = await supabase
    .from('user_status')
    .select('emoji, label, clear_at, dnd')
    .eq('user_id', userId)
    .maybeSingle();
  if (
    statusRow &&
    (statusRow.clear_at === null || new Date(statusRow.clear_at).getTime() > Date.now())
  ) {
    status = {
      emoji: statusRow.emoji ?? null,
      label: statusRow.label ?? null,
      dnd: statusRow.dnd ?? false,
      clearAt: statusRow.clear_at ?? null,
    };
  }
  // The teams we share: their team rows in MY workspaces.
  const teams: SharedTeam[] = [];
  try {
    const { data: mine } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', user.id);
    const wsIds = (mine ?? []).map((row) => row.workspace_id as string);
    if (wsIds.length > 0) {
      const { data: teamRows } = await supabase
        .from('teams')
        .select('id, name, workspace_id, workspaces(name)')
        .in('workspace_id', wsIds)
        .is('deactivated_at', null);
      const byId = new Map(
        (teamRows ?? []).map((team) => [
          team.id as string,
          {
            teamName: team.name as string,
            workspaceId: team.workspace_id as string,
            workspaceName:
              (team.workspaces as unknown as { name: string | null } | null)?.name ?? '',
          },
        ]),
      );
      if (byId.size > 0) {
        const { data: memberRows } = await supabase
          .from('team_members')
          .select('team_id, role')
          .eq('user_id', userId)
          .in('team_id', [...byId.keys()]);
        for (const row of memberRows ?? []) {
          const team = byId.get(row.team_id as string);
          if (!team) continue;
          teams.push({
            workspaceId: team.workspaceId,
            workspaceName: team.workspaceName,
            teamId: row.team_id as string,
            teamName: team.teamName,
            role: (row.role as 'admin' | 'member') ?? 'member',
          });
        }
      }
    }
  } catch {
    // teams are decoration on the profile — never fatal
  }
  return {
    id: profile.id,
    display_name: profile.display_name ?? null,
    email: profile.email ?? null,
    avatar_url: profile.avatar_url ?? null,
    status,
    teams: teams.sort((a, b) => a.teamName.localeCompare(b.teamName)),
  };
}

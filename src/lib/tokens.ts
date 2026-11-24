// MCP connections: the credential surface of the OAuth consent flow.
// Tokens are ONLY minted there (the browser flow exchanges a one-time
// authorization code); the plaintext is shown exactly once and only its
// sha256 is stored (api_tokens.token_hash). RLS keeps tokens strictly
// their owner's — the MCP edge function (service role) is the only other
// reader. The connections page lists them by name, opens them to edit
// name and permissions, and revokes with a warning.
import { query } from '@solidjs/router';

import { createSupabaseRequestClient } from '../server/supabase';

import {
  capSelection,
  normalizeSelection,
  selectionToWorkspaceOps,
  type PermissionSelection,
  type WorkspaceCap,
} from './mcp-permissions';

export type ApiTokenSummary = {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
};

export const getMyTokens = query(async (): Promise<ApiTokenSummary[]> => {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data } = await supabase
    .from('api_tokens')
    .select('id, name, created_at, last_used_at')
    .order('created_at', { ascending: false });
  return data ?? [];
}, 'my-tokens');

/** One connection as the detail page shows it. */
export type ConnectionDetail = ApiTokenSummary & {
  /** null = a legacy token from before per-workspace permissions. */
  workspace_ops: Record<string, string[]> | null;
  /** The flat legacy op list (account-wide) — null on new tokens. */
  legacy_allowed_ops: string[] | null;
  legacy_workspace_scope: string[] | null;
};

export const getConnection = query(
  async (tokenId: string): Promise<ConnectionDetail | null> => {
    'use server';
    const supabase = createSupabaseRequestClient();
    const { data } = await supabase
      .from('api_tokens')
      .select(
        'id, name, created_at, last_used_at, workspace_ops, allowed_ops, workspace_scope',
      )
      .eq('id', tokenId)
      .maybeSingle();
    if (!data) return null;
    return {
      id: data.id,
      name: data.name,
      created_at: data.created_at,
      last_used_at: data.last_used_at,
      workspace_ops: data.workspace_ops ?? null,
      legacy_allowed_ops: data.workspace_ops ? null : (data.allowed_ops ?? null),
      legacy_workspace_scope: data.workspace_ops ? null : (data.workspace_scope ?? null),
    };
  },
  'connection',
);

/** Rename a connection (own tokens only — RLS enforces it). */
export async function renameConnection(tokenId: string, name: string): Promise<void> {
  'use server';
  const clean = String(name ?? '').trim().slice(0, 80);
  if (!clean) throw new Error('Connection name cannot be empty');
  const supabase = createSupabaseRequestClient();
  const { error } = await supabase
    .from('api_tokens')
    .update({ name: clean })
    .eq('id', tokenId);
  if (error) throw new Error(error.message);
}

/** Change what a connection may do. Memberships are validated like the
 *  consent flow; a legacy token converts to the per-workspace shape on
 *  its first edit. Returns the workspace_ops as STORED — the server caps
 *  the selection to what the user's own roles allow, and the caller
 *  deserves to see exactly what landed (never a silent strip). */
export async function updateConnectionPermissions(
  tokenId: string,
  permissions: PermissionSelection,
): Promise<Record<string, string[]> | null> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const normalized = normalizeSelection(permissions);
  const wsIds = Object.keys(normalized.workspaces);
  const caps: Record<string, WorkspaceCap> = {};
  if (wsIds.length > 0) {
    const { data: mine } = await supabase
      .from('workspace_members')
      .select('workspace_id, role, workspaces(board_creation)')
      .in('workspace_id', wsIds);
    const memberRows = (mine ?? []) as {
      workspace_id: string;
      role: string;
      workspaces: { board_creation: string | null } | null;
    }[];
    const {
      data: { user: me },
    } = await supabase.auth.getUser();
    const { data: adminSeats } = me
      ? await supabase
          .from('team_members')
          .select('teams(workspace_id)')
          .eq('user_id', me.id)
          .eq('role', 'admin')
          .in('teams.workspace_id', wsIds)
      : { data: null };
    const teamAdminOf = new Set(
      ((adminSeats ?? []) as { teams: { workspace_id: string | null } | null }[])
        .map((seat) => seat.teams?.workspace_id)
        .filter((id): id is string => Boolean(id)),
    );
    for (const row of memberRows) {
      const boardCreation = row.workspaces?.board_creation ?? 'team_admins';
      const role = (row.role === 'owner' || row.role === 'admin' ? row.role : 'member') as
        | 'member'
        | 'admin'
        | 'owner';
      caps[row.workspace_id] = {
        role,
        canCreateBoards:
          role === 'owner' ||
          role === 'admin' ||
          boardCreation === 'everyone' ||
          (boardCreation === 'team_admins' && teamAdminOf.has(row.workspace_id)),
      };
    }
    if (wsIds.some((id) => !caps[id])) {
      throw new Error('You are not a member of the selected workspace(s).');
    }
  }
  // Converting a legacy token clears the old flat columns so one shape
  // is authoritative per token. The cap strips anything above the user's
  // own role or behind a gate they don't pass.
  const workspaceOps = selectionToWorkspaceOps(capSelection(normalized, caps));
  const { error } = await supabase
    .from('api_tokens')
    .update({
      workspace_ops: workspaceOps,
      workspace_scope: null,
      allowed_ops: null,
    })
    .eq('id', tokenId);
  if (error) throw new Error(error.message);
  return workspaceOps;
}

/** Revoke: the token stops working immediately — the MCP client must
 *  sign in again to reconnect. */
export async function revokeApiToken(tokenId: string): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { error } = await supabase.from('api_tokens').delete().eq('id', tokenId);
  if (error) throw new Error(error.message);
  return true;
}

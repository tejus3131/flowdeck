// MCP connections: the credential surface of the OAuth consent flow.
// Tokens are ONLY minted there (the browser flow exchanges a one-time
// authorization code); the plaintext is shown exactly once and only its
// sha256 is stored (api_tokens.token_hash). RLS keeps tokens strictly
// their owner's — the MCP edge function (service role) is the only other
// reader. The connections page lists them by name, opens them to edit
// name and permissions, and revokes with a warning.
import { query } from '@solidjs/router';

import { createSupabaseRequestClient, createSupabaseServiceClient } from '../server/supabase';

import {
  capFromChoice,
  capSelection,
  capWorkspaceOps,
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
// ── role-change recap ──────────────────────────────────────────────────────
// A demotion (or removal, or a policy change) used to leave saved tokens
// carrying admin-level ops until the owner happened to re-save the
// connection — tools/list kept advertising powers the role no longer
// backed, and each call only failed at runtime under RLS. The grant is
// re-capped HERE, at the moment the capability changes, from the same
// taxonomy the picker and the minting flow use (one source of truth).
//
// Privileges: caps are computed through the ACTING user's request client
// (memberships, board-creation policy and team seats are peer-visible by
// RLS), but tokens are strictly their owner's — the rewrite goes through
// the service client, exactly like the other admin-mediated writes.
// Legacy tokens (flat allowed_ops, no workspace_ops) are left alone:
// they predate per-workspace permissions and convert on their next edit.
//
// Hygiene, not a gate: this never throws (a failed recap must not break
// the role change itself) and RLS remains the enforcement layer — a
// missed recap means a stale ADVERTISEMENT, never a live power.

/** One user's caps for every workspace they are still in. */
async function capsForUsers(
  supabase: Awaited<ReturnType<typeof createSupabaseRequestClient>>,
  userIds: string[],
): Promise<Map<string, Map<string, WorkspaceCap>>> {
  const { data: memberRows } = await supabase
    .from('workspace_members')
    .select('user_id, workspace_id, role, workspaces(board_creation)')
    .in('user_id', userIds);
  const { data: seatRows } = await supabase
    .from('team_members')
    .select('user_id, teams(workspace_id)')
    .in('user_id', userIds)
    .eq('role', 'admin');
  const teamAdminOf = new Map<string, Set<string>>();
  for (const row of (seatRows ?? []) as {
    user_id: string;
    teams: { workspace_id: string | null } | null;
  }[]) {
    if (!row.teams?.workspace_id) continue;
    const set = teamAdminOf.get(row.user_id) ?? new Set<string>();
    set.add(row.teams.workspace_id);
    teamAdminOf.set(row.user_id, set);
  }
  const caps = new Map<string, Map<string, WorkspaceCap>>();
  for (const row of (memberRows ?? []) as {
    user_id: string;
    workspace_id: string;
    role: string;
    workspaces: { board_creation: string | null } | null;
  }[]) {
    const role = (row.role === 'owner' || row.role === 'admin' ? row.role : 'member') as
      | 'member'
      | 'admin'
      | 'owner';
    const perUser = caps.get(row.user_id) ?? new Map<string, WorkspaceCap>();
    perUser.set(
      row.workspace_id,
      capFromChoice({
        role,
        board_creation: row.workspaces?.board_creation ?? 'team_admins',
        is_team_admin: teamAdminOf.get(row.user_id)?.has(row.workspace_id) ?? false,
      }),
    );
    caps.set(row.user_id, perUser);
  }
  return caps;
}

/**
 * Re-cap the saved tokens of the given users to what their CURRENT
 * roles, gates and memberships still allow. Call after any capability
 * change: role change, removal/leave, board-creation policy change,
 * team-admin seat changes, workspace deletion. Never throws.
 */
export async function recapTokensForUsers(userIds: string[]): Promise<void> {
  'use server';
  const ids = [...new Set((userIds ?? []).filter((id) => typeof id === 'string' && id))];
  if (ids.length === 0) return;
  try {
    const supabase = createSupabaseRequestClient();
    const caps = await capsForUsers(supabase, ids);
    const service = createSupabaseServiceClient();
    const { data: tokens } = await service
      .from('api_tokens')
      .select('id, user_id, workspace_ops')
      .in('user_id', ids);
    for (const token of (tokens ?? []) as {
      id: string;
      user_id: string;
      workspace_ops: Record<string, string[]> | null;
    }[]) {
      const ops = token.workspace_ops;
      if (!ops) continue; // legacy token — converts on its next edit
      const userCaps = caps.get(token.user_id);
      let changed = false;
      const next: Record<string, string[]> = {};
      for (const [wsId, wsOps] of Object.entries(ops)) {
        if (wsId === '*') {
          next[wsId] = wsOps; // account bucket: not role-gated
          continue;
        }
        const cap = userCaps?.get(wsId);
        if (!cap) {
          changed = true; // no longer a member — the bucket goes entirely
          continue;
        }
        const capped = capWorkspaceOps(wsOps, cap);
        // A bucket reduced to baseline-only identity ops grants nothing
        // real; drop it so tools/list reflects zero access.
        const real = capped.filter((op) => !['get_me', 'list_workspaces'].includes(op));
        if (real.length === 0) {
          changed = true;
          continue;
        }
        if (capped.length !== wsOps.length) changed = true;
        next[wsId] = capped;
      }
      if (changed) {
        const { error } = await service
          .from('api_tokens')
          .update({ workspace_ops: next })
          .eq('id', token.id);
        if (error) console.error('[recapTokensForUsers] token rewrite failed:', error.message);
      }
    }
  } catch (err) {
    console.error('[recapTokensForUsers] failed:', err);
  }
}

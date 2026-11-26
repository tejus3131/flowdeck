// The MCP consent flow's server side: the /mcp/authorize page calls
// approveMcpClient when the user clicks Allow. This is the browser half
// of the OAuth-style flow (card #16) — the edge function owns discovery
// and the token exchange; this only mints the one-time authorization
// code, after the user has seen exactly who is asking.
//
// Validation mirrors the edge function's /token checks: client_id and
// redirect_uri must match at exchange time, and the PKCE S256 challenge
// is stored with the code — the app never sees the verifier.
import { createHash, randomBytes } from 'node:crypto';

import { query } from '@solidjs/router';

import { createSupabaseRequestClient } from '../server/supabase';

import {
  capSelection,
  normalizeSelection,
  selectionToWorkspaceOps,
  type PermissionSelection,
  type WorkspaceCap,
} from './mcp-permissions';

export type McpAuthorizeInput = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  challengeMethod: string;
  state?: string | null;
  /** The org → entity → action permission selection. */
  permissions?: PermissionSelection;
  /** What the user named this connection — lands on the token. */
  connectionName?: string;
};
/** Signed-in check for the consent page's gate (round-3: the page used
 * to render fully signed-out and only fail on Allow). */
export async function mcpAuthSignedIn(): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return Boolean(user);
}

/**
 * The workspaces the consent/connections pages offer (and the user belongs
 * to), with what the user can be offered in each: their role, and whether
 * this workspace allows THEM to create boards (role + board_creation
 * policy + team-admin).
 */
export const listMyWorkspaceChoices = query(
  async (): Promise<
    {
      id: string;
      name: string;
      role: 'member' | 'admin' | 'owner';
      board_creation: string;
      is_team_admin: boolean;
    }[]
  > => {
    'use server';
    const supabase = createSupabaseRequestClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];
    // ONLY MY OWN membership rows. RLS deliberately exposes every peer's
    // membership row (the roster needs it) — without this filter the
    // picker rendered one dropdown per MEMBER (a 3-member workspace showed
    // 3 dropdowns), and the cap could take another member's role.
    const { data } = await supabase
      .from('workspace_members')
      .select('workspace_id, role, workspaces(name, board_creation)')
      .eq('user_id', user.id)
      .order('created_at');
    const rows = (data ?? []) as {
      workspace_id: string;
      role: string;
      workspaces: { name: string | null; board_creation: string | null } | null;
    }[];
    // Team-admin per workspace: my admin seats on teams of those workspaces
    // (workspace_members has no relation to team_members — a second query).
    const { data: adminSeats } = user
      ? await supabase
          .from('team_members')
          .select('teams(workspace_id)')
          .eq('user_id', user.id)
          .eq('role', 'admin')
      : { data: null };
    const teamAdminOf = new Set(
      ((adminSeats ?? []) as { teams: { workspace_id: string | null } | null }[])
        .map((seat) => seat.teams?.workspace_id)
        .filter((id): id is string => Boolean(id)),
    );
    return rows.map((row) => ({
      id: row.workspace_id,
      name: (row.workspaces?.name ?? 'Workspace') as string,
      role: (row.role === 'owner' || row.role === 'admin' ? row.role : 'member') as
        'member' | 'admin' | 'owner',
      board_creation: (row.workspaces?.board_creation ?? 'team_admins') as string,
      is_team_admin: teamAdminOf.has(row.workspace_id),
    }));
  },
  'my-ws-choices',
);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    // http is fine for local clients (127.0.0.1/localhost) only.
    if (url.protocol === 'http:') {
      return (
        url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
      );
    }
    return url.hostname.length > 0 && !url.hash;
  } catch {
    return false;
  }
}

/** Consent granted: mint a single-use authorization code and hand back
 * the redirect that carries it (with the caller's state, if any). */
export async function approveMcpClient(input: McpAuthorizeInput): Promise<{ redirectTo: string }> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to sign in first');

  const clientId = String(input.clientId ?? '')
    .trim()
    .slice(0, 100);
  const redirectUri = String(input.redirectUri ?? '').trim();
  const codeChallenge = String(input.codeChallenge ?? '').trim();
  const challengeMethod = String(input.challengeMethod ?? 'S256').trim();
  const state = input.state ? String(input.state).slice(0, 2000) : null;
  // The compartmentalization: only workspaces the user actually belongs
  // to can be granted, and an empty selection means account-wide.
  // The permission selection: org → entity → action, normalized (writes
  // imply reads) and validated against real memberships before storing.
  const normalized = normalizeSelection(input.permissions ?? { workspaces: {}, account: {} });
  const wantedWorkspaceIds = Object.keys(normalized.workspaces);
  const caps: Record<string, WorkspaceCap> = {};
  if (wantedWorkspaceIds.length > 0) {
    const { data: mine } = await supabase
      .from('workspace_members')
      .select('workspace_id, role, workspaces(board_creation)')
      .eq('user_id', user.id)
      .in('workspace_id', wantedWorkspaceIds);
    const memberRows = (mine ?? []) as {
      workspace_id: string;
      role: string;
      workspaces: { board_creation: string | null } | null;
    }[];
    // My team-admin seats, for the team_admins board-creation policy.
    const {
      data: { user: me },
    } = await supabase.auth.getUser();
    const { data: adminSeats } = me
      ? await supabase
          .from('team_members')
          .select('teams(workspace_id)')
          .eq('user_id', me.id)
          .eq('role', 'admin')
          .in('teams.workspace_id', wantedWorkspaceIds)
      : { data: null };
    const teamAdminOf = new Set(
      ((adminSeats ?? []) as { teams: { workspace_id: string | null } | null }[])
        .map((seat) => seat.teams?.workspace_id)
        .filter((id): id is string => Boolean(id)),
    );
    for (const row of memberRows) {
      const boardCreation = row.workspaces?.board_creation ?? 'team_admins';
      const role = (row.role === 'owner' || row.role === 'admin' ? row.role : 'member') as
        'member' | 'admin' | 'owner';
      caps[row.workspace_id] = {
        role,
        canCreateBoards:
          role === 'owner' ||
          role === 'admin' ||
          boardCreation === 'everyone' ||
          (boardCreation === 'team_admins' && teamAdminOf.has(row.workspace_id)),
      };
    }
    const granted = new Set(Object.keys(caps));
    if (wantedWorkspaceIds.some((id) => !granted.has(id))) {
      throw new Error('You are not a member of the selected workspace(s).');
    }
  }
  // Server-side cap: a crafted request can never grant above what the user
  // can do themselves (role + board-creation gate).
  const capped = capSelection(normalized, caps);
  const workspaceOps = selectionToWorkspaceOps(capped);

  if (!clientId || !redirectUri || !codeChallenge) {
    throw new Error('This authorization request is incomplete — ask the client to retry.');
  }
  if (!isHttpUrl(redirectUri)) {
    throw new Error('The redirect address must be a valid https URL (http only for localhost).');
  }
  if (challengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    throw new Error('This authorization request must use PKCE (S256) — ask the client to retry.');
  }

  // The connection's name: user-chosen on the consent page, bounded and
  // trimmed; the edge mints it onto the token (falling back to a default).
  const connectionName =
    String(input.connectionName ?? '')
      .trim()
      .slice(0, 80) || null;

  const code = `mcp_${randomBytes(24).toString('hex')}`;
  const codeHash = createHash('sha256').update(code).digest('hex');
  const { error } = await supabase.from('mcp_auth_codes').insert({
    code_hash: codeHash,
    user_id: user.id,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    challenge_method: 'S256',
    connection_name: connectionName,
    workspace_ops: workspaceOps,
  });
  if (error) throw new Error(error.message);

  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  return { redirectTo: target.toString() };
}

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

import { createSupabaseRequestClient } from '../server/supabase';

export type McpAuthorizeInput = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  challengeMethod: string;
  state?: string | null;
  /** Workspaces to scope the connection to. Empty = the whole account. */
  workspaceIds?: string[];
  /** Tool category ids to grant. `['*']` = every tool (explicit full grant). */
  toolCategories?: string[];
};

/** Tool categories the consent page offers. The SAFE default is the
 * read-only surface (plus the agent's own profile/status/inbox);
 * everything that writes or administers is opt-in. The map lives here —
 * the token stores the flat op list, the edge function only ever sees
 * that flat list. */
export const TOOL_CATEGORIES: { id: string; label: string; description: string; ops: string[]; defaultOn: boolean }[] = [
  {
    id: 'read',
    label: 'Read',
    description: 'Boards, cards, chats, comments, tags, teams, members, notifications, search — read-only.',
    ops: ['list_boards', 'get_board', 'get_board_full', 'get_cards', 'list_board_messages', 'list_comments', 'get_card_events', 'get_me', 'list_workspaces', 'list_workspace_members', 'get_user', 'list_teams', 'list_tags', 'list_notifications', 'search', 'check_mention_access'],
    defaultOn: true,
  },
  {
    id: 'profile',
    label: 'Profile & status',
    description: 'Set your display name and status.',
    ops: ['update_me', 'set_status'],
    defaultOn: true,
  },
  {
    id: 'notifications',
    label: 'Notification inbox',
    description: 'Mark your notifications read/unread.',
    ops: ['mark_notification_read', 'mark_notification_unread', 'mark_all_notifications_read'],
    defaultOn: true,
  },
  {
    id: 'cards',
    label: 'Cards',
    description: 'Create, update, move, delete cards and assign people.',
    ops: ['create_card', 'update_card', 'move_card', 'delete_card'],
    defaultOn: false,
  },
  {
    id: 'chat',
    label: 'Chat',
    description: 'Post, edit and delete board messages and card comments.',
    ops: ['post_board_message', 'edit_board_message', 'delete_board_message', 'add_comment', 'edit_comment', 'delete_comment'],
    defaultOn: false,
  },
  {
    id: 'tags',
    label: 'Tags',
    description: 'Create, rename, delete and merge the workspace tags.',
    ops: ['create_tag', 'rename_tag', 'delete_tag', 'merge_tags'],
    defaultOn: false,
  },
  {
    id: 'boards',
    label: 'Boards & lists',
    description: 'Create, update and delete boards and lists (destructive).',
    ops: ['create_board', 'rename_board', 'update_board', 'delete_board', 'create_list', 'rename_list', 'update_list', 'delete_list'],
    defaultOn: false,
  },
  {
    id: 'teams',
    label: 'Teams',
    description: 'Create and edit teams and their members.',
    ops: ['create_team', 'update_team', 'add_team_member', 'remove_team_member'],
    defaultOn: false,
  },
  {
    id: 'workspace',
    label: 'Workspace',
    description: 'Create workspaces and invite members. Sensitive.',
    ops: ['create_workspace', 'invite_member', 'list_pending_invites'],
    defaultOn: false,
  },
  {
    id: 'access',
    label: 'Board access requests',
    description: 'Grant, request and resolve board access for mentions.',
    ops: ['grant_board_access', 'request_board_access', 'resolve_access_request'],
    defaultOn: false,
  },
];

/** The default (safe) op set: every category marked defaultOn. */
export const DEFAULT_TOOL_OPS: string[] = TOOL_CATEGORIES
  .filter((category) => category.defaultOn)
  .flatMap((category) => category.ops);

/** The workspaces the consent page offers (and the user belongs to). */
export async function listMyWorkspaceChoices(): Promise<
  { id: string; name: string; role: string }[]
> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, workspaces(name)')
    .order('created_at');
  return (data ?? []).map((row) => ({
    id: row.workspace_id as string,
    name: ((row.workspaces as { name: string } | null)?.name ?? 'Workspace') as string,
    role: row.role as string,
  }));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    // http is fine for local clients (127.0.0.1/localhost) only.
    if (url.protocol === 'http:') {
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
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

  const clientId = String(input.clientId ?? '').trim().slice(0, 100);
  const redirectUri = String(input.redirectUri ?? '').trim();
  const codeChallenge = String(input.codeChallenge ?? '').trim();
  const challengeMethod = String(input.challengeMethod ?? 'S256').trim();
  const state = input.state ? String(input.state).slice(0, 2000) : null;
  // The compartmentalization: only workspaces the user actually belongs
  // to can be granted, and an empty selection means account-wide.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const wanted = [...new Set((input.workspaceIds ?? []).map((id) => String(id)))].filter((id) =>
    UUID_RE.test(id),
  );
  let workspaceScope: string[] | null = null;
  // Tool permissions: categories -> flat op list. The default is the safe
  // read-only surface; ['*'] is an explicit full-power grant.
  const wantedCategories = [...new Set((input.toolCategories ?? []).map((id) => String(id)))];
  const allOps = TOOL_CATEGORIES.flatMap((category) => category.ops);
  let allowedOps: string[] | null = null;
  if (wantedCategories.includes('*')) {
    allowedOps = allOps;
  } else if (wantedCategories.length > 0) {
    allowedOps = [
      ...new Set(
        TOOL_CATEGORIES
          .filter((category) => wantedCategories.includes(category.id))
          .flatMap((category) => category.ops),
      ),
    ];
  }
  if (wanted.length > 0) {
    const { data: mine } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .in('workspace_id', wanted);
    const granted = new Set((mine ?? []).map((row) => row.workspace_id as string));
    workspaceScope = wanted.filter((id) => granted.has(id));
    if (workspaceScope.length === 0) {
      throw new Error('You are not a member of the selected workspace(s).');
    }
  }

  if (!clientId || !redirectUri || !codeChallenge) {
    throw new Error('This authorization request is incomplete — ask the client to retry.');
  }
  if (!isHttpUrl(redirectUri)) {
    throw new Error('The redirect address must be a valid https URL (http only for localhost).');
  }
  if (challengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    throw new Error('This authorization request must use PKCE (S256) — ask the client to retry.');
  }

  const code = `mcp_${randomBytes(24).toString('hex')}`;
  const codeHash = createHash('sha256').update(code).digest('hex');
  const { error } = await supabase.from('mcp_auth_codes').insert({
    code_hash: codeHash,
    user_id: user.id,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    challenge_method: 'S256',
    workspace_scope: workspaceScope,
    allowed_ops: allowedOps,
  });
  if (error) throw new Error(error.message);

  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  return { redirectTo: target.toString() };
}

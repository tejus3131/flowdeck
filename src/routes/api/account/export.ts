// The data-rights export: a machine-readable copy of everything the
// account owns (GDPR Art. 15/20 — access + portability). One API route,
// the request-scoped client only (RLS decides what the caller sees —
// the export can never exceed the account's own reach), streamed as a
// JSON download.
import type { APIHandler, APIEvent } from 'filesystem-routing/api';

import { createSupabaseRequestClient } from '../../../server/supabase';

export const GET: APIHandler = async (event: APIEvent) => {
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: 'Sign in first' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Profile (own row — RLS).
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  // Memberships + the workspaces they point at (RLS shows peers' rows —
  // filter to the caller's own, the same rule every roster read applies).
  const { data: memberships } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, created_at')
    .eq('user_id', user.id);
  const workspaceIds = ((memberships ?? []) as { workspace_id: string }[]).map(
    (m) => m.workspace_id,
  );
  const { data: workspaces } =
    workspaceIds.length > 0
      ? await supabase.from('workspaces').select('*').in('id', workspaceIds)
      : { data: [] };

  // Boards in those workspaces (RLS: only boards the caller can see).
  const { data: boards } =
    workspaceIds.length > 0
      ? await supabase.from('boards').select('*').in('workspace_id', workspaceIds)
      : { data: [] };
  const boardIds = ((boards ?? []) as { id: string }[]).map((b) => b.id);

  // Cards + lists of those boards.
  const { data: lists } =
    boardIds.length > 0
      ? await supabase.from('lists').select('*').in('board_id', boardIds)
      : { data: [] };
  const { data: cards } =
    boardIds.length > 0
      ? await supabase.from('cards').select('*').in('board_id', boardIds)
      : { data: [] };

  const payload = {
    exported_at: new Date().toISOString(),
    format: 'flowdeck-export/1',
    account: {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      profile,
    },
    workspaces,
    memberships,
    boards,
    lists,
    cards,
  };

  const date = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="flowdeck-export-${date}.json"`,
      'cache-control': 'no-store',
    },
  });
};

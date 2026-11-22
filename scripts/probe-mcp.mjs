// MCP end-to-end probe: mints a PAT for a probe user (token hash inserted
// directly), then exercises the live endpoint — tools/list plus the new
// surface (get_me, list_workspaces, set_status, list_notifications,
// post_board_message, create_workspace, create_team, invite checks).
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const URL = 'https://ylarhvcbpppujpjnpxkq.supabase.co';
const MCP = `${URL}/functions/v1/mcp`;
const TOKEN = `fd_probe_${Date.now().toString(36)}_token`;

// 1. Keys (never printed) + a probe user.
const keys = JSON.parse(execFileSync('supabase', ['projects', 'api-keys', '--output', 'json'], { encoding: 'utf8' }));
const list = Array.isArray(keys) ? keys : keys.data ?? [];
const anonKey = list.find((k) => k.name === 'anon').api_key;
const secretKey = list.find((k) => k.name === 'service_role').api_key;
const admin = createClient(URL, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
const email = `mcp-probe-${Date.now().toString(36)}@flowdeck.test`;
const { data: created, error: createErr } = await admin.auth.admin.createUser({ email });
if (createErr || !created.user) {
  console.error('probe user failed:', createErr?.message);
  process.exit(1);
}
const userId = created.user.id;

// 2. PAT: sha256 hex of the plaintext, exactly like the app.
const tokenHash = createHash('sha256').update(TOKEN).digest('hex');
const { error: tokenErr } = await admin.from('api_tokens').insert({ user_id: userId, name: 'probe', token_hash: tokenHash });
if (tokenErr) {
  console.error('token insert failed:', tokenErr.message);
  process.exit(1);
}

// 3. MCP calls (streamable HTTP: plain JSON-RPC posts).
let nextId = 1;
const call = async (method, params) => {
  const response = await fetch(MCP, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const body = await response.json().catch(() => null);
  if (body?.error) return { ok: false, error: body.error.message };
  return { ok: true, result: body?.result ?? body };
};

const initialized = await call('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'probe', version: '0.0.1' },
});
console.log('initialize:', initialized.ok ? 'OK' : 'FAIL — ' + initialized.error);

const tools = await call('tools/list', {});
const names = tools.result?.tools?.map((t) => t.name) ?? [];
console.log('tools/list:', tools.ok ? `${names.length} tools` : 'FAIL — ' + tools.error);
console.log('new tools present:', [
  'get_me',
  'list_workspaces',
  'create_workspace',
  'list_teams',
  'create_team',
  'add_team_member',
  'post_board_message',
  'invite_member',
  'list_notifications',
  'set_status',
]
  .filter((name) => names.includes(name))
  .join(', '));
const missing = ['get_me', 'list_workspaces', 'post_board_message', 'set_status'].filter((n) => !names.includes(n));
if (missing.length) console.log('MISSING:', missing.join(', '));

// 4. Exercise the new ops as the probe user.
const me = await call('tools/call', { name: 'get_me', arguments: {} });
console.log('get_me:', me.ok ? (me.result?.content?.[0]?.text ?? '').slice(0, 80) : 'FAIL — ' + me.error);

const ws = await call('tools/call', { name: 'create_workspace', arguments: { name: 'MCP Probe WS' } });
const wsText = ws.result?.content?.[0]?.text ?? '';
console.log('create_workspace:', ws.ok ? wsText.slice(0, 90) : 'FAIL — ' + ws.error);

const wsId = wsText.match(/"workspace_id":\s*"([0-9a-f-]{36})"/)?.[1];
if (wsId) {
  const team = await call('tools/call', { name: 'create_team', arguments: { workspace_id: wsId, name: 'Probe Team' } });
  console.log('create_team (owner NOT auto-added):', team.ok ? (team.result?.content?.[0]?.text ?? '').slice(0, 80) : 'FAIL — ' + team.error);

  const boards = await call('tools/call', { name: 'list_boards', arguments: {} });
  console.log('list_boards (new ws, 0 boards):', boards.ok ? (boards.result?.content?.[0]?.text ?? '').slice(0, 60) : 'FAIL — ' + boards.error);

  const invite = await call('tools/call', { name: 'invite_member', arguments: { workspace_id: wsId, email: 'friend@gmail.com', role: 'member' } });
  console.log('invite_member:', invite.ok ? (invite.result?.content?.[0]?.text ?? '').slice(0, 90) : 'FAIL — ' + invite.error);
}

const status = await call('tools/call', { name: 'set_status', arguments: { emoji: '🧪', label: 'probing', dnd: true } });
console.log('set_status:', status.ok ? 'OK' : 'FAIL — ' + status.error);

const notifs = await call('tools/call', { name: 'list_notifications', arguments: {} });
console.log('list_notifications:', notifs.ok ? 'OK' : 'FAIL — ' + notifs.error);

// 5. Cleanup: probe user + workspace cascade.
await admin.from('api_tokens').delete().eq('user_id', userId);
await admin.from('workspaces').delete().eq('name', 'MCP Probe WS');
await admin.auth.admin.deleteUser(userId);
console.log('cleanup done');

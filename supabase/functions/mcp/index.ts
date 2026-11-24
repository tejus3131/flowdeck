// Flowdeck MCP server — Supabase Edge Function.
//
// Speaks the Model Context Protocol over the streamable HTTP transport:
// every request is a JSON-RPC 2.0 message POSTed to this endpoint, and
// every response is plain JSON (no server-initiated streams needed, so the
// SSE half of the transport stays unused). Any MCP client — Claude Desktop,
// Cursor, a custom harness — connects with the URL plus a personal access
// token created on the Flowdeck profile page:
//
//   { "mcpServers": { "flowdeck": {
//     "url": "https://<project>.supabase.co/functions/v1/mcp",
//     "headers": { "Authorization": "Bearer fd_..." } } } }
//
// Auth: Bearer PAT → sha256 → api_tokens.token_hash (the plaintext is
// never stored). Every operation runs through public.mcp_exec, which
// becomes the token's user and executes under the app's RLS — an MCP
// client can do exactly what the web app could, and nothing more.
//
// Deploy: supabase functions deploy mcp --no-verify-jwt
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.119.2';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'flowdeck', version: '1.0.0' };

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  op: string;
};

// Shared cursor-pagination params. Every list-shaped read returns
// { items, next_cursor }: next_cursor is an opaque string that is
// null/absent when the list is exhausted; pass it back as `cursor`
// for the next page.
const PAGE_PARAMS = {
  cursor: {
    type: 'string',
    description: 'Opaque cursor from a previous page (the next_cursor value); omit for the first page.',
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 200,
    description: 'Page size. Default 50, max 200.',
  },
};

const TOOLS: ToolDef[] = [
  {
    name: 'list_boards',
    description:
      'List boards the account can see, newest activity first. Returns { items, next_cursor } — pass next_cursor as cursor to page through.',
    inputSchema: {
      type: 'object',
      properties: { ...PAGE_PARAMS },
      additionalProperties: false,
    },
    op: 'list_boards',
  },
  {
    name: 'get_board',
    description:
      'One board with its lists (no cards or messages). Use this to discover list ids, then get_cards(list_id) for cards and list_board_messages(board_id) for the board chat.',
    inputSchema: {
      type: 'object',
      properties: { board_id: { type: 'string', format: 'uuid' } },
      required: ['board_id'],
      additionalProperties: false,
    },
    op: 'get_board',
  },
  {
    name: 'get_board_full',
    description:
      'Legacy one-call payload: board + lists + ALL cards + ALL chat messages, unpaged. Flooding risk on active boards — prefer get_board + get_cards + list_board_messages.',
    inputSchema: {
      type: 'object',
      properties: { board_id: { type: 'string', format: 'uuid' } },
      required: ['board_id'],
      additionalProperties: false,
    },
    op: 'get_board_full',
  },
  {
    name: 'get_cards',
    description:
      'Cards in one list, in board order. Returns { items, next_cursor } — pass next_cursor as cursor to page through.',
    inputSchema: {
      type: 'object',
      properties: { list_id: { type: 'string', format: 'uuid' }, ...PAGE_PARAMS },
      required: ['list_id'],
      additionalProperties: false,
    },
    op: 'get_cards',
  },
  {
    name: 'create_board',
    description: 'Create a board (with default To do / In progress / Done lists).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 80 },
        workspace_id: { type: 'string', format: 'uuid', description: 'Optional; defaults to the first workspace.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    op: 'create_board',
  },
  {
    name: 'rename_board',
    description: 'Rename a board.',
    inputSchema: {
      type: 'object',
      properties: { board_id: { type: 'string', format: 'uuid' }, name: { type: 'string', maxLength: 80 } },
      required: ['board_id', 'name'],
      additionalProperties: false,
    },
    op: 'rename_board',
  },
  {
    name: 'delete_board',
    description: 'Delete a board and everything in it. Destructive.',
    inputSchema: {
      type: 'object',
      properties: { board_id: { type: 'string', format: 'uuid' } },
      required: ['board_id'],
      additionalProperties: false,
    },
    op: 'delete_board',
  },
  {
    name: 'create_list',
    description: 'Add a list (column) to a board.',
    inputSchema: {
      type: 'object',
      properties: { board_id: { type: 'string', format: 'uuid' }, name: { type: 'string', maxLength: 80 } },
      required: ['board_id', 'name'],
      additionalProperties: false,
    },
    op: 'create_list',
  },
  {
    name: 'rename_list',
    description: 'Rename a list.',
    inputSchema: {
      type: 'object',
      properties: { list_id: { type: 'string', format: 'uuid' }, name: { type: 'string', maxLength: 80 } },
      required: ['list_id', 'name'],
      additionalProperties: false,
    },
    op: 'rename_list',
  },
  {
    name: 'delete_list',
    description: 'Delete a list and its cards. Destructive.',
    inputSchema: {
      type: 'object',
      properties: { list_id: { type: 'string', format: 'uuid' } },
      required: ['list_id'],
      additionalProperties: false,
    },
    op: 'delete_list',
  },
  {
    name: 'create_card',
    description: 'Create a card in a list (appended to the end).',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', format: 'uuid' },
        title: { type: 'string', maxLength: 500 },
        description: { type: 'string' },
      },
      required: ['list_id', 'title'],
      additionalProperties: false,
    },
    op: 'create_card',
  },
  {
    name: 'update_card',
    description: 'Update a card title and/or description.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', format: 'uuid' },
        title: { type: 'string', maxLength: 500 },
        description: { type: 'string' },
      },
      required: ['card_id'],
      additionalProperties: false,
    },
    op: 'update_card',
  },
  {
    name: 'move_card',
    description: 'Move a card to a list at a position. Positions are numbers; use whole numbers (1, 2, 3…).',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', format: 'uuid' },
        list_id: { type: 'string', format: 'uuid' },
        position: { type: 'number' },
      },
      required: ['card_id', 'list_id', 'position'],
      additionalProperties: false,
    },
    op: 'move_card',
  },
  {
    name: 'delete_card',
    description: 'Delete a card. Destructive.',
    inputSchema: {
      type: 'object',
      properties: { card_id: { type: 'string', format: 'uuid' } },
      required: ['card_id'],
      additionalProperties: false,
    },
    op: 'delete_card',
  },
  {
    name: 'add_comment',
    description: 'Comment on a card.',
    inputSchema: {
      type: 'object',
      properties: { card_id: { type: 'string', format: 'uuid' }, body: { type: 'string', maxLength: 2000 } },
      required: ['card_id', 'body'],
      additionalProperties: false,
    },
    op: 'add_comment',
  },
  {
    name: 'list_comments',
    description:
      'Comments on a card, oldest first. Returns { items, next_cursor } — pass next_cursor as cursor to page through.',
    inputSchema: {
      type: 'object',
      properties: { card_id: { type: 'string', format: 'uuid' }, ...PAGE_PARAMS },
      required: ['card_id'],
      additionalProperties: false,
    },
    op: 'list_comments',
  },
  {
    name: 'get_me',
    description: 'Your own profile (display name, email, avatar) and current status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    op: 'get_me',
  },
  {
    name: 'list_workspaces',
    description:
      'Every workspace you belong to, with your role in each. Returns { items, next_cursor } — pass next_cursor as cursor to page through.',
    inputSchema: {
      type: 'object',
      properties: { ...PAGE_PARAMS },
      additionalProperties: false,
    },
    op: 'list_workspaces',
  },
  {
    name: 'create_workspace',
    description: 'Create a workspace (you become its owner).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', maxLength: 80 } },
      required: ['name'],
      additionalProperties: false,
    },
    op: 'create_workspace',
  },
  {
    name: 'list_teams',
    description:
      "A workspace's teams with their members (ids and team roles), oldest first. Returns { items, next_cursor } — pass next_cursor as cursor to page through.",
    inputSchema: {
      type: 'object',
      properties: { workspace_id: { type: 'string', format: 'uuid' }, ...PAGE_PARAMS },
      required: ['workspace_id'],
      additionalProperties: false,
    },
    op: 'list_teams',
  },
  {
    name: 'create_team',
    description:
      'Create a team in a workspace (workspace owners/admins only; owners are not auto-added as members — they manage via workspace powers).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', format: 'uuid' },
        name: { type: 'string', maxLength: 60 },
        description: { type: 'string', maxLength: 500 },
      },
      required: ['workspace_id', 'name'],
      additionalProperties: false,
    },
    op: 'create_team',
  },
  {
    name: 'add_team_member',
    description: 'Add (or change the role of) a person on a team. The person must already be a workspace member.',
    inputSchema: {
      type: 'object',
      properties: {
        team_id: { type: 'string', format: 'uuid' },
        user_id: { type: 'string', format: 'uuid' },
        role: { type: 'string', enum: ['member', 'admin'] },
      },
      required: ['team_id', 'user_id'],
      additionalProperties: false,
    },
    op: 'add_team_member',
  },
  {
    name: 'remove_team_member',
    description: 'Remove a person from a team.',
    inputSchema: {
      type: 'object',
      properties: { team_id: { type: 'string', format: 'uuid' }, user_id: { type: 'string', format: 'uuid' } },
      required: ['team_id', 'user_id'],
      additionalProperties: false,
    },
    op: 'remove_team_member',
  },
  {
    name: 'post_board_message',
    description: 'Post a message to a board chat.',
    inputSchema: {
      type: 'object',
      properties: { board_id: { type: 'string', format: 'uuid' }, body: { type: 'string', maxLength: 4000 } },
      required: ['board_id', 'body'],
      additionalProperties: false,
    },
    op: 'post_board_message',
  },
  {
    name: 'list_board_messages',
    description:
      'Board chat messages, oldest first. Returns { items, next_cursor } — pass next_cursor as cursor to page through.',
    inputSchema: {
      type: 'object',
      properties: { board_id: { type: 'string', format: 'uuid' }, ...PAGE_PARAMS },
      required: ['board_id'],
      additionalProperties: false,
    },
    op: 'list_board_messages',
  },
  {
    name: 'invite_member',
    description:
      'Invite an email to a workspace (owners/admins; the domain allowlist applies). Returns the accept path to share.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', format: 'uuid' },
        email: { type: 'string' },
        role: { type: 'string', enum: ['member', 'admin'] },
      },
      required: ['workspace_id', 'email'],
      additionalProperties: false,
    },
    op: 'invite_member',
  },
  {
    name: 'list_notifications',
    description: 'Your latest 50 notifications (mentions, assignments, invites, access requests).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    op: 'list_notifications',
  },
  {
    name: 'set_status',
    description: 'Set your status (emoji, short text, do-not-disturb). Clear with empty values.',
    inputSchema: {
      type: 'object',
      properties: {
        emoji: { type: 'string', maxLength: 4 },
        label: { type: 'string', maxLength: 60 },
        dnd: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    op: 'set_status',
  },
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  // Streamable HTTP: this server only answers client POSTs.
  if (request.method !== 'POST') {
    return json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST MCP messages here.' } },
      405,
    );
  }

  // ── PAT auth ────────────────────────────────────────────────────────────
  const auth = request.headers.get('authorization') ?? '';
  const presented = auth.replace(/^Bearer\s+/i, '').trim();
  if (!presented.startsWith('fd_')) {
    return json(
      { jsonrpc: '2.0', error: { code: -32001, message: 'Missing or malformed token. Pass "Authorization: Bearer fd_…"' } },
      401,
    );
  }
  const tokenHash = await sha256Hex(presented);

  const service = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
  const { data: tokenRow, error: tokenError } = await service
    .from('api_tokens')
    .select('id, user_id')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (tokenError || !tokenRow) {
    return json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unknown token.' } }, 401);
  }
  // Fire-and-forget last-used stamp.
  void service.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', tokenRow.id);

  // ── JSON-RPC dispatch ──────────────────────────────────────────────────
  let message: {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: {
      protocolVersion?: string;
      _meta?: { progressToken?: unknown };
      name?: string;
      arguments?: Record<string, unknown>;
    };
  };
  try {
    message = await request.json();
  } catch {
    return json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }, 400);
  }

  const id = message.id ?? null;
  const reply = (result: unknown) =>
    id === null
      ? new Response(null, { status: 202, headers: CORS }) // notification: no reply
      : json({ jsonrpc: '2.0', id, result });

  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion ?? '';
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : PROTOCOL_VERSIONS[0];
      return reply({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return reply(undefined);
    case 'ping':
      return reply({});
    case 'tools/list': {
      return reply({
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    }
    case 'tools/call': {
      const name = message.params?.name ?? '';
      const tool = TOOLS.find((entry) => entry.name === name);
      if (!tool) {
        return json(
          { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } },
          400,
        );
      }
      const args = message.params?.arguments ?? {};
      const { data, error } = await service.rpc('mcp_exec', {
        p_user_id: tokenRow.user_id,
        p_op: tool.op,
        p_arg: args,
      });
      const result = (data ?? {}) as { ok?: boolean; data?: unknown };
      if (error || result.ok !== true) {
        // Tool-level failure: MCP expects isError, not a protocol error.
        return reply({
          content: [
            {
              type: 'text',
              text: `Error: ${error?.message ?? (result as { error?: string }).error ?? 'operation failed'}`,
            },
          ],
          isError: true,
        });
      }
      return reply({
        content: [{ type: 'text', text: JSON.stringify(result.data ?? null, null, 2) }],
        isError: false,
      });
    }
    default:
      return json(
        { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method}` } },
        400,
      );
  }
});

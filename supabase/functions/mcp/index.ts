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

/** Per-connection tool permissions: allowed_ops is a flat list of op
 * names; NULL/empty keeps the account-wide behavior (every tool). */
function opAllowed(allowedOps: string[] | null | undefined, op: string): boolean {
  // null/undefined = a legacy account-wide token; [] = nothing granted.
  if (allowedOps === null || allowedOps === undefined) return true;
  return allowedOps.includes(op);
}

// Mention syntax, shared by every chat-surface description — the ONE
// context an agent is guaranteed to see (skills must be installed
// explicitly, tool descriptions ride along for free).
const MENTION_SYNTAX = `Mentions: [Name](user:<uuid>) for people, [Team](team:<uuid>) for teams, [Card title](card:<uuid>) for cards (works in board chat, card comments, and card descriptions). Find user ids via list_workspace_members/get_user and team ids via list_teams. A mention the target cannot see (no board access) is silently not delivered — call check_mention_access first and grant or request access as its can_grant/can_request direct.`;

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
      'Cards in one list, in board order, each with its tags (id + name). Returns { items, next_cursor } — pass next_cursor as cursor to page through.',
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
    name: 'update_board',
    description:
      'Update a board: name, description, and/or access_delegation (who may grant board access — workspace owners/admins only).',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: { type: 'string', format: 'uuid' },
        name: { type: 'string', maxLength: 80 },
        description: { type: 'string', maxLength: 4000 },
        access_delegation: { type: 'boolean' },
      },
      required: ['board_id'],
      additionalProperties: false,
    },
    op: 'update_board',
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
    name: 'update_list',
    description: 'Update a list: name and/or description.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', format: 'uuid' },
        name: { type: 'string', maxLength: 80 },
        description: { type: 'string', maxLength: 2000 },
      },
      required: ['list_id'],
      additionalProperties: false,
    },
    op: 'update_list',
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
        title: { type: 'string', maxLength: 200 },
        description: { type: 'string', maxLength: 8000 },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: "Optional priority; omit for none.",
        },
      },
      required: ['list_id', 'title'],
      additionalProperties: false,
    },
    op: 'create_card',
  },
  {
    name: 'update_card',
    description:
      'Update a card: title, description, priority, assignees, and/or tag_ids. Assignees and tag_ids are FULL replacement sets (like the web app). Newly assigned users get an assignment notification.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', format: 'uuid' },
        title: { type: 'string', maxLength: 200 },
        description: { type: 'string', maxLength: 8000 },
        priority: {
          type: 'string',
          enum: ['', 'low', 'medium', 'high', 'urgent'],
          description: "Pass an empty string to clear.",
        },
        assignees: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          description: 'Full replacement set of assignee user ids; newly added users get an assignment notification.',
        },
        tag_ids: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          description: 'Full replacement set of tag ids (see list_tags); like the web app.',
        },
      },
      required: ['card_id'],
      additionalProperties: false,
    },
    op: 'update_card',
  },
  {
    name: 'list_tags',
    description:
      'The workspace\'s shared tags (id, name, description). Returns { items, next_cursor } — pass next_cursor as cursor to page through.',
    inputSchema: {
      type: 'object',
      properties: { workspace_id: { type: 'string', format: 'uuid' }, ...PAGE_PARAMS },
      required: ['workspace_id'],
      additionalProperties: false,
    },
    op: 'list_tags',
  },
  {
    name: 'create_tag',
    description:
      'Create a tag in a workspace, or return the existing one with the same name (find-or-create). Names are lowercased, max 24 chars.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', format: 'uuid' },
        name: { type: 'string', maxLength: 24 },
        description: { type: 'string', maxLength: 500 },
      },
      required: ['workspace_id', 'name'],
      additionalProperties: false,
    },
    op: 'create_tag',
  },
  {
    name: 'rename_tag',
    description: 'Rename a tag. Workspace owners/admins only.',
    inputSchema: {
      type: 'object',
      properties: { tag_id: { type: 'string', format: 'uuid' }, name: { type: 'string', maxLength: 24 } },
      required: ['tag_id', 'name'],
      additionalProperties: false,
    },
    op: 'rename_tag',
  },
  {
    name: 'delete_tag',
    description: 'Delete a tag; cards linked to it simply lose it. Workspace owners/admins only.',
    inputSchema: {
      type: 'object',
      properties: { tag_id: { type: 'string', format: 'uuid' } },
      required: ['tag_id'],
      additionalProperties: false,
    },
    op: 'delete_tag',
  },
  {
    name: 'merge_tags',
    description:
      'Merge one tag into another: every card linked to source_tag_id becomes linked to target_tag_id instead, then the source tag is deleted. Workspace owners/admins only.',
    inputSchema: {
      type: 'object',
      properties: {
        source_tag_id: { type: 'string', format: 'uuid' },
        target_tag_id: { type: 'string', format: 'uuid' },
      },
      required: ['source_tag_id', 'target_tag_id'],
      additionalProperties: false,
    },
    op: 'merge_tags',
  },
  {
    name: 'move_card',
    description:
      'Move a card to a list. With position: an absolute number (use whole numbers, 1, 2, 3…). Without position: appends at the end of the list — atomic and safe for concurrent movers.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', format: 'uuid' },
        list_id: { type: 'string', format: 'uuid' },
        position: { type: 'number', description: 'Omit to append at the end of the list.' },
      },
      required: ['card_id', 'list_id'],
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
    description: `Comment on a card (max 2000 chars). ${MENTION_SYNTAX}`,
    inputSchema: {
      type: 'object',
      properties: { card_id: { type: 'string', format: 'uuid' }, body: { type: 'string', maxLength: 2000 } },
      required: ['card_id', 'body'],
      additionalProperties: false,
    },
    op: 'add_comment',
  },
  {
    name: 'edit_comment',
    description:
      'Edit a card comment. Authors edit their own; workspace owners/admins can edit anyone\'s. The comment keeps an edited marker.',
    inputSchema: {
      type: 'object',
      properties: { comment_id: { type: 'string', format: 'uuid' }, body: { type: 'string', maxLength: 2000 } },
      required: ['comment_id', 'body'],
      additionalProperties: false,
    },
    op: 'edit_comment',
  },
  {
    name: 'delete_comment',
    description:
      'Delete a card comment (soft delete: hidden from reads, kept for history). Authors delete their own; workspace owners/admins can delete anyone\'s.',
    inputSchema: {
      type: 'object',
      properties: { comment_id: { type: 'string', format: 'uuid' } },
      required: ['comment_id'],
      additionalProperties: false,
    },
    op: 'delete_comment',
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
    name: 'get_card_events',
    description:
      "The card's activity timeline: created, renamed, priority changes, description edits, list moves, assignee changes — with actor display names. Oldest first. Returns { items, next_cursor } — pass next_cursor as cursor to page through.",
    inputSchema: {
      type: 'object',
      properties: { card_id: { type: 'string', format: 'uuid' }, ...PAGE_PARAMS },
      required: ['card_id'],
      additionalProperties: false,
    },
    op: 'get_card_events',
  },
  {
    name: 'search',
    description:
      "Search across boards, cards, card comments, and board messages. Filters: query (case-insensitive substring), type ('card' | 'comment' | 'message' | 'board' | 'all'), author_id, team_id (author's team), board_id, tag_id (cards), priority (cards), from/to (ISO 8601, bounds created_at). Results carry a type discriminator plus board name and card number/title for context. Returns { items, next_cursor } — pass next_cursor as cursor to page through.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring match.' },
        type: { type: 'string', enum: ['card', 'comment', 'message', 'board', 'all'] },
        author_id: { type: 'string', format: 'uuid' },
        team_id: { type: 'string', format: 'uuid', description: "Only results whose author is on this team." },
        board_id: { type: 'string', format: 'uuid' },
        tag_id: { type: 'string', format: 'uuid', description: 'Cards carrying this tag.' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        from: { type: 'string', description: 'ISO 8601; lower bound on created_at (updated_at for type=board).' },
        to: { type: 'string', description: 'ISO 8601; upper bound on created_at (updated_at for type=board).' },
        ...PAGE_PARAMS,
      },
      additionalProperties: false,
    },
    op: 'search',
  },
  {
    name: 'check_mention_access',
    description:
      'Before mentioning people/teams in a board they may not see: returns blocked_users and blocked_teams (with display names) plus can_grant and can_request, so you can STOP and let your human decide. Mentions that reach nobody otherwise fail silently.',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: { type: 'string', format: 'uuid' },
        user_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
        team_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
      },
      required: ['board_id'],
      additionalProperties: false,
    },
    op: 'check_mention_access',
  },
  {
    name: 'grant_board_access',
    description:
      'Grant board access to users/teams and deliver the withheld mention. Only when the board\'s access delegation is on, or you are a workspace owner/admin (check_mention_access reports can_grant).',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: { type: 'string', format: 'uuid' },
        user_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
        team_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
        card_id: { type: 'string', format: 'uuid', description: 'Where the mention happened, if on a card.' },
        body: { type: 'string', description: 'Excerpt of the mentioning text (max 200 chars).' },
      },
      required: ['board_id'],
      additionalProperties: false,
    },
    op: 'grant_board_access',
  },
  {
    name: 'request_board_access',
    description:
      'Ask the workspace owners/admins to grant access for users/teams you mentioned (every one of them gets an access_request notification). Use when can_grant is false. Returns how many admins were asked.',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: { type: 'string', format: 'uuid' },
        user_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
        team_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
        card_id: { type: 'string', format: 'uuid' },
        body: { type: 'string', maxLength: 200 },
      },
      required: ['board_id'],
      additionalProperties: false,
    },
    op: 'request_board_access',
  },
  {
    name: 'resolve_access_request',
    description:
      'Workspace owners/admins: grant (true) or deny (false) a pending access request. Clears the request for EVERY admin, tells the asker, and on grant delivers the mention + access to the subject.',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: { type: 'string', format: 'uuid' },
        user_id: { type: 'string', format: 'uuid', description: 'The subject person (for user requests).' },
        team_id: { type: 'string', format: 'uuid', description: 'The subject team (for team requests).' },
        grant: { type: 'boolean' },
      },
      required: ['board_id', 'grant'],
      additionalProperties: false,
    },
    op: 'resolve_access_request',
  },
  {
    name: 'get_me',
    description: 'Your own profile (display name, email, avatar) and current status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    op: 'get_me',
  },
  {
    name: 'update_me',
    description: 'Update your own display name (max 80 chars).',
    inputSchema: {
      type: 'object',
      properties: { display_name: { type: 'string', maxLength: 80 } },
      required: ['display_name'],
      additionalProperties: false,
    },
    op: 'update_me',
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
    name: 'list_workspace_members',
    description:
      'Members of a workspace with display names, emails, and their workspace role. Use this to find user ids for mentions and assignments. Returns { items, next_cursor }.',
    inputSchema: {
      type: 'object',
      properties: { workspace_id: { type: 'string', format: 'uuid' }, ...PAGE_PARAMS },
      required: ['workspace_id'],
      additionalProperties: false,
    },
    op: 'list_workspace_members',
  },
  {
    name: 'get_user',
    description:
      'Profile summary for one user (display name, username, email, avatar). Only users you share a workspace with resolve; anyone else is "user not found or not visible".',
    inputSchema: {
      type: 'object',
      properties: { user_id: { type: 'string', format: 'uuid' } },
      required: ['user_id'],
      additionalProperties: false,
    },
    op: 'get_user',
  },
  {
    name: 'list_pending_invites',
    description:
      'Pending workspace invites: who was invited, when, by whom (display name), and status. Workspace owners/admins only.',
    inputSchema: {
      type: 'object',
      properties: { workspace_id: { type: 'string', format: 'uuid' }, ...PAGE_PARAMS },
      required: ['workspace_id'],
      additionalProperties: false,
    },
    op: 'list_pending_invites',
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
    name: 'update_team',
    description: 'Update a team: name and/or description.',
    inputSchema: {
      type: 'object',
      properties: {
        team_id: { type: 'string', format: 'uuid' },
        name: { type: 'string', maxLength: 60 },
        description: { type: 'string', maxLength: 500 },
      },
      required: ['team_id'],
      additionalProperties: false,
    },
    op: 'update_team',
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
    description: `Post a message to a board chat (max 4000 chars). ${MENTION_SYNTAX}`,
    inputSchema: {
      type: 'object',
      properties: { board_id: { type: 'string', format: 'uuid' }, body: { type: 'string', maxLength: 4000 } },
      required: ['board_id', 'body'],
      additionalProperties: false,
    },
    op: 'post_board_message',
  },
  {
    name: 'edit_board_message',
    description:
      'Edit a board chat message. Authors edit their own; workspace owners/admins can edit anyone\'s. Edits are soft — the row keeps an edited marker.',
    inputSchema: {
      type: 'object',
      properties: { message_id: { type: 'string', format: 'uuid' }, body: { type: 'string', maxLength: 4000 } },
      required: ['message_id', 'body'],
      additionalProperties: false,
    },
    op: 'edit_board_message',
  },
  {
    name: 'delete_board_message',
    description:
      'Delete a board chat message (soft delete: hidden from reads, kept for history). Authors delete their own; workspace owners/admins can delete anyone\'s.',
    inputSchema: {
      type: 'object',
      properties: { message_id: { type: 'string', format: 'uuid' } },
      required: ['message_id'],
      additionalProperties: false,
    },
    op: 'delete_board_message',
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
    description:
      'Your notifications (mentions, assignments, invites, access requests), newest first, with display names for actor/subject. Returns { items, next_cursor } — pass next_cursor as cursor to page through.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PAGE_PARAMS,
        filter: {
          type: 'string',
          enum: ['all', 'unread', 'read'],
          description: 'all (default), unread only, or read only.',
        },
      },
      additionalProperties: false,
    },
    op: 'list_notifications',
  },
  {
    name: 'mark_notification_read',
    description: 'Mark one of your notifications read.',
    inputSchema: {
      type: 'object',
      properties: { notification_id: { type: 'string', format: 'uuid' } },
      required: ['notification_id'],
      additionalProperties: false,
    },
    op: 'mark_notification_read',
  },
  {
    name: 'mark_notification_unread',
    description: 'Mark one of your notifications unread again.',
    inputSchema: {
      type: 'object',
      properties: { notification_id: { type: 'string', format: 'uuid' } },
      required: ['notification_id'],
      additionalProperties: false,
    },
    op: 'mark_notification_unread',
  },
  {
    name: 'mark_all_notifications_read',
    description: 'Mark every unread notification of yours read. Returns how many were marked.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    op: 'mark_all_notifications_read',
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

// ── OAuth: browser-based authorization (the MCP spec flow) ────────────────
// The edge function is the OAuth RESOURCE SERVER and (for discovery
// simplicity) also advertises itself as the authorization server; the
// consent page lives in the web app where the user's session is.
const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? 'https://flowdeck.tejusgupta.dev';
const RESOURCE_URL = `${new URL(Deno.env.get('SUPABASE_URL') ?? 'https://supabase.co').origin}/functions/v1/mcp`;

/** base64url(SHA-256(x)) — the PKCE S256 challenge of a verifier. */
async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let bin = '';
  for (const byte of new Uint8Array(digest)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Best-effort rate limiting: Supabase Edge Functions may run several
// isolates, so a per-isolate bucket throttles rather than hard-caps —
// still enough to make hammering the unauthenticated endpoints costly.
const rateBuckets = new Map<string, { tokens: number; last: number }>();
function rateAllow(key: string, capacity: number, refillPerSecond: number): boolean {
  if (rateBuckets.size > 5000) rateBuckets.clear();
  const now = Date.now();
  const bucket = rateBuckets.get(key) ?? { tokens: capacity, last: now };
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.last) / 1000) * refillPerSecond);
  bucket.last = now;
  if (bucket.tokens < 1) {
    rateBuckets.set(key, bucket);
    return false;
  }
  bucket.tokens -= 1;
  rateBuckets.set(key, bucket);
  return true;
}
function clientIp(request: Request): string {
  // The LAST hop is appended by the trusted platform proxy; the first
  // is client-controlled (round-3: first-hop keying was spoofable).
  const hops = request.headers.get('x-forwarded-for')?.split(',').map((h) => h.trim()) ?? [];
  return hops[hops.length - 1] ?? 'unknown';
}

function oauthError(status: number, code: string, description: string): Response {
  return json({ error: code, error_description: description }, status, {
    'Cache-Control': 'no-store',
  });
}

/** GET /.well-known/* — OAuth discovery for MCP clients. */
function oauthDiscovery(pathname: string): Response | null {
  if (pathname.endsWith('/.well-known/oauth-protected-resource')) {
    return json(
      // The authorization server is the APP origin, not this resource:
      // supabase.co's path-insertion and origin-root well-known URLs are
      // unroutable, so clients doing RFC 8414 discovery against it (VS Code)
      // fail. The app serves /.well-known/oauth-authorization-server at its
      // origin root, which every client can reach.
      { resource: RESOURCE_URL, authorization_servers: [APP_ORIGIN] },
      200,
      { 'Cache-Control': 'public, max-age=3600' },
    );
  }
  if (pathname.endsWith('/.well-known/oauth-authorization-server')) {
    return json(
      {
        // Kept in sync with the app's /.well-known/oauth-authorization-server
        // route so both origins advertise the same issuer.
        issuer: APP_ORIGIN,
        authorization_endpoint: `${APP_ORIGIN}/mcp/authorize`,
        token_endpoint: `${RESOURCE_URL}/token`,
        response_types: ['code'],
        grant_types: ['authorization_code'],
        code_challenge_methods: ['S256'],
      },
      200,
      { 'Cache-Control': 'public, max-age=3600' },
    );
  }
  return null;
}

/** POST /token — the authorization_code + PKCE exchange. Single-use
 * codes, 10-minute TTL, redirect_uri and client_id must match, and the
 * minted credential is a normal api_tokens PAT (shared revocation and
 * last-used tracking with the profile page). */
async function oauthTokenExchange(request: Request, service: ReturnType<typeof createClient>): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? '';
  let params: URLSearchParams;
  if (contentType.includes('application/json')) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) params.set(key, String(value));
  } else {
    // URLSearchParams percent-decodes application/x-www-form-urlencoded
    // per RFC 6749 — redirect_uri=https%3A%2F%2F… must match the stored
    // raw URI after decoding (round-3: the manual split didn't decode).
    params = new URLSearchParams(await request.text());
  }
  const grantType = params.get('grant_type');
  const code = params.get('code');
  const verifier = params.get('code_verifier');
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');

  if (grantType !== 'authorization_code') {
    return oauthError(400, 'unsupported_grant_type', 'only authorization_code is supported');
  }
  if (!code || !verifier || !clientId || !redirectUri) {
    return oauthError(400, 'invalid_request', 'code, code_verifier, client_id and redirect_uri are required');
  }

  const { data: stored } = await service
    .from('mcp_auth_codes')
    .select('id, user_id, client_id, redirect_uri, code_challenge, expires_at, used_at, workspace_scope, allowed_ops')
    .eq('code_hash', await sha256Hex(code))
    .maybeSingle();
  if (!stored || stored.used_at || new Date(stored.expires_at) < new Date()) {
    return oauthError(400, 'invalid_grant', 'code is unknown, expired, or already used');
  }
  if (stored.client_id !== clientId || stored.redirect_uri !== redirectUri) {
    return oauthError(400, 'invalid_grant', 'client_id or redirect_uri does not match');
  }
  if ((await pkceChallenge(verifier)) !== stored.code_challenge) {
    return oauthError(400, 'invalid_grant', 'PKCE verification failed');
  }

  // Single-use: claim the code; a racing exchange finds nothing.
  const { data: claimed } = await service
    .from('mcp_auth_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('id', stored.id)
    .is('used_at', null)
    .select('id')
    .maybeSingle();
  if (!claimed) {
    return oauthError(400, 'invalid_grant', 'code is unknown, expired, or already used');
  }

  const token = `fd_${Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
  const { error: insertError } = await service.from('api_tokens').insert({
    user_id: stored.user_id,
    name: `MCP: ${clientId}`.slice(0, 60),
    token_hash: await sha256Hex(token),
    workspace_scope: stored.workspace_scope ?? null,
    allowed_ops: stored.allowed_ops ?? null,
  });
  if (insertError) {
    return oauthError(500, 'server_error', 'could not mint the token');
  }
  return json(
    { access_token: token, token_type: 'Bearer' },
    200,
    { 'Cache-Control': 'no-store' },
  );
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  const requestUrl = new URL(request.url);
  // OAuth discovery (GET) — MCP clients look for the well-known paths
  // on the resource server.
  if (request.method === 'GET') {
    return (
      oauthDiscovery(requestUrl.pathname) ??
      json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST MCP messages here.' } },
        405,
      )
    );
  }
  // The OAuth token exchange (POST /token) — before PAT auth: this is
  // how PATs are minted, there is no token to present yet.
  if (request.method === 'POST' && requestUrl.pathname.endsWith('/token')) {
    if (!rateAllow(`token:${clientIp(request)}`, 10, 0.5)) {
      return oauthError(429, 'slow_down', 'too many token requests; retry shortly');
    }
    const service = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );
    return oauthTokenExchange(request, service);
  }
  // Streamable HTTP: this server only answers client POSTs.
  if (request.method !== 'POST') {
    return json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST MCP messages here.' } },
      405,
    );
  }

  // ── PAT auth ────────────────────────────────────────────────────────────
  if (!rateAllow(`mcp:${clientIp(request)}`, 100, 20)) {
    return json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests; slow down.' } },
      429,
      { 'Retry-After': '2' },
    );
  }
  const auth = request.headers.get('authorization') ?? '';
  const presented = auth.replace(/^Bearer\s+/i, '').trim();
  if (!presented.startsWith('fd_')) {
    return json(
      { jsonrpc: '2.0', error: { code: -32001, message: 'Missing or malformed token. Pass "Authorization: Bearer fd_…"' } },
      401,
      // RFC 9728 challenge: OAuth-capable clients start the browser flow
      // from this header alone.
      { 'WWW-Authenticate': `Bearer resource_metadata="${RESOURCE_URL}/.well-known/oauth-protected-resource"` },
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
    .select('id, user_id, workspace_scope, allowed_ops')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (tokenError || !tokenRow) {
    return json(
      { jsonrpc: '2.0', error: { code: -32001, message: 'Unknown token.' } },
      401,
      { 'WWW-Authenticate': `Bearer resource_metadata="${RESOURCE_URL}/.well-known/oauth-protected-resource"` },
    );
  }
  // Fire-and-forget last-used stamp (never blocks or fails the call).
  void service
    .from('api_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', tokenRow.id)
    .then(() => undefined, () => undefined);

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
        instructions:
          'Flowdeck boards, cards and chat. Start with get_me and list_workspaces; every list tool pages with next_cursor. Mentions use [Name](user:UUID) links — call check_mention_access first for people who may not see the board. This server is stateless: no sessions, no DELETE (the spec allows a stateless streamable-HTTP server); every call carries its own Bearer token.',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return reply(undefined);
    case 'ping':
      return reply({});
    case 'tools/list': {
      // Per-connection permissions (card #14): only the tools this
      // token may run are DELIVERED — the agent never sees the rest.
      const allowed = TOOLS.filter(
        (tool) => opAllowed(tokenRow.allowed_ops, tool.op),
      );
      return reply({
        tools: allowed.map((tool) => ({
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
      if (!opAllowed(tokenRow.allowed_ops, tool.op)) {
        return reply({
          content: [
            {
              type: 'text',
              text: `Error: this connection is not permitted to run ${name}. The owner can grant it on Flowdeck's consent page (re-connect) or from the profile page's API tokens.`,
            },
          ],
          isError: true,
        });
      }
      const { data, error } = await service.rpc('mcp_exec', {
        p_user_id: tokenRow.user_id,
        p_op: tool.op,
        p_arg: args,
        // The connection's workspace boundary (null = account-wide).
        p_workspace_ids: tokenRow.workspace_scope ?? [],
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

// The MCP connection docs — a hosted reference users read and agents use
// verbatim: endpoint, auth, client configs, and the full tool list with
// schemas. Static content (fast, crawlable, no session needed).
import { MembershipWatch } from '../../components/MembershipWatch';
import { For } from 'solid-js';
import { env } from 'virtual:solid-env/client';
import { brand } from '../../lib/brand';
import { SeoHead } from '../../lib/seo';

// The advertised MCP endpoint derives from the deployment's own base URL
// (baked at build from VITE_APP_URL) so a preview build shows the preview
// endpoint and a prod build shows prod. Falls back to the brand URL only
// for builds that don't advertise a base (local dev).
const MCP_URL = env.VITE_APP_URL
  ? `${env.VITE_APP_URL.replace(/\/+$/, '')}/api/mcp`
  : `${brand.url.replace(/\/+$/, '')}/api/mcp`;

const TOOLS: { name: string; args: string; returns: string; note?: string }[] = [
  {
    name: 'list_boards',
    args: 'cursor?, limit?',
    returns: '{ items, next_cursor } — boards you can see, newest activity first',
  },
  {
    name: 'get_board',
    args: 'board_id',
    returns: 'the board + its lists (no cards, no messages)',
    note: 'discover list ids here, then get_cards / list_board_messages',
  },
  {
    name: 'get_board_full',
    args: 'board_id',
    returns: 'legacy: board + lists + all cards + all messages, unpaged',
    note: 'flooding risk on active boards — prefer the split reads',
  },
  {
    name: 'get_cards',
    args: 'list_id, cursor?, limit?',
    returns: '{ items, next_cursor } — cards of one list, in board order',
  },
  {
    name: 'list_board_messages',
    args: 'board_id, cursor?, limit?',
    returns: '{ items, next_cursor } — board chat, oldest first',
  },
  {
    name: 'create_board',
    args: 'name, workspace_id?',
    returns: 'board_id',
    note: 'creates To do / In progress / Done lists; workspace defaults to your first one',
  },
  { name: 'rename_board', args: 'board_id, name', returns: '—' },
  {
    name: 'update_board',
    args: 'board_id, name?/description?/access_delegation?',
    returns: '—',
    note: 'access_delegation (who may grant board access) needs workspace owner/admin',
  },
  {
    name: 'delete_board',
    args: 'board_id, force?',
    returns: '—',
    note: 'destructive; a board with cards needs force: true (a deliberate purge)',
  },
  { name: 'create_list', args: 'board_id, name', returns: 'list_id' },
  { name: 'rename_list', args: 'list_id, name', returns: '—' },
  { name: 'update_list', args: 'list_id, name?/description?', returns: '—' },
  {
    name: 'delete_list',
    args: 'list_id',
    returns: '—',
    note: 'destructive: removes the list and its cards',
  },
  {
    name: 'create_card',
    args: 'list_id, title, description?, priority?',
    returns: 'card_id',
    note: 'appended to the end of the list; priority: low | medium | high | urgent',
  },
  {
    name: 'update_card',
    args: 'card_id, title?/description?/priority?/assignees?/tag_ids?',
    returns: '—',
    note: "priority: 'low' | 'medium' | 'high' | 'urgent' | '' (clear); assignees = full replacement set, newly added users get notified; tag_ids = full replacement set",
  },
  {
    name: 'list_tags',
    args: 'workspace_id, cursor?, limit?',
    returns: "{ items, next_cursor } — the workspace's shared tags",
  },
  {
    name: 'create_tag',
    args: 'workspace_id, name, description?',
    returns: 'tag_id',
    note: 'find-or-create; names lowercased, max 24 chars',
  },
  { name: 'rename_tag', args: 'tag_id, name', returns: '—', note: 'workspace owners/admins only' },

  {
    name: 'merge_tags',
    args: 'source_tag_id, target_tag_id',
    returns: '—',
    note: 'moves every link to the target and removes the source (the one deliberate removal); owners/admins only. Tags are otherwise never deleted — rename instead',
  },
  {
    name: 'move_card',
    args: 'card_id, list_id, position?',
    returns: '—',
    note: 'position omitted = append at the end (atomic, concurrency-safe); explicit position is absolute (whole numbers)',
  },
  {
    name: 'delete_card',
    args: 'card_id',
    returns: '—',
    note: 'refuses — cards are never deleted (the time capsule); resolve_card instead',
  },
  { name: 'add_comment', args: 'card_id, body', returns: 'comment_id' },
  { name: 'edit_comment', args: 'comment_id, body', returns: '—', note: 'own comments only' },
  {
    name: 'delete_comment',
    args: 'comment_id',
    returns: '—',
    note: "soft delete + tombstone; own, ws owners/admins, team admins on their team's boards",
  },
  {
    name: 'list_comments',
    args: 'card_id, cursor?, limit?',
    returns: "{ items, next_cursor } — the card's comments, oldest first",
  },
  {
    name: 'get_card_events',
    args: 'card_id, cursor?, limit?',
    returns:
      "{ items, next_cursor } — the card's timeline (created, renamed, priority, description, moved, assignees, tags, resolved) with actor display names; item ids are the event log's bigint identity and cursors are opaque",
  },
  {
    name: 'search',
    args: 'query?/type?/author_id?/team_id?/board_id?/tag_id?/priority?/from?/to?, cursor?, limit?',
    returns:
      '{ items, next_cursor } — boards, cards, comments, board messages (type-discriminated, with board name + card number/title)',
    note: 'e.g. type=comment + team_id + from/to → "all comments by Team 2 last week mentioning deploy"',
  },
  {
    name: 'check_mention_access',
    args: 'board_id, user_ids?, team_ids?',
    returns: 'blocked_users + blocked_teams (with names), can_grant, can_request',
    note: 'call BEFORE mentioning; a mention that cannot reach its target otherwise fails silently — stop and let your human decide',
  },
  {
    name: 'grant_board_access',
    args: 'board_id, user_ids?, team_ids?, card_id?, body?',
    returns: '—',
    note: "needs the board's access delegation or workspace owner/admin",
  },
  {
    name: 'request_board_access',
    args: 'board_id, user_ids?, team_ids?, card_id?, body?',
    returns: 'asked (count)',
    note: 'asks every workspace owner/admin',
  },
  {
    name: 'resolve_access_request',
    args: 'board_id, user_id | team_id, grant',
    returns: '—',
    note: 'owners/admins; clears the request for every admin and tells the asker',
  },
  {
    name: 'post_board_message',
    args: 'board_id, body',
    returns: 'message_id',
    note: 'posts to the board chat',
  },
  { name: 'edit_board_message', args: 'message_id, body', returns: '—', note: 'own messages only' },
  {
    name: 'delete_board_message',
    args: 'message_id',
    returns: '—',
    note: "soft delete + tombstone; own, ws owners/admins, team admins on their team's boards",
  },
  {
    name: 'list_workspaces',
    args: 'cursor?, limit?',
    returns: '{ items, next_cursor } — your workspaces + your role + the board-creation policy',
  },
  {
    name: 'list_workspace_members',
    args: 'workspace_id, cursor?, limit?',
    returns: '{ items, next_cursor } — members with display names, emails, workspace roles',
    note: 'use this to find user ids for mentions and assignments',
  },
  {
    name: 'get_user',
    args: 'user_id',
    returns: 'profile summary',
    note: 'only workspace co-members resolve',
  },
  {
    name: 'list_pending_invites',
    args: 'workspace_id, cursor?, limit?',
    returns: '{ items, next_cursor } — pending invites with inviter display names',
    note: 'workspace owners/admins only',
  },
  { name: 'create_workspace', args: 'name', returns: 'workspace_id', note: 'you become its owner' },
  {
    name: 'invite_member',
    args: 'workspace_id, email, role?',
    returns: 'invite_path — the accept link to share',
    note: 'owners/admins; the workspace invite allowlist applies',
  },
  {
    name: 'list_teams',
    args: 'workspace_id, cursor?, limit?',
    returns:
      '{ items, next_cursor } — teams with their members (user ids + display names + team roles)',
  },
  {
    name: 'create_team',
    args: 'workspace_id, name, description?',
    returns: 'team_id',
    note: 'owners/admins; workspace owners manage teams without being members',
  },
  { name: 'update_team', args: 'team_id, name?/description?', returns: '—' },
  {
    name: 'add_team_member',
    args: 'team_id, user_id, role?',
    returns: '—',
    note: 'the person must already be a workspace member',
  },
  { name: 'remove_team_member', args: 'team_id, user_id', returns: '—' },
  {
    name: 'list_notifications',
    args: 'cursor?, limit?, filter?',
    returns: '{ items, next_cursor } — your notifications with actor/subject display names',
    note: "filter: 'all' (default) | 'unread' | 'read'",
  },
  { name: 'mark_notification_read', args: 'notification_id', returns: '—' },
  { name: 'mark_notification_unread', args: 'notification_id', returns: '—' },
  { name: 'mark_all_notifications_read', args: '—', returns: 'marked (count)' },
  { name: 'get_me', args: '—', returns: 'your profile + current status' },
  {
    name: 'update_me',
    args: 'display_name',
    returns: '—',
    note: 'renames your own profile (max 80 chars)',
  },
  {
    name: 'set_status',
    args: 'emoji?, label?, dnd?',
    returns: '—',
    note: 'do-not-disturb silences toasts, sound and push',
  },
];

export default function McpDocsPage() {
  return (
    <main class="mx-auto max-w-3xl px-4 py-10">
      <MembershipWatch />
      <SeoHead
        title={`MCP — ${brand.name}`}
        description={`Connect AI agents to ${brand.name} over the Model Context Protocol — boards, cards, chat, workspaces, under your permissions.`}
        path="/docs/mcp"
      />
      <p class="text-xs font-semibold uppercase tracking-wider text-indigo-500">
        {brand.name} docs
      </p>
      <h1 class="mt-1 text-2xl font-bold tracking-tight">Connect your AI agents (MCP)</h1>
      <p class="mt-3 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
        {brand.name} speaks the{' '}
        <a
          href="https://modelcontextprotocol.io"
          class="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Model Context Protocol
        </a>{' '}
        over streamable HTTP. A connected agent can do everything your account can do in the web app
        — boards, cards, comments, board chat, workspaces, teams, invites, notifications, your
        status — and nothing more: every operation runs as you, under the same row-level security
        the app uses.
      </p>

      <h2 class="mt-8 text-lg font-semibold tracking-tight">1. Connect</h2>
      <p class="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
        OAuth-supporting clients (Claude Desktop, Cursor, …) connect with no setup: they open
        {brand.name}
        's consent page in your browser, you pick the which workspaces it may act in and, per
        entity, exactly which actions (read, create, update, delete) it may take, and the client
        receives its token. If your client wants a manual token instead, mint one on your{' '}
        <a href="/profile" class="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          Profile → MCP connections
        </a>{' '}
        page. Either way, revocation lives on that same profile page.
      </p>
      <p class="mt-3 text-sm text-neutral-600 dark:text-neutral-300">
        Every connection is named, and you choose exactly what it may do per workspace — entities
        (boards, cards, chat, tags…) and actions within them. Manage, re-permission, or revoke a
        connection any time on{' '}
        <a href="/profile" class="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          Profile → MCP connections
        </a>
        . Revoking signs the agent out immediately; reconnecting means running the sign-in flow
        again.
      </p>

      <h2 class="mt-8 text-lg font-semibold tracking-tight">
        2. Point your client at {brand.name}
      </h2>
      <p class="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
        The endpoint is{' '}
        <code class="break-all rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">
          {MCP_URL}
        </code>
      </p>
      <p class="mt-3 text-xs font-medium text-neutral-400">Claude Desktop / any MCP HTTP client</p>
      <pre class="mt-1 overflow-x-auto rounded-xl bg-neutral-950 p-4 text-xs leading-relaxed text-neutral-100">
        <code>{`{
  "mcpServers": {
    "flowdeck": {
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer orb_YOUR_TOKEN" }
    }
  }
}`}</code>
      </pre>

      <h2 class="mt-8 text-lg font-semibold tracking-tight">3. What your agent can do</h2>
      <p class="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
        {TOOLS.length} tools. A typical session: <code>list_workspaces</code> →{' '}
        <code>list_boards</code> → <code>get_board</code> (discovers ids) → <code>create_card</code>{' '}
        / <code>move_card</code> / <code>post_board_message</code>.
      </p>
      <div class="mt-3 overflow-x-auto rounded-2xl border border-neutral-200 dark:border-neutral-800">
        <table class="w-full text-left text-xs">
          <thead class="bg-neutral-50 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
            <tr>
              <th class="px-3 py-2 font-semibold">Tool</th>
              <th class="px-3 py-2 font-semibold">Arguments</th>
              <th class="px-3 py-2 font-semibold">Returns / notes</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100 dark:divide-neutral-800">
            <For each={TOOLS}>
              {(tool) => (
                <tr class="align-top">
                  <td class="px-3 py-2 font-mono font-semibold text-indigo-600 dark:text-indigo-400">
                    {tool.name}
                  </td>
                  <td class="px-3 py-2 font-mono text-neutral-500 dark:text-neutral-400">
                    {tool.args}
                  </td>
                  <td class="px-3 py-2 text-neutral-600 dark:text-neutral-300">
                    {tool.returns}
                    {tool.note ? <span class="block text-neutral-400">— {tool.note}</span> : null}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>

      <h2 class="mt-8 text-lg font-semibold tracking-tight">Mentions</h2>
      <p class="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
        Chat surfaces and card descriptions mention people, teams, and cards with link syntax:{' '}
        <code>[Name](user:UUID)</code>, <code>[Team](team:UUID)</code>, and{' '}
        <code>[Card title](card:UUID)</code> (cross-board cards render as “Board › Card”). Find user
        ids with <code>list_workspace_members</code> / <code>get_user</code> and team ids with{' '}
        <code>list_teams</code>. A mention the target cannot see (no board access) is not delivered
        — the agent should call <code>check_mention_access</code> first, then grant or request
        access based on <code>can_grant</code> / <code>can_request</code>.
      </p>

      <h2 class="mt-8 text-lg font-semibold tracking-tight">A skill for deep context</h2>
      <p class="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
        Tool descriptions carry the essentials, but the <code>skills/flowdeck/SKILL.md</code> file
        in the repository is the full operating manual for agents — workflows, mention etiquette,
        pagination, error meanings, and limits. Install it alongside the connection.
      </p>

      <h2 class="mt-8 text-lg font-semibold tracking-tight">Permissions, exactly</h2>
      <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-600 dark:text-neutral-300">
        <li>
          Every tool call runs <em>as you</em>, under the app's row-level security — an agent sees
          and touches only what you could.
        </li>
        <li>
          Workspace role rules apply: owners manage everything, admins manage members/teams/boards,
          members work where they have access.
        </li>
        <li>
          Per-board access matters too: <code>get_board</code> and <code>list_boards</code> carry{' '}
          <code>your_access</code> (<code>edit</code> or <code>view</code>) — on a view board,
          writes fail with an explicit read-only error instead of an opaque failure.
        </li>
        <li>
          Team ops follow the team-admin model; the invite allowlist applies to{' '}
          <code>invite_member</code>.
        </li>
        <li>
          Destructive tools (<code>delete_board</code>, <code>delete_list</code>) match the web
          app's own permission checks. Cards are never deleted — a board holding them purges only
          with <code>force: true</code>.
        </li>
      </ul>
    </main>
  );
}

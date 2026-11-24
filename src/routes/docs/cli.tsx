// The CLI setup docs — the stdio MCP bridge (npx flowdeck-mcp) for
// harnesses that prefer launching a local process over HTTP.
import { Title } from '@solidjs/meta';

import { MembershipWatch } from '../../components/MembershipWatch';

const MCP_URL = 'https://flowdeck.tejusgupta.dev/api/mcp';

export default function CliDocsPage() {
  return (
    <main class="mx-auto max-w-3xl px-4 py-10">
      <MembershipWatch />
      <Title>CLI — Flowdeck</Title>
      <p class="text-xs font-semibold uppercase tracking-wider text-indigo-500">Flowdeck docs</p>
      <h1 class="mt-1 text-2xl font-bold tracking-tight">CLI setup (stdio MCP)</h1>
      <p class="mt-3 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
        <code>flowdeck-mcp</code> is a dependency-free stdio bridge: it forwards MCP JSON-RPC from your agent's
        stdin to the Flowdeck MCP endpoint and writes responses back to stdout. All logic — tool definitions,
        authorization, every permission rule — lives on the server. Your agent can do exactly what the web app
        lets your account do, and nothing more.
      </p>

      <h2 class="mt-8 text-lg font-semibold tracking-tight">1. Token</h2>
      <p class="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
        Create one on{' '}
        <a href="/profile" class="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          Profile → API tokens
        </a>{' '}
        (starts with <code>fd_…</code>, shown once).
      </p>

      <h2 class="mt-8 text-lg font-semibold tracking-tight">2. Configure your agent</h2>
      <p class="mt-2 text-xs font-medium text-neutral-400">Claude Desktop / Cursor / any stdio MCP client</p>
      <pre class="mt-1 overflow-x-auto rounded-xl bg-neutral-950 p-4 text-xs leading-relaxed text-neutral-100"><code>{`{
  "mcpServers": {
    "flowdeck": {
      "command": "npx",
      "args": ["flowdeck-mcp"],
      "env": {
        "FLOWDECK_URL": "${MCP_URL}",
        "FLOWDECK_TOKEN": "fd_YOUR_TOKEN"
      }
    }
  }
}`}</code></pre>
      <p class="mt-3 text-xs font-medium text-neutral-400">Direct (advanced)</p>
      <pre class="mt-1 overflow-x-auto rounded-xl bg-neutral-950 p-4 text-xs leading-relaxed text-neutral-100"><code>{`FLOWDECK_URL=${MCP_URL} \\
FLOWDECK_TOKEN=fd_YOUR_TOKEN \\
npx flowdeck-mcp`}</code></pre>

      <h2 class="mt-8 text-lg font-semibold tracking-tight">Environment</h2>
      <div class="mt-2 overflow-x-auto rounded-2xl border border-neutral-200 dark:border-neutral-800">
        <table class="w-full text-left text-xs">
          <thead class="bg-neutral-50 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
            <tr>
              <th class="px-3 py-2 font-semibold">Variable</th>
              <th class="px-3 py-2 font-semibold">Required</th>
              <th class="px-3 py-2 font-semibold">Meaning</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100 dark:divide-neutral-800">
            <tr>
              <td class="px-3 py-2 font-mono">FLOWDECK_URL</td>
              <td class="px-3 py-2">no</td>
              <td class="px-3 py-2">The MCP endpoint. Defaults to this deployment's endpoint.</td>
            </tr>
            <tr>
              <td class="px-3 py-2 font-mono">FLOWDECK_TOKEN</td>
              <td class="px-3 py-2">yes</td>
              <td class="px-3 py-2">Your personal access token (Profile → API tokens).</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 class="mt-8 text-lg font-semibold tracking-tight">The tools</h2>
      <p class="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
        The CLI forwards every server tool — the full list with schemas lives in the{' '}
        <a href="/docs/mcp" class="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          MCP reference
        </a>
        : boards, lists, cards, comments, board chat, workspaces, invites, teams, notifications, and your
        status.
      </p>
      <p class="mt-8 text-xs text-neutral-400">
        Prefer connecting over HTTP without a local process?{' '}
        <a href="/docs/mcp" class="text-indigo-600 hover:underline dark:text-indigo-400">MCP connection docs</a>
      </p>
    </main>
  );
}

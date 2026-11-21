# flowdeck-mcp

Flowdeck's board operations as an [MCP](https://modelcontextprotocol.io) stdio server — connect any existing AI harness (Claude Desktop, Cursor, your own agent) straight to your boards.

The CLI is a dependency-free translator: it forwards MCP JSON-RPC from stdin to the Flowdeck MCP endpoint (streamable HTTP) and writes responses back to stdout. All logic — tool definitions, authorization, every permission rule — lives on the server. A token holder can do exactly what the web app lets them do, and nothing more.

## Setup

1. Create a token on your Flowdeck **Profile → API tokens** page. Copy it immediately — it's shown once.
2. Configure your MCP client to launch the CLI:

```json
{
  "mcpServers": {
    "flowdeck": {
      "command": "npx",
      "args": ["flowdeck-mcp"],
      "env": {
        "FLOWDECK_URL": "https://<your-project>.supabase.co/functions/v1/mcp",
        "FLOWDECK_TOKEN": "fd_…"
      }
    }
  }
}
```

Or run it directly:

```sh
FLOWDECK_URL=https://<your-project>.supabase.co/functions/v1/mcp \
FLOWDECK_TOKEN=fd_… \
node index.mjs
```

## The tools

`list_boards`, `get_board`, `create_board`, `rename_board`, `delete_board`, `create_list`, `rename_list`, `delete_list`, `create_card`, `update_card`, `move_card`, `delete_card`, `add_comment`, `list_comments`.

Typical session: `list_boards` → `get_board` (discovers list ids) → `create_card` / `move_card`.

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `FLOWDECK_URL` | the hosted Flowdeck endpoint | The MCP endpoint (streamable HTTP). |
| `FLOWDECK_TOKEN` | — (required) | Personal access token from the profile page. |

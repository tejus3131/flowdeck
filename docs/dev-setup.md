# Local development setup

Everything a new machine needs to run Orbit locally and connect to
the preview environment's MCP server.

## Prerequisites

- Node 24+, pnpm (`corepack enable`), Docker (for the Supabase stack)
- Supabase CLI 3.4.0 (`brew install supabase/tap/supabase` — keep the
  version in lockstep with CI, see `docs/ci-cd.md`)
- Wrangler (`npx wrangler` — no global install needed)

## Run the app locally

```bash
pnpm install
supabase start        # Postgres + auth + realtime on :54321
pnpm dev:node         # SSR in Node (:3000) — workerd can't reach the
                      # local realtime socket (see vite.config.ts)
```

`supabase db reset` rebuilds local schema from migrations — the only
way local schema ever changes.

## Preview MCP (workspace `.mcp.json`)

The committed `.mcp.json` connects VS Code's Copilot to the preview
MCP server. The Cloudflare Access service-token headers use
environment-variable references (`${NAME}`) — no secrets in the file.

Set the two variables in your shell environment (VS Code must be
launched from a shell that has them):

```bash
# macOS / Linux — ~/.zshrc or ~/.bashrc
export FLOWDECK_PREVIEW_CF_ACCESS_CLIENT_ID="<client id>"
export FLOWDECK_PREVIEW_CF_ACCESS_CLIENT_SECRET="<client secret>"
```

```powershell
# Windows (PowerShell, persistent per-user)
[Environment]::SetEnvironmentVariable("FLOWDECK_PREVIEW_CF_ACCESS_CLIENT_ID", "<client id>", "User")
[Environment]::SetEnvironmentVariable("FLOWDECK_PREVIEW_CF_ACCESS_CLIENT_SECRET", "<client secret>", "User")
```

Where the values come from: Cloudflare Zero Trust → Access → Service
Auth → the `orbit-preview-mcp` service token (ask a maintainer).
The Client Secret is shown once at token creation.

The first connection opens a browser for Orbit's OAuth consent
(you're already past Cloudflare Access in that browser); the minted
PAT authenticates the MCP session. The service token only passes
Cloudflare's gate — Orbit's own auth is the second layer.

## Local MCP

```bash
supabase functions serve mcp   # MCP on :54321/functions/v1/mcp
```

Point an MCP client at `http://127.0.0.1:54321/functions/v1/mcp` with
a PAT minted from the local stack.

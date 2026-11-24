-- Task: user-named MCP connections. The consent flow asks the user to
-- name the connection; the name rides the auth code and lands on the
-- minted token (api_tokens.name) so the connections page shows it.
alter table public.mcp_auth_codes
  add column if not exists connection_name text;

-- 0047: per-connection tool permissions (card #14).
--
-- Connecting MCP used to grant the account's full power. Now every
-- token carries allowed_ops — the flat list of mcp_exec op names it may
-- run. NULL keeps the account-wide behavior for every existing token.
-- The edge function enforces the boundary at tools/list (only allowed
-- tools are DELIVERED to the agent) and tools/call (a clear
-- "not permitted on this connection" error for the rest).
--
-- The consent page grants by CATEGORY (read / cards / chat / tags /
-- boards / teams / workspace / profile / notifications / access) with
-- a safe default: read + profile + notifications only. Writing and
-- administrative categories are opt-in.
--
-- Permissions can never be mutated through MCP itself: no mcp_exec op
-- touches api_tokens; they change only through the consent page or the
-- profile page (revoke + re-consent).

alter table public.api_tokens add column allowed_ops text[];
alter table public.mcp_auth_codes add column allowed_ops text[];

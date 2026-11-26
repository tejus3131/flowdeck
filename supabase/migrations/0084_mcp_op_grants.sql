-- Phase 5 (ADR-5): the per-op function grants. CREATE FUNCTION defaults
-- EXECUTE to PUBLIC — the 0080-0083 extractions therefore left every
-- mcp_<op>() callable by anon (blocked only by the mcp_caller_ok guard)
-- and authenticated (which is exactly the web path we want, but by
-- accident, not by decision).
--
-- This migration makes the grant surface explicit and minimal:
--   * service_role — the MCP path (mcp_exec sets role 'authenticated'
--     before dispatch, so its per-op calls execute as authenticated; the
--     service grant covers direct administrative use)
--   * authenticated — the web single-write-path (ADR-5): the web app's
--     server fns call the same per-op functions the MCP dispatcher does,
--     under the caller's own JWT. mcp_caller_ok pins p_user_id to the
--     JWT subject, RLS governs every row the function touches, and the
--     flowdeck.agent provenance flag stays absent (web writes are not
--     agent-made).
--   * anon — revoked. Anonymous has no JWT subject, so no per-op call
--     can ever pass the guard; the grant was pure dead surface.
--   * mcp_exec stays service_role-only (its 0080-and-earlier hardening):
--     it TRUSTS p_user_id (the edge function resolves PATs with the
--     service key); only the per-op functions carry the caller guard.
--
-- mcp_caller_ok itself stays PUBLIC-readable (it is a pure predicate —
-- no data beyond the caller's own claims).

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'mcp\_%'
      -- the dispatcher and the helpers keep their existing grants
      and p.proname not in (
        'mcp_exec', 'mcp_caller_ok', 'mcp_scope_ok', 'mcp_op_ok',
        'mcp_write_error', 'mcp_dismiss_access_requests',
        'mcp_cursor_key', 'mcp_cursor_id', 'mcp_cursor_tstz',
        'mcp_cursor_num', 'mcp_cursor_int'
      )
  loop
    execute format('revoke execute on function %s from public, anon', r.fn);
    execute format('grant execute on function %s to authenticated, service_role', r.fn);
  end loop;end $$;

-- Phase 5 (ADR-5), migration 3 of the decomposition: the workspace, team,
-- member, access-flow, notification and status op branches move into their
-- own functions under the per-op contract from 0080 (caller's RLS context,
-- mcp_caller_ok guard, inherited agent flag); mcp_exec's branches become
-- one-line dispatches. Bodies move verbatim.
--
-- The account-level ops (update_me, set_status, the notification marks)
-- keep their '*' bucket semantics: mcp_op_ok(p_ws_ops, '<op>', null).
--
-- Also drops a duplicated '── tags ──' section comment the 0081 splice
-- left behind in mcp_exec (cosmetic; the single remaining header stays).


create or replace function public.mcp_update_me(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Account-level op: granted via the '*' bucket when the
  -- connection uses per-workspace permissions.
  if not public.mcp_op_ok(p_ws_ops, 'update_me', null) then
    raise exception 'this connection does not have that permission';
  end if;

  -- The app's profile edit: display name only (avatar is a file upload).
  if p_arg ? 'display_name' then
    if nullif(btrim(p_arg->>'display_name'), '') is null then
      raise exception 'display name cannot be empty';
    end if;
    update public.profiles set display_name = left(btrim(p_arg->>'display_name'), 80)
    where id = p_user_id;
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('display_name', (select display_name from public.profiles where id = p_user_id)));

end;
$$;


create or replace function public.mcp_mark_notification_read(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Account-level op: granted via the '*' bucket when the
  -- connection uses per-workspace permissions.
  if not public.mcp_op_ok(p_ws_ops, 'mark_notification_read', null) then
    raise exception 'this connection does not have that permission';
  end if;

  update public.notifications set seen_at = now()
  where id = (p_arg->>'notification_id')::uuid and user_id = p_user_id;
  if not found then raise exception 'notification not found'; end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('notification_id', (p_arg->>'notification_id')::uuid, 'seen', true));

end;
$$;


create or replace function public.mcp_mark_notification_unread(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Account-level op: granted via the '*' bucket when the
  -- connection uses per-workspace permissions.
  if not public.mcp_op_ok(p_ws_ops, 'mark_notification_unread', null) then
    raise exception 'this connection does not have that permission';
  end if;

  update public.notifications set seen_at = null
  where id = (p_arg->>'notification_id')::uuid and user_id = p_user_id;
  if not found then raise exception 'notification not found'; end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('notification_id', (p_arg->>'notification_id')::uuid, 'seen', false));

end;
$$;


create or replace function public.mcp_mark_all_notifications_read(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_count int;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Account-level op: granted via the '*' bucket when the
  -- connection uses per-workspace permissions.
  if not public.mcp_op_ok(p_ws_ops, 'mark_all_notifications_read', null) then
    raise exception 'this connection does not have that permission';
  end if;

  update public.notifications n set seen_at = now()
  where n.user_id = p_user_id and n.seen_at is null
    and (cardinality(p_scope) = 0 or exists (
          select 1 from public.boards b
          where b.id = n.board_id and public.mcp_scope_ok(p_scope, b.workspace_id) and public.mcp_op_ok(p_ws_ops, 'mark_all_notifications_read', b.workspace_id)));
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('marked', v_count));

end;
$$;


create or replace function public.mcp_create_workspace(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_new_id uuid;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Account-level op: granted via the '*' bucket when the
  -- connection uses per-workspace permissions.
  if not public.mcp_op_ok(p_ws_ops, 'create_workspace', null) then
    raise exception 'this connection does not have that permission';
  end if;

  -- The scope compartmentalization only vetoes LEGACY tokens — for
  -- them, scope is the only grant boundary. A per-workspace token
  -- that carries the account 'create workspaces' grant creates
  -- regardless of which workspaces it is scoped to: the account
  -- bucket is the user's explicit, separate choice.
  if p_ws_ops is null and cardinality(p_scope) > 0 then
    raise exception 'a workspace-scoped connection cannot create workspaces';
  end if;
  insert into public.workspaces (name, slug, owner_id)
  values (left(coalesce(p_arg->>'name', 'Untitled'), 80),
          -- Random suffix: two workspaces in the same second by the
          -- same user no longer collide on the slug.
          'ws-' || left(p_user_id::text, 8) || '-' || floor(extract(epoch from now()))::int::text
            || '-' || substr(md5(random()::text), 1, 4),
          p_user_id)
  returning id into v_new_id;
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_new_id, p_user_id, 'owner');
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('workspace_id', v_new_id));

end;
$$;


create or replace function public.mcp_invite_member(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_ws uuid;
  v_token text;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  v_ws := (p_arg->>'workspace_id')::uuid;
  if not public.mcp_scope_ok(p_scope, v_ws)
       or not public.mcp_op_ok(p_ws_ops, 'invite_member', v_ws) then
    raise exception 'this connection does not have that permission in this workspace';
  end if;
  -- The domain allowlist applies here exactly as in the web app.
  if exists (
    select 1 from public.workspaces w
    where w.id = v_ws and coalesce(array_length(w.invite_domains, 1), 0) > 0
  ) and not exists (
    select 1 from public.workspaces w
    where w.id = v_ws
      and lower(split_part(coalesce(p_arg->>'email', 'x@y'), '@', 2)) = any (w.invite_domains)
  ) then
    raise exception 'email domain is not in this workspace''s invite allowlist';
  end if;
  insert into public.workspace_invites (workspace_id, email, role, status, invited_by)
  values (v_ws, lower(coalesce(p_arg->>'email', '')),
          case when p_arg->>'role' = 'admin' then 'admin' else 'member' end,
          'pending', p_user_id)
  on conflict (workspace_id, email) do update
    set status = 'pending', role = excluded.role, invited_by = excluded.invited_by
  returning token into v_token;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('invite_path', '/invite/' || v_token));

-- ── teams ────────────────────────────────────────────────────────────
end;
$$;


create or replace function public.mcp_create_team(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_ws uuid;
  v_new_id uuid;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  v_ws := (p_arg->>'workspace_id')::uuid;
  if not public.mcp_scope_ok(p_scope, v_ws)
       or not public.mcp_op_ok(p_ws_ops, 'create_team', v_ws) then
    raise exception 'this connection does not have that permission in this workspace';
  end if;
  if public.user_workspace_role(v_ws) not in ('owner', 'admin') then
    raise exception 'workspace owners/admins only';
  end if;
  insert into public.teams (workspace_id, name, description)
  values (v_ws, left(coalesce(p_arg->>'name', 'New team'), 60),
          coalesce(p_arg->>'description', ''))
  returning id into v_new_id;
  -- The app's rule: workspace owners manage every team through their
  -- workspace powers and are NOT members by default; anyone else
  -- founds the team as its admin.
  if not exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = v_ws and wm.user_id = p_user_id and wm.role = 'owner'
  ) then
    insert into public.team_members (team_id, user_id, role)
    values (v_new_id, p_user_id, 'admin');
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('team_id', v_new_id));

end;
$$;


create or replace function public.mcp_update_team(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_new_id uuid;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  v_new_id := (p_arg->>'team_id')::uuid;
  if not public.mcp_scope_ok(p_scope, (select t.workspace_id from public.teams t where t.id = v_new_id))
       or not public.mcp_op_ok(p_ws_ops, 'update_team', (select t.workspace_id from public.teams t where t.id = v_new_id)) then
    raise exception 'this connection does not have that permission in this workspace';
  end if;
  if p_arg ? 'name' then
    if nullif(p_arg->>'name', '') is null then
      raise exception 'team name cannot be empty';
    end if;
    update public.teams set name = left(p_arg->>'name', 60) where id = v_new_id;
    if not found then raise exception 'team not found or no access'; end if;
  end if;
  if p_arg ? 'description' then
    update public.teams set description = left(p_arg->>'description', 500) where id = v_new_id;
    if not found then raise exception 'team not found or no access'; end if;
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('team_id', v_new_id) || coalesce((select jsonb_build_object('name', t.name, 'description', t.description) from public.teams t where t.id = v_new_id), '{}'::jsonb));

end;
$$;


create or replace function public.mcp_add_team_member(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  if not public.mcp_scope_ok(p_scope, (select t.workspace_id from public.teams t where t.id = (p_arg->>'team_id')::uuid))
       or not public.mcp_op_ok(p_ws_ops, 'add_team_member', (select t.workspace_id from public.teams t where t.id = (p_arg->>'team_id')::uuid)) then
    raise exception 'this connection does not have that permission in this workspace';
  end if;
  insert into public.team_members (team_id, user_id, role)
  values ((p_arg->>'team_id')::uuid, (p_arg->>'user_id')::uuid,
          case when p_arg->>'role' = 'admin' then 'admin' else 'member' end)
  on conflict (team_id, user_id) do update set role = excluded.role;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('team_id', (p_arg->>'team_id')::uuid, 'user_id', (p_arg->>'user_id')::uuid, 'role', case when p_arg->>'role' = 'admin' then 'admin' else 'member' end));

end;
$$;


create or replace function public.mcp_remove_team_member(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  if not public.mcp_scope_ok(p_scope, (select t.workspace_id from public.teams t where t.id = (p_arg->>'team_id')::uuid))
       or not public.mcp_op_ok(p_ws_ops, 'remove_team_member', (select t.workspace_id from public.teams t where t.id = (p_arg->>'team_id')::uuid)) then
    raise exception 'this connection does not have that permission in this workspace';
  end if;
  delete from public.team_members
  where team_id = (p_arg->>'team_id')::uuid and user_id = (p_arg->>'user_id')::uuid;
  if not found then raise exception 'member not found or no access'; end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('team_id', (p_arg->>'team_id')::uuid, 'user_id', (p_arg->>'user_id')::uuid, 'removed', true));

end;
$$;


create or replace function public.mcp_check_mention_access(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_board_id uuid;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  v_board_id := (p_arg->>'board_id')::uuid;
  if not public.mcp_scope_ok(p_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
       or not public.mcp_op_ok(p_ws_ops, 'check_mention_access', (select b.workspace_id from public.boards b where b.id = v_board_id)) then
    raise exception 'this connection does not have that permission in this workspace';
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'blocked_users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', x::uuid,
        'name', (select pr.display_name from public.profiles pr where pr.id = x::uuid)
      ) order by x)
      from jsonb_array_elements_text(coalesce(p_arg->'user_ids', '[]'::jsonb)) as x
      where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and not exists (select 1 from public.board_access ba
                        where ba.board_id = v_board_id and ba.user_id = x::uuid)
        and (select b.owner_id from public.boards b where b.id = v_board_id) is distinct from x::uuid
        and not exists (
          select 1 from public.workspace_members wm
          join public.boards b on b.id = v_board_id and b.workspace_id = wm.workspace_id
          where wm.user_id = x::uuid and wm.role in ('owner', 'admin'))
        and not exists (
          select 1 from public.team_members tm
          join public.board_team_access bta on bta.team_id = tm.team_id
          where bta.board_id = v_board_id and tm.user_id = x::uuid)
    ), '[]'::jsonb),
    'blocked_teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'team_id', x::uuid,
        'name', (select t.name from public.teams t where t.id = x::uuid)
      ) order by x)
      from jsonb_array_elements_text(coalesce(p_arg->'team_ids', '[]'::jsonb)) as x
      where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and exists (select 1 from public.teams t where t.id = x::uuid and t.deactivated_at is null)
        and not exists (select 1 from public.board_team_access bta
                        where bta.board_id = v_board_id and bta.team_id = x::uuid)
    ), '[]'::jsonb),
    'can_grant',
      public.user_is_workspace_admin_of_board(v_board_id)
      or coalesce((select b.access_delegation from public.boards b where b.id = v_board_id), false),
    'can_request', true
  ));

end;
$$;


create or replace function public.mcp_grant_board_access(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_board_id uuid;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  v_board_id := (p_arg->>'board_id')::uuid;
  if not exists (select 1 from public.boards b where b.id = v_board_id) then
    raise exception 'board not found or no access';
  end if;
  if not public.mcp_scope_ok(p_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
       or not public.mcp_op_ok(p_ws_ops, 'grant_board_access', (select b.workspace_id from public.boards b where b.id = v_board_id)) then
    raise exception 'this connection does not have that permission in this workspace';
  end if;
  -- The gate mirrors the board_access INSERT policy exactly (the app
  -- relies on it; the old op gate was looser, which let a viewer on a
  -- delegation-enabled board pass the check, fail the insert
  -- silently, and still send the 'granted' notifications — spoof).
  if not (
    public.user_is_workspace_admin_of_board(v_board_id)
    or (coalesce((select b.access_delegation from public.boards b where b.id = v_board_id), false)
        and public.user_board_access(v_board_id) = 'edit')
    or public.user_is_team_admin_on_board(v_board_id)
  ) then
    raise exception 'you cannot grant access on this board (needs the board''s access delegation setting with edit access, or a workspace owner/admin)';
  end if;
  -- Valid subjects only: strict uuids that exist. A bogus id must
  -- never kill the op with a raw FK error.
  create temp table if not exists mcp_grant_users (user_id uuid primary key) on commit preserve rows;
  -- (session-scoped temp tables: recreate-per-call would break plpgsql plan caches)
  create temp table if not exists mcp_grant_teams (team_id uuid primary key) on commit preserve rows;
  -- (session-scoped temp tables: recreate-per-call would break plpgsql plan caches)
  delete from mcp_grant_users;
  insert into mcp_grant_users
  select distinct x::uuid
  from jsonb_array_elements_text(coalesce(p_arg->'user_ids', '[]'::jsonb)) as x
  where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and exists (select 1 from public.profiles pr where pr.id = x::uuid);
  delete from mcp_grant_teams;
  insert into mcp_grant_teams
  select distinct x::uuid
  from jsonb_array_elements_text(coalesce(p_arg->'team_ids', '[]'::jsonb)) as x
  where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and exists (select 1 from public.teams t where t.id = x::uuid);
  if (select count(*) from mcp_grant_users) + (select count(*) from mcp_grant_teams)
     < jsonb_array_length(coalesce(p_arg->'user_ids', '[]'::jsonb))
       + jsonb_array_length(coalesce(p_arg->'team_ids', '[]'::jsonb)) then
    raise exception 'unknown user or team in the request';
  end if;
  -- The grants themselves (RLS-checked).
  insert into public.board_access (board_id, user_id, access)
  select v_board_id, u.user_id, 'edit' from mcp_grant_users u
  on conflict (board_id, user_id) do nothing;
  insert into public.board_team_access (board_id, team_id, access)
  select v_board_id, t.team_id, 'edit' from mcp_grant_teams t
  on conflict (board_id, team_id) do nothing;
  -- Notify ONLY what actually landed (an RLS-dropped insert must not
  -- produce fake 'granted' notifications).
  create temp table if not exists mcp_granted_ok (user_id uuid primary key) on commit preserve rows;
  -- (session-scoped temp tables: recreate-per-call would break plpgsql plan caches)
  delete from mcp_granted_ok;
  insert into mcp_granted_ok
  select ba.user_id from public.board_access ba
  join mcp_grant_users u on u.user_id = ba.user_id
  where ba.board_id = v_board_id;
  if (select count(*) from mcp_grant_users) + (select count(*) from mcp_grant_teams) > 0
     and (select count(*) from mcp_granted_ok) = 0
     and (select count(*) from public.board_team_access
          where board_id = v_board_id and team_id in (select team_id from mcp_grant_teams)) = 0 then
    raise exception 'you cannot grant access on this board';
  end if;
  insert into public.notifications (user_id, kind, card_id, board_id, actor_id, subject_id, body)
  select g.user_id, 'mention', nullif(p_arg->>'card_id','')::uuid, v_board_id, p_user_id,
         null, left(coalesce(p_arg->>'body', ''), 200)
  from mcp_granted_ok g;
  insert into public.notifications (user_id, kind, board_id, actor_id, subject_id)
  select g.user_id, 'access_granted', v_board_id, p_user_id, null
  from mcp_granted_ok g;
  insert into public.notifications (user_id, kind, card_id, board_id, actor_id, subject_id)
  select p_user_id, 'access_provided', nullif(p_arg->>'card_id','')::uuid, v_board_id, p_user_id, g.user_id
  from mcp_granted_ok g;
  insert into public.notifications (user_id, kind, card_id, board_id, actor_id, subject_team_id, body)
  select tm.user_id, 'mention', nullif(p_arg->>'card_id','')::uuid, v_board_id, p_user_id,
         t.team_id, left(coalesce(p_arg->>'body', ''), 200)
  from mcp_grant_teams t
  join public.team_members tm on tm.team_id = t.team_id
  where exists (select 1 from public.board_team_access bta
                where bta.board_id = v_board_id and bta.team_id = t.team_id);
  insert into public.notifications (user_id, kind, board_id, actor_id, subject_team_id)
  select tm.user_id, 'access_granted', v_board_id, p_user_id, t.team_id
  from mcp_grant_teams t
  join public.team_members tm on tm.team_id = t.team_id
  where exists (select 1 from public.board_team_access bta
                where bta.board_id = v_board_id and bta.team_id = t.team_id);
  insert into public.notifications (user_id, kind, card_id, board_id, actor_id, subject_team_id)
  select p_user_id, 'access_provided', nullif(p_arg->>'card_id','')::uuid, v_board_id, p_user_id, t.team_id
  from mcp_grant_teams t
  where exists (select 1 from public.board_team_access bta
                where bta.board_id = v_board_id and bta.team_id = t.team_id);
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('board_id', v_board_id, 'granted_users', (select count(*) from mcp_granted_ok), 'granted_teams', (select count(*) from public.board_team_access bta where bta.board_id = v_board_id and bta.team_id in (select team_id from mcp_grant_teams))));

end;
$$;


create or replace function public.mcp_request_board_access(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_board_id uuid;
  v_ws uuid;
  v_count int;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  v_board_id := (p_arg->>'board_id')::uuid;
  if not exists (select 1 from public.boards b where b.id = v_board_id) then
    raise exception 'board not found or no access';
  end if;
  if not public.mcp_scope_ok(p_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
       or not public.mcp_op_ok(p_ws_ops, 'request_board_access', (select b.workspace_id from public.boards b where b.id = v_board_id)) then
    raise exception 'this connection does not have that permission in this workspace';
  end if;
  select b.workspace_id into v_ws from public.boards b where b.id = v_board_id;
  if v_ws is null then raise exception 'board not found'; end if;
  -- Valid subjects only (strict uuids that exist as profiles/teams).
  create temp table if not exists mcp_req_subjects (kind text, subject uuid, primary key (kind, subject)) on commit preserve rows;
  delete from mcp_req_subjects;
  insert into mcp_req_subjects
  select 'user', x::uuid
  from jsonb_array_elements_text(coalesce(p_arg->'user_ids', '[]'::jsonb)) as x
  where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and exists (select 1 from public.profiles pr where pr.id = x::uuid);
  insert into mcp_req_subjects
  select 'team', x::uuid
  from jsonb_array_elements_text(coalesce(p_arg->'team_ids', '[]'::jsonb)) as x
  where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and exists (select 1 from public.teams t where t.id = x::uuid);
  if (select count(*) from mcp_req_subjects)
     < jsonb_array_length(coalesce(p_arg->'user_ids', '[]'::jsonb))
       + jsonb_array_length(coalesce(p_arg->'team_ids', '[]'::jsonb)) then
    raise exception 'unknown user or team in the request';
  end if;
  -- Ask every workspace owner/admin except the caller, per subject —
  -- but only when a PENDING request for the same (board, subject)
  -- doesn't already exist (repeat calls must not spam).
  insert into public.notifications (user_id, kind, card_id, board_id, actor_id, subject_id, subject_team_id, body)
  select wm.user_id, 'access_request', nullif(p_arg->>'card_id','')::uuid, v_board_id, p_user_id,
         case when rs.kind = 'user' then rs.subject else null end,
         case when rs.kind = 'team' then rs.subject else null end,
         left(coalesce(p_arg->>'body', ''), 200)
  from public.workspace_members wm
  cross join mcp_req_subjects rs
  where wm.workspace_id = v_ws
    and wm.role in ('owner', 'admin')
    and wm.user_id <> p_user_id
    and not exists (
      select 1 from public.notifications n
      where n.kind = 'access_request'
        and n.board_id = v_board_id
        and n.seen_at is null
        and ((rs.kind = 'user' and n.subject_id = rs.subject)
          or (rs.kind = 'team' and n.subject_team_id = rs.subject))
    );
  -- 'asked' is what THIS call actually sent, not the admin count.
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('asked', v_count));

end;
$$;


create or replace function public.mcp_resolve_access_request(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_board_id uuid;
  v_dismissed jsonb;
  v_askers uuid[];
  v_cards uuid[];
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  v_board_id := (p_arg->>'board_id')::uuid;
  if not exists (select 1 from public.boards b where b.id = v_board_id) then
    raise exception 'board not found or no access';
  end if;
  if not public.mcp_scope_ok(p_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
       or not public.mcp_op_ok(p_ws_ops, 'resolve_access_request', (select b.workspace_id from public.boards b where b.id = v_board_id)) then
    raise exception 'this connection does not have that permission in this workspace';
  end if;
  if not public.user_is_workspace_admin_of_board(v_board_id) then
    raise exception 'only workspace owners and admins can resolve access requests';
  end if;
  -- Guarded SECURITY DEFINER helper dismisses the pending requests
  -- (cross-user notification writes) and reports the askers.
  v_dismissed := public.mcp_dismiss_access_requests(
    v_board_id,
    case when p_arg ? 'user_id' then (p_arg->>'user_id')::uuid else null end,
    case when p_arg ? 'team_id' then (p_arg->>'team_id')::uuid else null end
  );
  v_askers := coalesce((
    select array_agg(a::uuid)
    from jsonb_array_elements_text(v_dismissed->'askers') as a
  ), '{}'::uuid[]);
  v_cards := coalesce((
    select array_agg(c::uuid)
    from jsonb_array_elements_text(v_dismissed->'cards') as c
  ), '{}'::uuid[]);
  if p_arg->>'grant' = 'true' then
    if p_arg ? 'user_id' then
      insert into public.board_access (board_id, user_id, access)
      values (v_board_id, (p_arg->>'user_id')::uuid, 'edit')
      on conflict (board_id, user_id) do nothing;
      insert into public.notifications (user_id, kind, board_id, actor_id, subject_id)
      values ((p_arg->>'user_id')::uuid, 'access_granted', v_board_id, p_user_id, null);
    else
      insert into public.board_team_access (board_id, team_id, access)
      values (v_board_id, (p_arg->>'team_id')::uuid, 'edit')
      on conflict (board_id, team_id) do nothing;
      insert into public.notifications (user_id, kind, board_id, actor_id, subject_team_id)
      select tm.user_id, 'access_granted', v_board_id, p_user_id, (p_arg->>'team_id')::uuid
      from public.team_members tm where tm.team_id = (p_arg->>'team_id')::uuid;
    end if;
  end if;
  -- Every asker learns the outcome.
  insert into public.notifications (user_id, kind, card_id, board_id, actor_id, subject_id, subject_team_id)
  select a, case when p_arg->>'grant' = 'true' then 'access_provided' else 'access_denied' end,
         nullif(p_arg->>'card_id','')::uuid, v_board_id, p_user_id,
         case when p_arg ? 'user_id' then (p_arg->>'user_id')::uuid else null end,
         case when p_arg ? 'team_id' then (p_arg->>'team_id')::uuid else null end
  from unnest(v_askers) as a;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('board_id', v_board_id, 'granted', (p_arg->>'grant')::boolean, 'user_id', nullif(p_arg->>'user_id','')::uuid, 'team_id', nullif(p_arg->>'team_id','')::uuid, 'askers_notified', coalesce(array_length(v_askers, 1), 0)));
end;
$$;


create or replace function public.mcp_set_status(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Account-level op: granted via the '*' bucket when the
  -- connection uses per-workspace permissions.
  if not public.mcp_op_ok(p_ws_ops, 'set_status', null) then
    raise exception 'this connection does not have that permission';
  end if;
  insert into public.user_status (user_id, emoji, label, dnd, updated_at)
  values (p_user_id, nullif(p_arg->>'emoji', ''),
          left(coalesce(p_arg->>'label', ''), 60),
          coalesce((p_arg->>'dnd')::boolean, false), now())
  on conflict (user_id) do update
    set emoji = excluded.emoji,
        label = excluded.label,
        dnd = excluded.dnd,
        updated_at = now();
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('emoji', nullif(p_arg->>'emoji', ''), 'label', left(coalesce(p_arg->>'label', ''), 60), 'dnd', coalesce((p_arg->>'dnd')::boolean, false)));

end;
$$;

CREATE OR REPLACE FUNCTION public.mcp_exec(p_user_id uuid, p_op text, p_arg jsonb DEFAULT '{}'::jsonb, p_workspace_ids uuid[] DEFAULT '{}'::uuid[], p_ws_ops jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_board_id uuid;
  v_list_id  uuid;
  v_card_id  uuid;
  v_pos      double precision;
  v_resolved timestamptz;
  v_new_id   uuid;
  v_ws       uuid;
  v_token    text;
  v_limit    int;
  v_cur      text;
  v_cur_key  text;
  v_cur_id   uuid;
  v_prev     uuid[];
  v_count    int;
  v_title    text;
  v_prio     text;
  v_desc     text;
  -- search
  v_query    text;
  v_type     text;
  v_author   uuid;
  v_team     uuid;
  v_tag      uuid;
  v_from     timestamptz;
  v_to       timestamptz;
  v_page     jsonb;
  v_askers   uuid[];
  v_cards    uuid[];
  v_dismissed jsonb;
  v_scope    uuid[];
begin
  -- Agent provenance: every insert this function makes is agent-made.
  -- The BEFORE INSERT triggers on events / board_messages /
  -- card_comments / notifications read this transaction-local flag and
  -- stamp NEW.agent — future insert sites are marked automatically.
  perform set_config('flowdeck.agent', 'true', true);
  if p_user_id is null or not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'unknown user';
  end if;

  -- Become the PAT's user: everything below obeys RLS as the web UI does.
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', 'authenticated')::text,
    true
  );

  -- Page size clamp shared by every paginated op: default 50, 1..200.
  v_limit := least(greatest(coalesce((p_arg->>'limit')::int, 50), 1), 200);

  -- The connection's workspace boundary: empty array = unrestricted.
  v_scope := coalesce(p_workspace_ids, '{}'::uuid[]);

  case p_op
    -- ── reads ────────────────────────────────────────────────────────────
    when 'list_boards' then
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
      if v_cur is not null and public.mcp_cursor_tstz(v_cur) is null then
        raise exception 'malformed cursor';
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(
            jsonb_build_object('id', p.id, 'name', p.name, 'workspace_id', p.workspace_id, 'updated_at', p.updated_at, 'your_access', public.user_board_access(p.id))
            order by p.updated_at desc, p.id desc
          )
          from (
            select b.id, b.name, b.workspace_id, b.updated_at
            from public.boards b
            where public.mcp_scope_ok(v_scope, b.workspace_id) and public.mcp_op_ok(p_ws_ops, p_op, b.workspace_id)
              and (v_cur_key is null
                   or (b.updated_at, b.id) <= (v_cur_key::timestamptz, v_cur_id))
            order by b.updated_at desc, b.id desc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          select b.updated_at::text || '|' || b.id::text
          from public.boards b
          where public.mcp_scope_ok(v_scope, b.workspace_id) and public.mcp_op_ok(p_ws_ops, p_op, b.workspace_id)
            and (v_cur_key is null
                 or (b.updated_at, b.id) <= (v_cur_key::timestamptz, v_cur_id))
          order by b.updated_at desc, b.id desc
          offset v_limit limit 1
        )
      ));

    when 'get_board' then
      v_board_id := (p_arg->>'board_id')::uuid;
      if not exists (select 1 from public.boards b where b.id = v_board_id) then
        raise exception 'board not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      return jsonb_build_object(
        'ok', true,
        'data', jsonb_build_object(
          'board', (select to_jsonb(b) || jsonb_build_object('your_access', public.user_board_access(v_board_id)) from public.boards b where b.id = v_board_id),
          'lists', coalesce((
            select jsonb_agg(to_jsonb(l) order by l.position)
            from public.lists l where l.board_id = v_board_id
          ), '[]'::jsonb)
        )
      );

    -- Legacy shape kept so existing agent flows don't break silently:
    -- board + lists + cards + ALL messages in one payload. Unbounded —
    -- prefer get_board + get_cards + list_board_messages.
    when 'get_board_full' then
      v_board_id := (p_arg->>'board_id')::uuid;
      if not exists (select 1 from public.boards b where b.id = v_board_id) then
        raise exception 'board not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      return jsonb_build_object(
        'ok', true,
        'data', jsonb_build_object(
          'board', (select to_jsonb(b) || jsonb_build_object('your_access', public.user_board_access(v_board_id)) from public.boards b where b.id = v_board_id),
          'lists', coalesce((
            select jsonb_agg(to_jsonb(l) order by l.position)
            from public.lists l where l.board_id = v_board_id
          ), '[]'::jsonb),
          'cards', coalesce((
            select jsonb_agg(to_jsonb(c) || jsonb_build_object(
              'tags', coalesce((
                select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name)
                from public.card_tags ct
                join public.tags t on t.id = ct.tag_id
                where ct.card_id = c.id
              ), '[]'::jsonb)
            ) order by c.position)
            from public.cards c where c.board_id = v_board_id
          ), '[]'::jsonb),
          'messages', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', m.id, 'user_id', m.user_id, 'body', m.body, 'seq', m.seq,
              'edited', m.edited_at is not null, 'created_at', m.created_at
            ) order by m.seq)
            from public.board_messages m
            where m.board_id = v_board_id and m.deleted_at is null
          ), '[]'::jsonb)
        )
      );

    when 'get_cards' then
      v_list_id := (p_arg->>'list_id')::uuid;
      -- A missing/deleted row must say so, not read as a permission
      -- problem: a workspace-scoped token hit the scope gate with a
      -- NULL workspace and saw the permission error instead.
      if not exists (select 1 from public.lists l where l.id = v_list_id) then
        raise exception 'list not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.lists l join public.boards b on b.id = l.board_id where l.id = v_list_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.lists l join public.boards b on b.id = l.board_id where l.id = v_list_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
      if v_cur is not null and public.mcp_cursor_num(v_cur) is null then
        raise exception 'malformed cursor';
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(to_jsonb(p) || jsonb_build_object(
            'tags', coalesce((
              select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name)
              from public.card_tags ct
              join public.tags t on t.id = ct.tag_id
              where ct.card_id = p.id
            ), '[]'::jsonb)
          ) order by p.position, p.id)
          from (
            select c.*
            from public.cards c
            where c.list_id = v_list_id
              and (v_cur_key is null or (c.position, c.id) >= (v_cur_key::double precision, v_cur_id))
            order by c.position asc, c.id asc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          select c.position::text || '|' || c.id::text
          from public.cards c
          where c.list_id = v_list_id
            and (v_cur_key is null or (c.position, c.id) >= (v_cur_key::double precision, v_cur_id))
          order by c.position asc, c.id asc
          offset v_limit limit 1
        )
      ));

    when 'list_board_messages' then
      v_board_id := (p_arg->>'board_id')::uuid;
      -- A missing/deleted row must say so, not read as a permission
      -- problem: a workspace-scoped token hit the scope gate with a
      -- NULL workspace and saw the permission error instead.
      if not exists (select 1 from public.boards b where b.id = v_board_id) then
        raise exception 'board not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
      if v_cur is not null and public.mcp_cursor_int(v_cur) is null then
        raise exception 'malformed cursor';
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', p.id, 'user_id', p.user_id, 'body', p.body, 'seq', p.seq,
            'edited', p.edited_at is not null, 'edited_at', p.edited_at, 'created_at', p.created_at,
            'agent', p.agent
          ) order by p.seq, p.id)
          from (
            select m.id, m.user_id, m.body, m.seq, m.edited_at, m.created_at, m.agent
            from public.board_messages m
            where m.board_id = v_board_id
              and m.deleted_at is null
              and (v_cur_key is null or (m.seq, m.id) >= (v_cur_key::bigint, v_cur_id))
            order by m.seq asc, m.id asc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          select m.seq::text || '|' || m.id::text
          from public.board_messages m
          where m.board_id = v_board_id
            and m.deleted_at is null
            and (v_cur_key is null or (m.seq, m.id) >= (v_cur_key::bigint, v_cur_id))
          order by m.seq asc, m.id asc
          offset v_limit limit 1
        )
      ));

    when 'get_card_events' then
      -- The card's activity timeline: created, renamed, priority changes,
      -- description edits, list moves, assignee changes. Oldest first.
      -- ADR-4: reads the events log; the id cursor is the bigint identity
      -- (monotonic — created_at alone cannot order a same-second burst).
      v_card_id := (p_arg->>'card_id')::uuid;
      -- A missing/deleted row must say so, not read as a permission
      -- problem: a workspace-scoped token hit the scope gate with a
      -- NULL workspace and saw the permission error instead.
      if not exists (select 1 from public.cards c where c.id = v_card_id) then
        raise exception 'card not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.cards c join public.boards b on b.id = c.board_id where c.id = v_card_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.cards c join public.boards b on b.id = c.board_id where c.id = v_card_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      v_cur := nullif(p_arg->>'cursor', '');
      if v_cur is not null and public.mcp_cursor_int(v_cur) is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_int(v_cur);
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', p.id, 'kind', p.kind, 'detail', p.detail,
            'actor_id', p.actor_id,
            'actor_name', (select pr.display_name from public.profiles pr where pr.id = p.actor_id),
            'created_at', p.created_at, 'agent', p.agent
          ) order by p.id)
          from (
            select e.id, e.kind, e.detail, e.actor_id, e.created_at, e.agent
            from public.events e
            where e.card_id = v_card_id
              and (v_cur_key is null or e.id > v_cur_key::bigint)
            order by e.id asc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          -- id leads: mcp_cursor_int parses the FIRST pipe part, and the
          -- id alone is the cursor (monotonic identity).
          select e.id::text || '|' || e.created_at::text
          from public.events e
          where e.card_id = v_card_id
            and (v_cur_key is null or e.id > v_cur_key::bigint)
          order by e.id asc
          offset v_limit limit 1
        )
      ));

    when 'list_comments' then
      v_card_id := (p_arg->>'card_id')::uuid;
      -- A missing/deleted row must say so, not read as a permission
      -- problem: a workspace-scoped token hit the scope gate with a
      -- NULL workspace and saw the permission error instead.
      if not exists (select 1 from public.cards c where c.id = v_card_id) then
        raise exception 'card not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.cards c join public.boards b on b.id = c.board_id where c.id = v_card_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.cards c join public.boards b on b.id = c.board_id where c.id = v_card_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      v_cur := nullif(p_arg->>'cursor', '');      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
      if v_cur is not null and public.mcp_cursor_int(v_cur) is null then
        raise exception 'malformed cursor';
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', p.id, 'body', p.body, 'user_id', p.user_id, 'seq', p.seq,
            'edited', p.edited_at is not null, 'edited_at', p.edited_at, 'created_at', p.created_at,
            'agent', p.agent
          ) order by p.seq, p.id)
          from (
            select cm.id, cm.body, cm.user_id, cm.seq, cm.edited_at, cm.created_at, cm.agent
            from public.card_comments cm
            where cm.card_id = v_card_id
              and cm.deleted_at is null
              and (v_cur_key is null or (cm.seq, cm.id) >= (v_cur_key::bigint, v_cur_id))
            order by cm.seq asc, cm.id asc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          select cm.seq::text || '|' || cm.id::text
          from public.card_comments cm
          where cm.card_id = v_card_id
            and cm.deleted_at is null
            and (v_cur_key is null or (cm.seq, cm.id) >= (v_cur_key::bigint, v_cur_id))
          order by cm.seq asc, cm.id asc
          offset v_limit limit 1
        )
      ));

    when 'get_me' then
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'profile', (select to_jsonb(p) from public.profiles p where p.id = p_user_id),
        'status', (select to_jsonb(s) from public.user_status s where s.user_id = p_user_id)
      ));

    when 'get_user' then
      -- Peers RLS: only users the caller may see resolve.
      if not exists (
        select 1 from public.profiles pr
        where pr.id = (p_arg->>'user_id')::uuid
      ) then
        raise exception 'user not found or not visible';
      end if;
      return jsonb_build_object('ok', true, 'data', (
        select jsonb_build_object(
          'id', pr.id, 'display_name', pr.display_name, 'username', pr.username,
          'email', pr.email, 'avatar_url', pr.avatar_url, 'created_at', pr.created_at
        )
        from public.profiles pr where pr.id = (p_arg->>'user_id')::uuid
      ));

    when 'list_workspace_members' then
      v_ws := (p_arg->>'workspace_id')::uuid;
      if not public.mcp_scope_ok(v_scope, v_ws)
           or not public.mcp_op_ok(p_ws_ops, p_op, v_ws) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
      if v_cur is not null and public.mcp_cursor_tstz(v_cur) is null then
        raise exception 'malformed cursor';
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', p.id, 'display_name', p.display_name, 'username', p.username,
              'email', p.email, 'avatar_url', p.avatar_url,
              'workspace_role', p.role, 'member_since', p.created_at
            )
            order by p.created_at, p.id
          )
          from (
            select pr.id, pr.display_name, pr.username, pr.email, pr.avatar_url,
                   wm.role, wm.created_at
            from public.workspace_members wm
            join public.profiles pr on pr.id = wm.user_id
            where wm.workspace_id = v_ws
              and (v_cur_key is null or (wm.created_at, wm.user_id) >= (v_cur_key::timestamptz, v_cur_id))
            order by wm.created_at asc, wm.user_id asc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          select wm.created_at::text || '|' || wm.user_id::text
          from public.workspace_members wm
          where wm.workspace_id = v_ws
            and (v_cur_key is null or (wm.created_at, wm.user_id) >= (v_cur_key::timestamptz, v_cur_id))
          order by wm.created_at asc, wm.user_id asc
          offset v_limit limit 1
        )
      ));

    when 'list_pending_invites' then
      v_ws := (p_arg->>'workspace_id')::uuid;
      if not public.mcp_scope_ok(v_scope, v_ws)
           or not public.mcp_op_ok(p_ws_ops, p_op, v_ws) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      -- Clear feedback beats a silently empty list: this is an
      -- owners/admins view.
      if public.user_workspace_role(v_ws) not in ('owner', 'admin') then
        raise exception 'workspace owners/admins only';
      end if;
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
      if v_cur is not null and public.mcp_cursor_tstz(v_cur) is null then
        raise exception 'malformed cursor';
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', p.id, 'email', p.email, 'role', p.role, 'status', p.status,
              'invited_by', p.invited_by,
              'invited_by_name', (select pr.display_name from public.profiles pr where pr.id = p.invited_by),
              'created_at', p.created_at
            )
            order by p.created_at desc, p.id desc
          )
          from (
            select i.id, i.email, i.role, i.status, i.invited_by, i.created_at
            from public.workspace_invites i
            where i.workspace_id = v_ws
              and (v_cur_key is null or (i.created_at, i.id) <= (v_cur_key::timestamptz, v_cur_id))
            order by i.created_at desc, i.id desc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          select i.created_at::text || '|' || i.id::text
          from public.workspace_invites i
          where i.workspace_id = v_ws
            and (v_cur_key is null or (i.created_at, i.id) <= (v_cur_key::timestamptz, v_cur_id))
          order by i.created_at desc, i.id desc
          offset v_limit limit 1
        )
      ));

    when 'update_me' then
      return public.mcp_update_me(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'list_workspaces' then
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
      if v_cur is not null and public.mcp_cursor_tstz(v_cur) is null then
        raise exception 'malformed cursor';
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(
            jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role, 'board_creation', p.board_creation)
            order by p.created_at, p.id
          )
          from (
            select w.id, w.name, wm.role, w.board_creation, wm.created_at
            from public.workspace_members wm
            join public.workspaces w on w.id = wm.workspace_id
            where wm.user_id = p_user_id
              and public.mcp_scope_ok(v_scope, w.id)
              and (v_cur_key is null or (wm.created_at, w.id) >= (v_cur_key::timestamptz, v_cur_id))
            order by wm.created_at asc, w.id asc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          select wm.created_at::text || '|' || w.id::text
          from public.workspace_members wm
          join public.workspaces w on w.id = wm.workspace_id
          where wm.user_id = p_user_id
            and public.mcp_scope_ok(v_scope, w.id)
            and (v_cur_key is null or (wm.created_at, w.id) >= (v_cur_key::timestamptz, v_cur_id))
          order by wm.created_at asc, w.id asc
          offset v_limit limit 1
        )
      ));

    when 'list_teams' then
      v_ws := (p_arg->>'workspace_id')::uuid;
      if not public.mcp_scope_ok(v_scope, v_ws)
           or not public.mcp_op_ok(p_ws_ops, p_op, v_ws) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
      if v_cur is not null and public.mcp_cursor_tstz(v_cur) is null then
        raise exception 'malformed cursor';
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', p.id, 'name', p.name, 'description', p.description,
            'members', coalesce((
              select jsonb_agg(jsonb_build_object(
                'user_id', tm.user_id,
                'display_name', (select pr.display_name from public.profiles pr where pr.id = tm.user_id),
                'role', tm.role
              ) order by tm.user_id)
              from public.team_members tm where tm.team_id = p.id
            ), '[]'::jsonb)
          ) order by p.created_at, p.id)
          from (
            select t.id, t.name, t.description, t.created_at
            from public.teams t
            where t.workspace_id = v_ws and t.deactivated_at is null
              and (v_cur_key is null or (t.created_at, t.id) >= (v_cur_key::timestamptz, v_cur_id))
            order by t.created_at asc, t.id asc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          select t.created_at::text || '|' || t.id::text
          from public.teams t
          where t.workspace_id = v_ws and t.deactivated_at is null
            and (v_cur_key is null or (t.created_at, t.id) >= (v_cur_key::timestamptz, v_cur_id))
          order by t.created_at asc, t.id asc
          offset v_limit limit 1
        )
      ));

    when 'list_notifications' then
      -- Account-level op: granted via the '*' bucket when the
      -- connection uses per-workspace permissions.
      if not public.mcp_op_ok(p_ws_ops, p_op, null) then
        raise exception 'this connection does not have that permission';
      end if;

      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
      if v_cur is not null and public.mcp_cursor_tstz(v_cur) is null then
        raise exception 'malformed cursor';
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', p.id, 'kind', p.kind, 'body', p.body, 'board_id', p.board_id,
            'card_id', p.card_id, 'actor_id', p.actor_id, 'subject_id', p.subject_id,
            'actor_name', p.actor_name, 'subject_name', p.subject_name,
            'subject_team_id', p.subject_team_id, 'subject_team_name', p.subject_team_name,
            'card_number', p.card_number, 'card_title', p.card_title, 'board_name', p.board_name,
            'href', p.href,
            'seen', p.seen_at is not null, 'created_at', p.created_at
          ) order by p.created_at desc, p.id desc)
          from (
            select n.id, n.kind, n.body, n.board_id, n.card_id, n.actor_id, n.subject_id,
                   n.subject_team_id, n.href, n.seen_at, n.created_at,
                   (select pr.display_name from public.profiles pr where pr.id = n.actor_id) as actor_name,
                   (select pr.display_name from public.profiles pr where pr.id = n.subject_id) as subject_name,
                   (select t.name from public.teams t where t.id = n.subject_team_id) as subject_team_name,
                   (select c.number from public.cards c where c.id = n.card_id) as card_number,
                   (select c.title from public.cards c where c.id = n.card_id) as card_title,
                   (select b.name from public.boards b where b.id = n.board_id) as board_name
            from public.notifications n
            where n.user_id = p_user_id
              and (cardinality(v_scope) = 0 or exists (
                select 1 from public.boards b
                where b.id = n.board_id and public.mcp_scope_ok(v_scope, b.workspace_id) and public.mcp_op_ok(p_ws_ops, p_op, b.workspace_id)))
              and (coalesce(p_arg->>'filter', 'all') <> 'unread' or n.seen_at is null)
              and (coalesce(p_arg->>'filter', 'all') <> 'read' or n.seen_at is not null)
              and (v_cur_key is null or (n.created_at, n.id) <= (v_cur_key::timestamptz, v_cur_id))
            order by n.created_at desc, n.id desc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          select n.created_at::text || '|' || n.id::text
          from public.notifications n
          where n.user_id = p_user_id
            and (cardinality(v_scope) = 0 or exists (
              select 1 from public.boards b
              where b.id = n.board_id and public.mcp_scope_ok(v_scope, b.workspace_id) and public.mcp_op_ok(p_ws_ops, p_op, b.workspace_id)))
            and (coalesce(p_arg->>'filter', 'all') <> 'unread' or n.seen_at is null)
            and (coalesce(p_arg->>'filter', 'all') <> 'read' or n.seen_at is not null)
            and (v_cur_key is null or (n.created_at, n.id) <= (v_cur_key::timestamptz, v_cur_id))
          order by n.created_at desc, n.id desc
          offset v_limit limit 1
        )
      ));

    when 'mark_notification_read' then
      return public.mcp_mark_notification_read(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'mark_notification_unread' then
      return public.mcp_mark_notification_unread(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'mark_all_notifications_read' then
      return public.mcp_mark_all_notifications_read(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'search' then
      -- Parse and normalize the filters.
      v_query := nullif(btrim(coalesce(p_arg->>'query', '')), '');
      v_query := case when v_query is null then null
                      else replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') end;
      v_type   := nullif(p_arg->>'type', '');
      if v_type is not null and v_type not in ('card', 'comment', 'message', 'board', 'all') then
        raise exception 'type must be one of card, comment, message, board, all';
      end if;
      v_author := nullif(p_arg->>'author_id', '')::uuid;
      v_team   := nullif(p_arg->>'team_id', '')::uuid;
      v_tag    := nullif(p_arg->>'tag_id', '')::uuid;
      v_board_id := nullif(p_arg->>'board_id', '')::uuid;
      begin
        v_from := nullif(p_arg->>'from', '')::timestamptz;
        v_to   := nullif(p_arg->>'to', '')::timestamptz;
      exception when others then
        raise exception 'invalid from/to — use ISO 8601 dates';
      end;
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
      if v_cur is not null and public.mcp_cursor_tstz(v_cur) is null then
        raise exception 'malformed cursor';
      end if;
      select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc, p.id desc), '[]'::jsonb) into v_page
      from (
        select * from (
          -- cards
          select 'card' as type, c.id, c.board_id, c.number,
                 (select b.name from public.boards b where b.id = c.board_id) as board_name,
                 c.title as title, null::text as body,
                 c.created_by as author_id, c.priority, c.created_at
          from public.cards c
          where (v_type is null or v_type = 'all' or v_type = 'card')
            and exists (select 1 from public.boards sb where sb.id = c.board_id and public.mcp_scope_ok(v_scope, sb.workspace_id) and public.mcp_op_ok(p_ws_ops, p_op, sb.workspace_id))
            and (v_board_id is null or c.board_id = v_board_id)
            and (v_query is null or c.title ilike '%' || v_query || '%' or c.description ilike '%' || v_query || '%')
            and (v_author is null or c.created_by = v_author)
            and (v_team is null or exists (
                   select 1 from public.team_members tm
                   where tm.team_id = v_team and tm.user_id = c.created_by))
            and (v_tag is null or exists (
                   select 1 from public.card_tags ct where ct.card_id = c.id and ct.tag_id = v_tag))
            and (nullif(p_arg->>'priority', '') is null or c.priority = p_arg->>'priority')
            and (v_from is null or c.created_at >= v_from)
            and (v_to is null or c.created_at <= v_to)
          union all
          -- card comments
          select 'comment' as type, cm.id, c.board_id, c.number,
                 (select b.name from public.boards b where b.id = c.board_id) as board_name,
                 c.title as title, cm.body as body,
                 cm.user_id as author_id, null::text as priority, cm.created_at
          from public.card_comments cm
          join public.cards c on c.id = cm.card_id
          where cm.deleted_at is null
            and exists (select 1 from public.boards sb where sb.id = c.board_id and public.mcp_scope_ok(v_scope, sb.workspace_id) and public.mcp_op_ok(p_ws_ops, p_op, sb.workspace_id))
            and (v_type is null or v_type = 'all' or v_type = 'comment')
            and (v_board_id is null or c.board_id = v_board_id)
            and (v_query is null or cm.body ilike '%' || v_query || '%')
            and (v_author is null or cm.user_id = v_author)
            and (v_team is null or exists (
                   select 1 from public.team_members tm
                   where tm.team_id = v_team and tm.user_id = cm.user_id))
            and (v_from is null or cm.created_at >= v_from)
            and (v_to is null or cm.created_at <= v_to)
          union all
          -- board messages
          select 'message' as type, m.id, m.board_id, null::int as number,
                 (select b.name from public.boards b where b.id = m.board_id) as board_name,
                 null::text as title, m.body as body,
                 m.user_id as author_id, null::text as priority, m.created_at
          from public.board_messages m
          where m.deleted_at is null
            and exists (select 1 from public.boards sb where sb.id = m.board_id and public.mcp_scope_ok(v_scope, sb.workspace_id) and public.mcp_op_ok(p_ws_ops, p_op, sb.workspace_id))
            and (v_type is null or v_type = 'all' or v_type = 'message')
            and (v_board_id is null or m.board_id = v_board_id)
            and (v_query is null or m.body ilike '%' || v_query || '%')
            and (v_author is null or m.user_id = v_author)
            and (v_team is null or exists (
                   select 1 from public.team_members tm
                   where tm.team_id = v_team and tm.user_id = m.user_id))
            and (v_from is null or m.created_at >= v_from)
            and (v_to is null or m.created_at <= v_to)
          union all
          -- boards by name
          select 'board' as type, b.id, b.id as board_id, null::int as number,
                 b.name as board_name,
                 null::text as title, null::text as body,
                 b.owner_id as author_id, null::text as priority, b.updated_at as created_at
          from public.boards b
          where (v_type is null or v_type = 'all' or v_type = 'board')
            and public.mcp_scope_ok(v_scope, b.workspace_id) and public.mcp_op_ok(p_ws_ops, p_op, b.workspace_id)
            and (v_board_id is null or b.id = v_board_id)
            and (v_query is null or b.name ilike '%' || v_query || '%')
            and (v_author is null or b.owner_id = v_author)
            and (v_from is null or b.updated_at >= v_from)
            and (v_to is null or b.updated_at <= v_to)
        ) u
        where (v_cur_key is null or (u.created_at, u.id) <= (v_cur_key::timestamptz, v_cur_id))
        order by u.created_at desc, u.id desc
        limit v_limit + 1
      ) p;
      -- One extra row was fetched: it only decides whether there is a
      -- next page (and seeds the cursor); it is not returned.
      if jsonb_array_length(v_page) > v_limit then
        return jsonb_build_object('ok', true, 'data', jsonb_build_object(
          'items', (select jsonb_agg(t.x order by t.i)
                    from jsonb_array_elements(v_page) with ordinality as t(x, i)
                    where t.i <= v_limit),
          'next_cursor', (v_page -> v_limit ->> 'created_at') || '|' || (v_page -> v_limit ->> 'id')
        ));
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('items', v_page, 'next_cursor', null));

    -- ── boards ──────────────────────────────────────────────────────────
    when 'create_board' then
      return public.mcp_create_board(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'rename_board' then
      return public.mcp_rename_board(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'delete_board' then
      return public.mcp_delete_board(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'update_board' then
      return public.mcp_update_board(p_user_id, p_arg, v_scope, p_ws_ops);

    -- ── lists ───────────────────────────────────────────────────────────
    when 'create_list' then
      return public.mcp_create_list(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'rename_list' then
      return public.mcp_rename_list(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'delete_list' then
      return public.mcp_delete_list(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'update_list' then
      return public.mcp_update_list(p_user_id, p_arg, v_scope, p_ws_ops);

    -- ── cards ───────────────────────────────────────────────────────────
    when 'create_card' then
      return public.mcp_create_card(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'update_card' then
      return public.mcp_update_card(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'move_card' then
      return public.mcp_move_card(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'delete_card' then
      return public.mcp_delete_card(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'resolve_card' then
      return public.mcp_resolve_card(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'unresolve_card' then
      return public.mcp_unresolve_card(p_user_id, p_arg, v_scope, p_ws_ops);

    -- ── comments + board chat ────────────────────────────────────────────
    when 'add_comment' then
      return public.mcp_add_comment(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'edit_comment' then
      return public.mcp_edit_comment(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'delete_comment' then
      return public.mcp_delete_comment(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'post_board_message' then
      return public.mcp_post_board_message(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'edit_board_message' then
      return public.mcp_edit_board_message(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'delete_board_message' then
      return public.mcp_delete_board_message(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'create_workspace' then
      return public.mcp_create_workspace(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'invite_member' then
      return public.mcp_invite_member(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'create_team' then
      return public.mcp_create_team(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'update_team' then
      return public.mcp_update_team(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'add_team_member' then
      return public.mcp_add_team_member(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'remove_team_member' then
      return public.mcp_remove_team_member(p_user_id, p_arg, v_scope, p_ws_ops);

    -- ── tags ─────────────────────────────────────────────────────────────
    when 'list_tags' then
      return public.mcp_list_tags(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'create_tag' then
      return public.mcp_create_tag(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'rename_tag' then
      return public.mcp_rename_tag(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'merge_tags' then
      return public.mcp_merge_tags(p_user_id, p_arg, v_scope, p_ws_ops);

    -- ── mention access flow ─────────────────────────────────────────────
    when 'check_mention_access' then
      return public.mcp_check_mention_access(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'grant_board_access' then
      return public.mcp_grant_board_access(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'request_board_access' then
      return public.mcp_request_board_access(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'resolve_access_request' then
      return public.mcp_resolve_access_request(p_user_id, p_arg, v_scope, p_ws_ops);

    -- ── status ───────────────────────────────────────────────────────────
    when 'set_status' then
      return public.mcp_set_status(p_user_id, p_arg, v_scope, p_ws_ops);

    else
      raise exception 'unknown op: %', p_op;
  end case;
end;
$function$


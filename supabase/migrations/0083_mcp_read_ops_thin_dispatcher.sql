-- Phase 5 (ADR-5), the final extraction: every remaining READ branch
-- moves into its own per-op function, and mcp_exec becomes the thin
-- dispatcher ADR-5 calls for — session preparation (agent provenance,
-- user check, PAT impersonation, workspace scope) plus one dispatch line
-- per op. Each paginated read carries its own page-size clamp now; the
-- head's shared clamp retires with the last inline branch.
--
-- A new op is now exactly what the phase promised: one small migration
-- creating mcp_<op>() plus one dispatch line here. The MCP edge
-- function's tool list maps 1:1 onto these functions.


create or replace function public.mcp_list_boards(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_cur text;
  v_cur_id uuid;
  v_cur_key text;
  v_limit int;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Page size clamp shared by every paginated op: default 50, 1..200.
  v_limit := least(greatest(coalesce((p_arg->>'limit')::int, 50), 1), 200);
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
        where public.mcp_scope_ok(p_scope, b.workspace_id) and public.mcp_op_ok(p_ws_ops, 'list_boards', b.workspace_id)
          and (v_cur_key is null
               or (b.updated_at, b.id) <= (v_cur_key::timestamptz, v_cur_id))
        order by b.updated_at desc, b.id desc
        limit v_limit
      ) p
    ), '[]'::jsonb),
    'next_cursor', (
      select b.updated_at::text || '|' || b.id::text
      from public.boards b
      where public.mcp_scope_ok(p_scope, b.workspace_id) and public.mcp_op_ok(p_ws_ops, 'list_boards', b.workspace_id)
        and (v_cur_key is null
             or (b.updated_at, b.id) <= (v_cur_key::timestamptz, v_cur_id))
      order by b.updated_at desc, b.id desc
      offset v_limit limit 1
    )
  ));

end;
$$;


create or replace function public.mcp_get_board(
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
       or not public.mcp_op_ok(p_ws_ops, 'get_board', (select b.workspace_id from public.boards b where b.id = v_board_id)) then
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
end;
$$;


create or replace function public.mcp_get_board_full(
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
       or not public.mcp_op_ok(p_ws_ops, 'get_board_full', (select b.workspace_id from public.boards b where b.id = v_board_id)) then
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

end;
$$;


create or replace function public.mcp_get_cards(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_list_id uuid;
  v_cur text;
  v_cur_id uuid;
  v_cur_key text;
  v_limit int;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Page size clamp shared by every paginated op: default 50, 1..200.
  v_limit := least(greatest(coalesce((p_arg->>'limit')::int, 50), 1), 200);
  v_list_id := (p_arg->>'list_id')::uuid;
  -- A missing/deleted row must say so, not read as a permission
  -- problem: a workspace-scoped token hit the scope gate with a
  -- NULL workspace and saw the permission error instead.
  if not exists (select 1 from public.lists l where l.id = v_list_id) then
    raise exception 'list not found or no access';
  end if;
  if not public.mcp_scope_ok(p_scope, (select b.workspace_id from public.lists l join public.boards b on b.id = l.board_id where l.id = v_list_id))
       or not public.mcp_op_ok(p_ws_ops, 'get_cards', (select b.workspace_id from public.lists l join public.boards b on b.id = l.board_id where l.id = v_list_id)) then
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

end;
$$;


create or replace function public.mcp_list_board_messages(
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
  v_cur text;
  v_cur_id uuid;
  v_cur_key text;
  v_limit int;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Page size clamp shared by every paginated op: default 50, 1..200.
  v_limit := least(greatest(coalesce((p_arg->>'limit')::int, 50), 1), 200);
  v_board_id := (p_arg->>'board_id')::uuid;
  -- A missing/deleted row must say so, not read as a permission
  -- problem: a workspace-scoped token hit the scope gate with a
  -- NULL workspace and saw the permission error instead.
  if not exists (select 1 from public.boards b where b.id = v_board_id) then
    raise exception 'board not found or no access';
  end if;
  if not public.mcp_scope_ok(p_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
       or not public.mcp_op_ok(p_ws_ops, 'list_board_messages', (select b.workspace_id from public.boards b where b.id = v_board_id)) then
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

end;
$$;


create or replace function public.mcp_get_card_events(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_card_id uuid;
  v_cur text;
  v_cur_key text;
  v_limit int;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Page size clamp shared by every paginated op: default 50, 1..200.
  v_limit := least(greatest(coalesce((p_arg->>'limit')::int, 50), 1), 200);
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
  if not public.mcp_scope_ok(p_scope, (select b.workspace_id from public.cards c join public.boards b on b.id = c.board_id where c.id = v_card_id))
       or not public.mcp_op_ok(p_ws_ops, 'get_card_events', (select b.workspace_id from public.cards c join public.boards b on b.id = c.board_id where c.id = v_card_id)) then
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

end;
$$;


create or replace function public.mcp_list_comments(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_card_id uuid;
  v_cur text;
  v_cur_id uuid;
  v_cur_key text;
  v_limit int;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Page size clamp shared by every paginated op: default 50, 1..200.
  v_limit := least(greatest(coalesce((p_arg->>'limit')::int, 50), 1), 200);
  v_card_id := (p_arg->>'card_id')::uuid;
  -- A missing/deleted row must say so, not read as a permission
  -- problem: a workspace-scoped token hit the scope gate with a
  -- NULL workspace and saw the permission error instead.
  if not exists (select 1 from public.cards c where c.id = v_card_id) then
    raise exception 'card not found or no access';
  end if;
  if not public.mcp_scope_ok(p_scope, (select b.workspace_id from public.cards c join public.boards b on b.id = c.board_id where c.id = v_card_id))
       or not public.mcp_op_ok(p_ws_ops, 'list_comments', (select b.workspace_id from public.cards c join public.boards b on b.id = c.board_id where c.id = v_card_id)) then
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

end;
$$;


create or replace function public.mcp_get_me(
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
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'profile', (select to_jsonb(p) from public.profiles p where p.id = p_user_id),
    'status', (select to_jsonb(s) from public.user_status s where s.user_id = p_user_id)
  ));

end;
$$;


create or replace function public.mcp_get_user(
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

end;
$$;


create or replace function public.mcp_list_workspace_members(
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
  v_cur text;
  v_cur_id uuid;
  v_cur_key text;
  v_limit int;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Page size clamp shared by every paginated op: default 50, 1..200.
  v_limit := least(greatest(coalesce((p_arg->>'limit')::int, 50), 1), 200);
  v_ws := (p_arg->>'workspace_id')::uuid;
  if not public.mcp_scope_ok(p_scope, v_ws)
       or not public.mcp_op_ok(p_ws_ops, 'list_workspace_members', v_ws) then
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

end;
$$;


create or replace function public.mcp_list_pending_invites(
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
  v_cur text;
  v_cur_id uuid;
  v_cur_key text;
  v_limit int;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Page size clamp shared by every paginated op: default 50, 1..200.
  v_limit := least(greatest(coalesce((p_arg->>'limit')::int, 50), 1), 200);
  v_ws := (p_arg->>'workspace_id')::uuid;
  if not public.mcp_scope_ok(p_scope, v_ws)
       or not public.mcp_op_ok(p_ws_ops, 'list_pending_invites', v_ws) then
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

end;
$$;


create or replace function public.mcp_list_workspaces(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_cur text;
  v_cur_id uuid;
  v_cur_key text;
  v_limit int;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Page size clamp shared by every paginated op: default 50, 1..200.
  v_limit := least(greatest(coalesce((p_arg->>'limit')::int, 50), 1), 200);
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
          and public.mcp_scope_ok(p_scope, w.id)
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
        and public.mcp_scope_ok(p_scope, w.id)
        and (v_cur_key is null or (wm.created_at, w.id) >= (v_cur_key::timestamptz, v_cur_id))
      order by wm.created_at asc, w.id asc
      offset v_limit limit 1
    )
  ));

end;
$$;


create or replace function public.mcp_list_teams(
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
  v_cur text;
  v_cur_id uuid;
  v_cur_key text;
  v_limit int;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Page size clamp shared by every paginated op: default 50, 1..200.
  v_limit := least(greatest(coalesce((p_arg->>'limit')::int, 50), 1), 200);
  v_ws := (p_arg->>'workspace_id')::uuid;
  if not public.mcp_scope_ok(p_scope, v_ws)
       or not public.mcp_op_ok(p_ws_ops, 'list_teams', v_ws) then
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

end;
$$;


create or replace function public.mcp_list_notifications(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_cur text;
  v_cur_id uuid;
  v_cur_key text;
  v_limit int;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Page size clamp shared by every paginated op: default 50, 1..200.
  v_limit := least(greatest(coalesce((p_arg->>'limit')::int, 50), 1), 200);
  -- Account-level op: granted via the '*' bucket when the
  -- connection uses per-workspace permissions.
  if not public.mcp_op_ok(p_ws_ops, 'list_notifications', null) then
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
          and (cardinality(p_scope) = 0 or exists (
            select 1 from public.boards b
            where b.id = n.board_id and public.mcp_scope_ok(p_scope, b.workspace_id) and public.mcp_op_ok(p_ws_ops, 'list_notifications', b.workspace_id)))
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
        and (cardinality(p_scope) = 0 or exists (
          select 1 from public.boards b
          where b.id = n.board_id and public.mcp_scope_ok(p_scope, b.workspace_id) and public.mcp_op_ok(p_ws_ops, 'list_notifications', b.workspace_id)))
        and (coalesce(p_arg->>'filter', 'all') <> 'unread' or n.seen_at is null)
        and (coalesce(p_arg->>'filter', 'all') <> 'read' or n.seen_at is not null)
        and (v_cur_key is null or (n.created_at, n.id) <= (v_cur_key::timestamptz, v_cur_id))
      order by n.created_at desc, n.id desc
      offset v_limit limit 1
    )
  ));

end;
$$;


create or replace function public.mcp_search(
  p_user_id uuid,
  p_arg jsonb default '{}'::jsonb,
  p_scope uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_query text;
  v_type text;
  v_author uuid;
  v_team uuid;
  v_tag uuid;
  v_board_id uuid;
  v_from timestamptz;
  v_to timestamptz;
  v_cur text;
  v_cur_id uuid;
  v_cur_key text;
  v_limit int;
  v_page jsonb;
begin
  -- The per-op contract (ADR-5): the function runs under the CALLER's
  -- RLS context — mcp_exec impersonates the PAT user before dispatch,
  -- PostgREST gives the web app its own JWT — and the acting user must
  -- be the JWT subject.
  if not public.mcp_caller_ok(p_user_id) then
    raise exception 'unknown user';
  end if;
  -- Page size clamp shared by every paginated op: default 50, 1..200.
  v_limit := least(greatest(coalesce((p_arg->>'limit')::int, 50), 1), 200);
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
        and exists (select 1 from public.boards sb where sb.id = c.board_id and public.mcp_scope_ok(p_scope, sb.workspace_id) and public.mcp_op_ok(p_ws_ops, 'search', sb.workspace_id))
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
        and exists (select 1 from public.boards sb where sb.id = c.board_id and public.mcp_scope_ok(p_scope, sb.workspace_id) and public.mcp_op_ok(p_ws_ops, 'search', sb.workspace_id))
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
        and exists (select 1 from public.boards sb where sb.id = m.board_id and public.mcp_scope_ok(p_scope, sb.workspace_id) and public.mcp_op_ok(p_ws_ops, 'search', sb.workspace_id))
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
        and public.mcp_scope_ok(p_scope, b.workspace_id) and public.mcp_op_ok(p_ws_ops, 'search', b.workspace_id)
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
end;
$$;

CREATE OR REPLACE FUNCTION public.mcp_exec(p_user_id uuid, p_op text, p_arg jsonb DEFAULT '{}'::jsonb, p_workspace_ids uuid[] DEFAULT '{}'::uuid[], p_ws_ops jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  -- The thin dispatcher (ADR-5): every op is a one-line dispatch to its
  -- per-op function — this head only prepares the shared session context.
  v_scope uuid[];
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

  -- The connection's workspace boundary: empty array = unrestricted.
  v_scope := coalesce(p_workspace_ids, '{}'::uuid[]);

  case p_op
    -- ── reads ────────────────────────────────────────────────────────────
    when 'list_boards' then
      return public.mcp_list_boards(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'get_board' then
      return public.mcp_get_board(p_user_id, p_arg, v_scope, p_ws_ops);

    -- Legacy shape kept so existing agent flows don't break silently:
    -- board + lists + cards + ALL messages in one payload. Unbounded —
    -- prefer get_board + get_cards + list_board_messages.
    when 'get_board_full' then
      return public.mcp_get_board_full(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'get_cards' then
      return public.mcp_get_cards(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'list_board_messages' then
      return public.mcp_list_board_messages(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'get_card_events' then
      return public.mcp_get_card_events(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'list_comments' then
      return public.mcp_list_comments(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'get_me' then
      return public.mcp_get_me(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'get_user' then
      return public.mcp_get_user(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'list_workspace_members' then
      return public.mcp_list_workspace_members(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'list_pending_invites' then
      return public.mcp_list_pending_invites(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'update_me' then
      return public.mcp_update_me(p_user_id, p_arg, v_scope, p_ws_ops);

    -- ── workspaces ──────────────────────────────────────────────────────
    when 'list_workspaces' then
      return public.mcp_list_workspaces(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'list_teams' then
      return public.mcp_list_teams(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'list_notifications' then
      return public.mcp_list_notifications(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'mark_notification_read' then
      return public.mcp_mark_notification_read(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'mark_notification_unread' then
      return public.mcp_mark_notification_unread(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'mark_all_notifications_read' then
      return public.mcp_mark_all_notifications_read(p_user_id, p_arg, v_scope, p_ws_ops);

    when 'search' then
      return public.mcp_search(p_user_id, p_arg, v_scope, p_ws_ops);

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


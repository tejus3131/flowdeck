-- ── MCP operations (the AI harness surface) ───────────────────────────────
--
-- One RPC executes every board operation ON BEHALF OF a user: it switches
-- to the authenticated role with request.jwt.claims set to the given user
-- id, so every statement inside runs under exactly the RLS the app's own
-- UI runs under — MCP callers can never exceed what the web client could
-- do. (Security INVOKER, because SET ROLE is forbidden inside
-- security-definer functions; the privilege wall is the execute grant:
-- service role only.)
--
-- Callers: the service role ONLY (the MCP edge function passes p_user_id
-- after verifying the PAT). Exec is revoked from anon/authenticated so the
-- id can never be spoofed by a public caller.

create or replace function public.mcp_exec(
  p_user_id uuid,
  p_op text,
  p_arg jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_board_id uuid;
  v_list_id  uuid;
  v_card_id  uuid;
  v_pos      numeric;
  v_new_id   uuid;
  v_ws       uuid;
begin
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

  case p_op
    -- ── reads ────────────────────────────────────────────────────────────
    when 'list_boards' then
      return jsonb_build_object('ok', true, 'data', coalesce((
        select jsonb_agg(
          jsonb_build_object('id', b.id, 'name', b.name, 'workspace_id', b.workspace_id)
          order by b.updated_at desc
        )
        from public.boards b
      ), '[]'::jsonb));

    when 'get_board' then
      v_board_id := (p_arg->>'board_id')::uuid;
      return jsonb_build_object(
        'ok', true,
        'data', jsonb_build_object(
          'board', (select to_jsonb(b) from public.boards b where b.id = v_board_id),
          'lists', coalesce((
            select jsonb_agg(to_jsonb(l) order by l.position)
            from public.lists l where l.board_id = v_board_id
          ), '[]'::jsonb),
          'cards', coalesce((
            select jsonb_agg(to_jsonb(c) order by c.position)
            from public.cards c where c.board_id = v_board_id
          ), '[]'::jsonb)
        )
      );

    when 'list_comments' then
      v_card_id := (p_arg->>'card_id')::uuid;
      return jsonb_build_object('ok', true, 'data', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', cm.id, 'body', cm.body, 'user_id', cm.user_id, 'created_at', cm.created_at
        ) order by cm.created_at)
        from public.card_comments cm
        where cm.card_id = v_card_id
      ), '[]'::jsonb));

    -- ── boards ──────────────────────────────────────────────────────────
    when 'create_board' then
      if coalesce(nullif(p_arg->>'workspace_id', ''), '') = '' then
        select wm.workspace_id into v_ws
        from public.workspace_members wm
        where wm.user_id = p_user_id
        order by wm.created_at
        limit 1;
      else
        v_ws := (p_arg->>'workspace_id')::uuid;
      end if;
      if v_ws is null then
        raise exception 'no workspace for this account';
      end if;
      insert into public.boards (name, workspace_id, owner_id)
      values (left(coalesce(p_arg->>'name', 'Untitled'), 80), v_ws, p_user_id)
      returning id into v_new_id;
      insert into public.lists (board_id, name, position)
      values (v_new_id, 'To do', 1), (v_new_id, 'In progress', 2), (v_new_id, 'Done', 3);
      insert into public.activity (board_id, user_id, type, payload)
      values (v_new_id, p_user_id, 'board.created', jsonb_build_object('name', p_arg->>'name'));
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('board_id', v_new_id));

    when 'rename_board' then
      v_board_id := (p_arg->>'board_id')::uuid;
      update public.boards set name = left(p_arg->>'name', 80) where id = v_board_id;
      if not found then raise exception 'board not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'delete_board' then
      v_board_id := (p_arg->>'board_id')::uuid;
      delete from public.boards where id = v_board_id;
      if not found then raise exception 'board not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    -- ── lists ───────────────────────────────────────────────────────────
    when 'create_list' then
      v_board_id := (p_arg->>'board_id')::uuid;
      select coalesce(max(l.position), 0) + 1 into v_pos
      from public.lists l where l.board_id = v_board_id;
      insert into public.lists (board_id, name, position)
      values (v_board_id, left(coalesce(p_arg->>'name', 'New list'), 80), v_pos)
      returning id into v_new_id;
      insert into public.activity (board_id, user_id, type, payload)
      values (v_board_id, p_user_id, 'list.created', jsonb_build_object('name', p_arg->>'name'));
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('list_id', v_new_id));

    when 'rename_list' then
      v_list_id := (p_arg->>'list_id')::uuid;
      update public.lists set name = left(p_arg->>'name', 80) where id = v_list_id;
      if not found then raise exception 'list not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'delete_list' then
      v_list_id := (p_arg->>'list_id')::uuid;
      select l.board_id into v_board_id from public.lists l where l.id = v_list_id;
      delete from public.lists where id = v_list_id;
      if not found then raise exception 'list not found or no access'; end if;
      insert into public.activity (board_id, user_id, type, payload)
      values (v_board_id, p_user_id, 'list.deleted', '{}'::jsonb);
      return jsonb_build_object('ok', true, 'data', null);

    -- ── cards ───────────────────────────────────────────────────────────
    when 'create_card' then
      v_list_id := (p_arg->>'list_id')::uuid;
      select
        (select l.board_id from public.lists l where l.id = v_list_id),
        coalesce((select max(c.position) from public.cards c where c.list_id = v_list_id), 0) + 1
      into v_board_id, v_pos;
      if v_board_id is null then raise exception 'list not found or no access'; end if;
      insert into public.cards (board_id, list_id, title, description, position, created_by)
      values (v_board_id, v_list_id, left(coalesce(p_arg->>'title', 'Untitled'), 500),
              coalesce(p_arg->>'description', ''), v_pos, p_user_id)
      returning id into v_new_id;
      insert into public.activity (board_id, user_id, type, payload)
      values (v_board_id, p_user_id, 'card.created', jsonb_build_object('title', p_arg->>'title'));
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('card_id', v_new_id));

    when 'update_card' then
      v_card_id := (p_arg->>'card_id')::uuid;
      if p_arg ? 'title' then
        update public.cards set title = left(p_arg->>'title', 500) where id = v_card_id;
        if not found then raise exception 'card not found or no access'; end if;
      end if;
      if p_arg ? 'description' then
        update public.cards set description = p_arg->>'description' where id = v_card_id;
        if not found then raise exception 'card not found or no access'; end if;
      end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'move_card' then
      v_card_id := (p_arg->>'card_id')::uuid;
      v_pos := (p_arg->>'position')::numeric;
      if v_pos is null then raise exception 'position (number) required'; end if;
      update public.cards
      set list_id = (p_arg->>'list_id')::uuid, position = v_pos
      where id = v_card_id;
      if not found then raise exception 'card not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'delete_card' then
      v_card_id := (p_arg->>'card_id')::uuid;
      delete from public.cards where id = v_card_id;
      if not found then raise exception 'card not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    -- ── comments ────────────────────────────────────────────────────────
    when 'add_comment' then
      v_card_id := (p_arg->>'card_id')::uuid;
      insert into public.card_comments (card_id, user_id, body)
      values (v_card_id, p_user_id, left(p_arg->>'body', 2000))
      returning id into v_new_id;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('comment_id', v_new_id));

    else
      raise exception 'unknown op: %', p_op;
  end case;
end;
$$;

-- Only the service role (the MCP edge function) may call it.
revoke execute on function public.mcp_exec(uuid, text, jsonb) from anon, authenticated;
grant execute on function public.mcp_exec(uuid, text, jsonb) to service_role;

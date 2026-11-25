-- 0061: the sanctioned end-of-life path — purging a board.
--
-- 0060's triggers created a deadlock: cards can never be deleted, cards
-- cannot move cross-board, so a board that ever held a card could never
-- be emptied — boards became immortal while the guard message told users
-- to do something impossible, and deleteWorkspace (which cascades boards)
-- started throwing the raw trigger error at workspace owners.
--
-- The model follows GitHub's: ISSUES never delete individually (the
-- capsule), but a REPOSITORY deletes deliberately, contents and all.
-- Accidental loss is what the guards prevent; a DELIBERATE, confirmed
-- delete of the whole board is the content's end of life.
--
-- purge_board is that single sanctioned deletion: owners / workspace
-- owners+admins only. It arms a TRANSACTION-SCOPED flag
-- (set_config('flowdeck.purge', 'on', true)) that the capsule's guard
-- triggers check — they stand down for exactly that one transaction,
-- and the cascade wipes the board, lists, cards, comments, and every
-- event row with it. (session_replication_role=replica would be the
-- textbook switch but hosted Supabase denies it even to definer
-- functions; a custom transaction-local GUC is just as contained — it
-- cannot outlive the transaction, and only purge_board ever sets it.)
-- Nothing survives to log (the trail was board-scoped); the audit
-- trail is the caller's own confirmation step. The accidental paths
-- (direct DELETEs, the app's plain delete) keep hitting the guards.

-- The guards, flag-aware (superseding 0060's): they still refuse every
-- accidental path; only the armed purge transaction passes.
create or replace function public.guard_card_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('flowdeck.purge', true), '') = 'on' then
    return old;
  end if;
  raise exception 'cards cannot be deleted — resolve them instead';
end;
$$;

create or replace function public.guard_list_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('flowdeck.purge', true), '') = 'on' then
    return old;
  end if;
  if exists (select 1 from public.cards c where c.list_id = old.id) then
    raise exception 'this list still holds cards — move or resolve them first';
  end if;
  return old;
end;
$$;

create or replace function public.guard_board_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('flowdeck.purge', true), '') = 'on' then
    return old;
  end if;
  if exists (select 1 from public.cards c where c.board_id = old.id) then
    raise exception 'this board still holds cards — move or resolve them first';
  end if;
  return old;
end;
$$;

create or replace function public.purge_board(p_board_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws    uuid;
  v_owner uuid;
  v_cards bigint;
begin
  if p_board_id is null then raise exception 'board not found or no access'; end if;
  select b.workspace_id, b.owner_id into v_ws, v_owner
  from public.boards b where b.id = p_board_id;
  if v_ws is null then raise exception 'board not found or no access'; end if;
  -- Same powers as the app's canDeleteBoard: the board owner, or the
  -- workspace owner/admin.
  if v_owner is distinct from auth.uid()
     and public.user_workspace_role(v_ws) not in ('owner', 'admin') then
    raise exception 'board not found or no access';
  end if;

  select count(*) into v_cards from public.cards c where c.board_id = p_board_id;

  -- The one transaction the capsule stands down for: the flag is
  -- transaction-local (reverts at commit/rollback) and only this
  -- function ever arms it.
  perform set_config('flowdeck.purge', 'on', true);
  delete from public.boards where id = p_board_id;
  if not found then raise exception 'board not found or no access'; end if;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'board_id', p_board_id, 'purged', true, 'cards_deleted', v_cards
  ));
end;
$$;

revoke execute on function public.purge_board(uuid) from anon;

-- ── mcp_exec: delete_board grows `force` — the deliberate path (full
--    redefinition superseding 0060's, kept whole so the chain stays
--    reviewable) ─────────────────────────────────────────────────────────

create or replace function public.mcp_exec(
  p_user_id uuid,
  p_op text,
  p_arg jsonb default '{}'::jsonb,
  p_workspace_ids uuid[] default '{}'::uuid[],
  p_ws_ops jsonb default null
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
  -- The BEFORE INSERT triggers on card_events / board_messages /
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
            'id', p.id, 'kind', p.kind, 'detail', p.detail,
            'actor_id', p.actor_id,
            'actor_name', (select pr.display_name from public.profiles pr where pr.id = p.actor_id),
            'created_at', p.created_at, 'agent', p.agent
          ) order by p.created_at, p.id)
          from (
            select e.id, e.kind, e.detail, e.actor_id, e.created_at, e.agent
            from public.card_events e
            where e.card_id = v_card_id
              and (v_cur_key is null or (e.created_at, e.id) >= (v_cur_key::timestamptz, v_cur_id))
            order by e.created_at asc, e.id asc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          select e.created_at::text || '|' || e.id::text
          from public.card_events e
          where e.card_id = v_card_id
            and (v_cur_key is null or (e.created_at, e.id) >= (v_cur_key::timestamptz, v_cur_id))
          order by e.created_at asc, e.id asc
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
      -- Account-level op: granted via the '*' bucket when the
      -- connection uses per-workspace permissions.
      if not public.mcp_op_ok(p_ws_ops, p_op, null) then
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
      -- Account-level op: granted via the '*' bucket when the
      -- connection uses per-workspace permissions.
      if not public.mcp_op_ok(p_ws_ops, p_op, null) then
        raise exception 'this connection does not have that permission';
      end if;

      update public.notifications set seen_at = now()
      where id = (p_arg->>'notification_id')::uuid and user_id = p_user_id;
      if not found then raise exception 'notification not found'; end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('notification_id', (p_arg->>'notification_id')::uuid, 'seen', true));

    when 'mark_notification_unread' then
      -- Account-level op: granted via the '*' bucket when the
      -- connection uses per-workspace permissions.
      if not public.mcp_op_ok(p_ws_ops, p_op, null) then
        raise exception 'this connection does not have that permission';
      end if;

      update public.notifications set seen_at = null
      where id = (p_arg->>'notification_id')::uuid and user_id = p_user_id;
      if not found then raise exception 'notification not found'; end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('notification_id', (p_arg->>'notification_id')::uuid, 'seen', false));

    when 'mark_all_notifications_read' then
      -- Account-level op: granted via the '*' bucket when the
      -- connection uses per-workspace permissions.
      if not public.mcp_op_ok(p_ws_ops, p_op, null) then
        raise exception 'this connection does not have that permission';
      end if;

      update public.notifications n set seen_at = now()
      where n.user_id = p_user_id and n.seen_at is null
        and (cardinality(v_scope) = 0 or exists (
              select 1 from public.boards b
              where b.id = n.board_id and public.mcp_scope_ok(v_scope, b.workspace_id) and public.mcp_op_ok(p_ws_ops, p_op, b.workspace_id)));
      get diagnostics v_count = row_count;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('marked', v_count));

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
      if coalesce(nullif(p_arg->>'workspace_id', ''), '') = '' then
        select wm.workspace_id into v_ws
        from public.workspace_members wm
        where wm.user_id = p_user_id
          and public.mcp_scope_ok(v_scope, wm.workspace_id)
        order by wm.created_at
        limit 1;
      else
        v_ws := (p_arg->>'workspace_id')::uuid;
      end if;
      if v_ws is null then
        raise exception 'no workspace for this account';
      end if;
      if not public.mcp_scope_ok(v_scope, v_ws)
           or not public.mcp_op_ok(p_ws_ops, p_op, v_ws) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      -- The workspace's board-creation policy, same rule as the web UI.
      if not (
        public.user_workspace_role(v_ws) in ('owner', 'admin')
        or (select w.board_creation from public.workspaces w where w.id = v_ws) = 'everyone'
        or ((select w.board_creation from public.workspaces w where w.id = v_ws) = 'team_admins'
            and exists (
              select 1 from public.team_members tm
              join public.teams t on t.id = tm.team_id
              where t.workspace_id = v_ws
                and tm.user_id = p_user_id
                and tm.role = 'admin'))
      ) then
        raise exception 'this workspace does not allow you to create boards';
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
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      update public.boards set name = left(p_arg->>'name', 80) where id = v_board_id;
      if not found then raise exception '%', public.mcp_write_error(v_board_id, 'Board'); end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('board_id', v_board_id, 'name', left(p_arg->>'name', 80)));

    when 'delete_board' then
      v_board_id := (p_arg->>'board_id')::uuid;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      -- 0059/0061: a board refuses to delete while it holds cards —
      -- unless force is set, the deliberate end-of-life path (purge_board
      -- is the single sanctioned deletion; see the migration note).
      if exists (select 1 from public.cards c where c.board_id = v_board_id) then
        if p_arg->>'force' is distinct from 'true' then
          raise exception 'this board still holds cards — delete it with force: true to remove them permanently (a deliberate purge, fully destructive)';
        end if;
        return public.purge_board(v_board_id);
      end if;
      delete from public.boards where id = v_board_id;
      if not found then raise exception '%', public.mcp_write_error(v_board_id, 'Board'); end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('board_id', v_board_id, 'deleted', true));

    when 'update_board' then
      v_board_id := (p_arg->>'board_id')::uuid;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      if p_arg ? 'name' then
        update public.boards set name = left(p_arg->>'name', 80) where id = v_board_id;
        if not found then raise exception '%', public.mcp_write_error(v_board_id, 'Board'); end if;
        insert into public.activity (board_id, user_id, type, payload)
        values (v_board_id, p_user_id, 'board.renamed', jsonb_build_object('name', p_arg->>'name'));
      end if;
      if p_arg ? 'description' then
        update public.boards set description = left(p_arg->>'description', 4000) where id = v_board_id;
        if not found then raise exception '%', public.mcp_write_error(v_board_id, 'Board'); end if;
      end if;
      -- Access delegation is gated like the app: workspace owners/admins only.
      if p_arg ? 'access_delegation' then
        if not exists (
          select 1 from public.boards b
          join public.workspace_members wm on wm.workspace_id = b.workspace_id and wm.user_id = p_user_id
          where b.id = v_board_id and wm.role in ('owner', 'admin')
        ) then
          raise exception 'only workspace owners and admins can change who may grant board access';
        end if;
        update public.boards set access_delegation = (p_arg->>'access_delegation')::boolean
        where id = v_board_id;
        if not found then raise exception '%', public.mcp_write_error(v_board_id, 'Board'); end if;
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('board_id', v_board_id) || coalesce((select jsonb_build_object('name', b.name, 'description', b.description, 'access_delegation', b.access_delegation) from public.boards b where b.id = v_board_id), '{}'::jsonb));

    -- ── lists ───────────────────────────────────────────────────────────
    when 'create_list' then
      v_board_id := (p_arg->>'board_id')::uuid;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      -- A board the caller cannot see used to die with an opaque RLS
      -- crash at the insert; view-only members got the same. Both get a
      -- precise error before the insert now.
      if public.user_board_access(v_board_id) is null then
        raise exception 'board not found or no access';
      end if;
      if public.user_board_access(v_board_id) = 'view' then
        raise exception '%', public.mcp_write_error(v_board_id, 'List');
      end if;
      -- Atomic append: same guarantee as cards, per board.
      v_pos := public.allocate_list_position(v_board_id);
      insert into public.lists (board_id, name, position)
      values (v_board_id, left(coalesce(p_arg->>'name', 'New list'), 80), v_pos)
      returning id into v_new_id;
      insert into public.activity (board_id, user_id, type, payload)
      values (v_board_id, p_user_id, 'list.created', jsonb_build_object('name', p_arg->>'name'));
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('list_id', v_new_id));

    when 'rename_list' then
      v_list_id := (p_arg->>'list_id')::uuid;
      -- A missing/deleted row must say so, not read as a permission
      -- problem: a workspace-scoped token hit the scope gate with a
      -- NULL workspace and saw the permission error instead.
      if not exists (select 1 from public.lists l where l.id = v_list_id) then
        raise exception 'list not found or no access';
      end if;
      select l.board_id into v_board_id from public.lists l where l.id = v_list_id;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.lists l join public.boards b on b.id = l.board_id where l.id = v_list_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.lists l join public.boards b on b.id = l.board_id where l.id = v_list_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      update public.lists set name = left(p_arg->>'name', 80) where id = v_list_id;
      if not found then raise exception '%', public.mcp_write_error(v_board_id, 'List'); end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('list_id', v_list_id, 'name', left(p_arg->>'name', 80)));

    when 'delete_list' then
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
      select l.board_id into v_board_id from public.lists l where l.id = v_list_id;
      -- 0059: lists never take their cards with them — a list with cards
      -- (resolved or not) refuses to delete.
      if exists (select 1 from public.cards c where c.list_id = v_list_id) then
        raise exception 'this list still holds cards — move or resolve them first';
      end if;
      delete from public.lists where id = v_list_id;
      if not found then raise exception '%', public.mcp_write_error(v_board_id, 'List'); end if;
      insert into public.activity (board_id, user_id, type, payload)
      values (v_board_id, p_user_id, 'list.deleted', '{}'::jsonb);
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('list_id', v_list_id, 'board_id', v_board_id, 'deleted', true));

    when 'update_list' then
      v_list_id := (p_arg->>'list_id')::uuid;
      -- A missing/deleted row must say so, not read as a permission
      -- problem: a workspace-scoped token hit the scope gate with a
      -- NULL workspace and saw the permission error instead.
      if not exists (select 1 from public.lists l where l.id = v_list_id) then
        raise exception 'list not found or no access';
      end if;
      select l.board_id into v_board_id from public.lists l where l.id = v_list_id;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.lists l join public.boards b on b.id = l.board_id where l.id = v_list_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.lists l join public.boards b on b.id = l.board_id where l.id = v_list_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      if p_arg ? 'name' then
        update public.lists set name = left(p_arg->>'name', 80) where id = v_list_id;
        if not found then raise exception '%', public.mcp_write_error(v_board_id, 'List'); end if;
      end if;
      if p_arg ? 'description' then
        update public.lists set description = left(p_arg->>'description', 2000) where id = v_list_id;
        if not found then raise exception '%', public.mcp_write_error(v_board_id, 'List'); end if;
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('list_id', v_list_id) || coalesce((select jsonb_build_object('name', l.name, 'description', l.description) from public.lists l where l.id = v_list_id), '{}'::jsonb));

    -- ── cards ───────────────────────────────────────────────────────────
    when 'create_card' then
      v_list_id := (p_arg->>'list_id')::uuid;
      select l.board_id into v_board_id from public.lists l where l.id = v_list_id;
      if v_board_id is null then raise exception 'list not found or no access'; end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;

      -- View-only members get a precise error instead of an RLS crash.
      if public.user_board_access(v_board_id) = 'view' then
        raise exception '%', public.mcp_write_error(v_board_id, 'Card');
      end if;
      -- Atomic append: concurrent creators serialize on the list_seq row,
      -- so parallel calls can never land on the same position.
      v_pos := public.allocate_card_position(v_list_id);
      if p_arg ? 'priority' and nullif(p_arg->>'priority', '') is not null
         and p_arg->>'priority' not in ('low', 'medium', 'high', 'urgent') then
        raise exception 'priority must be one of low, medium, high, urgent (or empty)';
      end if;
      insert into public.cards (board_id, list_id, title, description, position, priority, created_by)
      values (v_board_id, v_list_id, left(coalesce(p_arg->>'title', 'Untitled'), 200),
              left(coalesce(p_arg->>'description', ''), 8000), v_pos,
              nullif(p_arg->>'priority', ''), p_user_id)
      returning id into v_new_id;
      insert into public.activity (board_id, user_id, type, payload)
      values (v_board_id, p_user_id, 'card.created', jsonb_build_object('title', p_arg->>'title'));
      insert into public.card_events (card_id, board_id, actor_id, kind, detail)
      values (v_new_id, v_board_id, p_user_id, 'created',
              jsonb_build_object('title', left(coalesce(p_arg->>'title', 'Untitled'), 200),
                                 'list', (select l.name from public.lists l where l.id = v_list_id)));
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('card_id', v_new_id));

    when 'update_card' then
      v_card_id := (p_arg->>'card_id')::uuid;
      -- Capture the BEFORE state: timeline diffs read "from -> to"
      -- (same events the web app logs).
      select c.board_id, c.title, coalesce(c.priority, ''), c.description
      into v_board_id, v_title, v_prio, v_desc
      from public.cards c where c.id = v_card_id;
      if v_board_id is null then raise exception 'card not found or no access'; end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;

      if p_arg ? 'title' then
        update public.cards set title = left(p_arg->>'title', 200) where id = v_card_id;
        if not found then raise exception '%', public.mcp_write_error(v_board_id, 'Card'); end if;
        if left(p_arg->>'title', 200) is distinct from v_title then
          insert into public.card_events (card_id, board_id, actor_id, kind, detail)
          values (v_card_id, v_board_id, p_user_id, 'renamed',
                  jsonb_build_object('from', v_title, 'to', left(p_arg->>'title', 200)));
        end if;
      end if;
      if p_arg ? 'description' then
        update public.cards set description = left(p_arg->>'description', 8000) where id = v_card_id;
        if not found then raise exception '%', public.mcp_write_error(v_board_id, 'Card'); end if;
        if left(p_arg->>'description', 8000) is distinct from v_desc then
          insert into public.card_events (card_id, board_id, actor_id, kind, detail)
          values (v_card_id, v_board_id, p_user_id, 'description', '{}'::jsonb);
        end if;
      end if;
      if p_arg ? 'priority' then
        if nullif(p_arg->>'priority', '') is not null
           and p_arg->>'priority' not in ('low', 'medium', 'high', 'urgent') then
          raise exception 'priority must be one of low, medium, high, urgent (or empty)';
        end if;
        update public.cards set priority = nullif(p_arg->>'priority', '') where id = v_card_id;
        if not found then raise exception '%', public.mcp_write_error(v_board_id, 'Card'); end if;
        if coalesce(p_arg->>'priority', '') is distinct from v_prio then
          insert into public.card_events (card_id, board_id, actor_id, kind, detail)
          values (v_card_id, v_board_id, p_user_id, 'priority',
                  jsonb_build_object('from', nullif(v_prio, ''), 'to', nullif(p_arg->>'priority', '')));
        end if;
      end if;
      -- Tags: replace the linked set (the tags themselves are shared rows).
      if p_arg ? 'tag_ids' then
        select c.board_id into v_board_id from public.cards c where c.id = v_card_id;
        if v_board_id is null then raise exception 'card not found or no access'; end if;
        select coalesce(array_agg(ct.tag_id order by ct.tag_id), '{}'::uuid[]) into v_prev
        from public.card_tags ct where ct.card_id = v_card_id;
        delete from public.card_tags where card_id = v_card_id;
        insert into public.card_tags (card_id, tag_id)
        select v_card_id, x::uuid
        from jsonb_array_elements_text(p_arg->'tag_ids') as x
        where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          -- Tags are workspace vocabulary: only this card's workspace's
          -- tags may be attached (round-3: cross-workspace injection).
          and exists (
            select 1 from public.tags t
            where t.id = x::uuid
              and t.workspace_id = (select b.workspace_id from public.boards b where b.id = v_board_id)
          );
        -- Timeline: tags added / removed — ids + name snapshots. This
        -- event was missing from MCP entirely (0058); the web app logs
        -- the same shape.
        if exists (
             select 1 from public.card_tags ct
             where ct.card_id = v_card_id and not (ct.tag_id = any (v_prev))
           )
           or exists (
             select 1
             from unnest(v_prev) as x
             where not exists (
               select 1 from public.card_tags ct
               where ct.card_id = v_card_id and ct.tag_id = x
             )
           ) then
          insert into public.card_events (card_id, board_id, actor_id, kind, detail)
          values (v_card_id, v_board_id, p_user_id, 'tags', jsonb_build_object(
            'added', coalesce((
              select jsonb_agg(jsonb_build_object('id', ct.tag_id, 'name', t.name) order by ct.tag_id)
              from public.card_tags ct
              join public.tags t on t.id = ct.tag_id
              where ct.card_id = v_card_id and not (ct.tag_id = any (v_prev))
            ), '[]'::jsonb),
            'removed', coalesce((
              select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.id)
              from public.tags t
              where t.id = any (v_prev)
                and not exists (
                  select 1 from public.card_tags ct
                  where ct.card_id = v_card_id and ct.tag_id = t.id
                )
            ), '[]'::jsonb)
          ));
        end if;
      end if;
      -- Assignees: replace-set semantics, exactly like the app's updateCard.
      if p_arg ? 'assignees' then
        select c.board_id into v_board_id from public.cards c where c.id = v_card_id;
        if v_board_id is null then raise exception 'card not found or no access'; end if;
        -- Remember who is assigned now, so only NEWLY added people notify.
        select coalesce(array_agg(a.user_id order by a.user_id), '{}'::uuid[]) into v_prev
        from public.card_assignees a where a.card_id = v_card_id;
        delete from public.card_assignees where card_id = v_card_id;
        insert into public.card_assignees (card_id, user_id)
        select v_card_id, x::uuid
        from jsonb_array_elements_text(p_arg->'assignees') as x
        where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
        -- The app notifies people newly assigned; MCP does the same.
        insert into public.notifications (user_id, kind, card_id, board_id, actor_id, body)
        select a.user_id, 'assignment', v_card_id, v_board_id, p_user_id, null
        from public.card_assignees a
        where a.card_id = v_card_id
          and not (a.user_id = any (v_prev));
        -- Timeline: who got assigned / unassigned — ids + name snapshots
        -- (0058: chips resolve the CURRENT name by id; the snapshot is
        -- the fallback when the person is gone). Only logged when the
        -- replace actually changed the set (same noise filter as the
        -- web writer).
        if exists (
             select 1 from public.card_assignees a
             where a.card_id = v_card_id and not (a.user_id = any (v_prev))
           )
           or exists (
             select 1
             from unnest(v_prev) as x
             where not exists (
               select 1 from public.card_assignees a
               where a.card_id = v_card_id and a.user_id = x
             )
           ) then
          insert into public.card_events (card_id, board_id, actor_id, kind, detail)
          values (v_card_id, v_board_id, p_user_id, 'assignees', jsonb_build_object(
            'added', coalesce((
              select jsonb_agg(jsonb_build_object('id', a.user_id, 'name', pr.display_name) order by a.user_id)
              from public.card_assignees a
              join public.profiles pr on pr.id = a.user_id
              where a.card_id = v_card_id and not (a.user_id = any (v_prev))
            ), '[]'::jsonb),
            'removed', coalesce((
              select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.display_name) order by pr.id)
              from public.profiles pr
              where pr.id = any (v_prev)
                and not exists (
                  select 1 from public.card_assignees a
                  where a.card_id = v_card_id and a.user_id = pr.id
                )
            ), '[]'::jsonb)
          ));
        end if;
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('card_id', v_card_id) || coalesce((select jsonb_build_object('title', c.title, 'priority', c.priority, 'description', c.description) from public.cards c where c.id = v_card_id), '{}'::jsonb));

    when 'move_card' then
      v_card_id := (p_arg->>'card_id')::uuid;
      select c.board_id, c.list_id, (select l.name from public.lists l where l.id = c.list_id), c.resolved_at
      into v_board_id, v_list_id, v_title, v_resolved
      from public.cards c where c.id = v_card_id;
      if v_board_id is null then raise exception 'card not found or no access'; end if;
      -- 0059: resolved cards are hidden from the board — they come back
      -- through unresolve_card, not by being moved in place.
      if v_resolved is not null then
        raise exception 'this card is resolved — unresolve it first';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.lists l join public.boards b on b.id = l.board_id where l.id = (p_arg->>'list_id')::uuid))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.lists l join public.boards b on b.id = l.board_id where l.id = (p_arg->>'list_id')::uuid)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      if (select l.board_id from public.lists l where l.id = (p_arg->>'list_id')::uuid) is distinct from v_board_id then
        raise exception 'the target list belongs to a different board';
      end if;

      if p_arg ? 'position' then
        v_pos := (p_arg->>'position')::double precision;
      else
        -- No position given: append at the end of the target list,
        -- atomically — safe for concurrent movers.
        v_pos := public.allocate_card_position((p_arg->>'list_id')::uuid);
      end if;
      if v_pos is null then raise exception 'position (number) required'; end if;
      update public.cards
      set list_id = (p_arg->>'list_id')::uuid, position = v_pos
      where id = v_card_id;
      if not found then raise exception '%', public.mcp_write_error(v_board_id, 'Card'); end if;
      -- Timeline: only when the card actually changed lists (same noise
      -- filter as the app).
      if v_list_id is distinct from (p_arg->>'list_id')::uuid then
        insert into public.card_events (card_id, board_id, actor_id, kind, detail)
        values (v_card_id, v_board_id, p_user_id, 'moved', jsonb_build_object(
          'from', v_title,
          'to', (select l.name from public.lists l where l.id = (p_arg->>'list_id')::uuid)
        ));
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('card_id', v_card_id, 'list_id', (p_arg->>'list_id')::uuid, 'position', v_pos));

    when 'delete_card' then
      v_card_id := (p_arg->>'card_id')::uuid;
      -- A missing/deleted row must say so, not read as a permission
      -- problem: a workspace-scoped token hit the scope gate with a
      -- NULL workspace and saw the permission error instead.
      if not exists (select 1 from public.cards c where c.id = v_card_id) then
        raise exception 'card not found or no access';
      end if;
      select c.board_id into v_board_id from public.cards c where c.id = v_card_id;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.cards c join public.boards b on b.id = c.board_id where c.id = v_card_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.cards c join public.boards b on b.id = c.board_id where c.id = v_card_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      -- 0059: the time capsule — a card can never be deleted, only
      -- hidden. Agents clean up with resolve_card.
      raise exception 'cards cannot be deleted — resolve them instead (resolve_card)';

    when 'resolve_card' then
      v_card_id := (p_arg->>'card_id')::uuid;
      -- A missing/deleted row must say so, not read as a permission
      -- problem (the convention every op carries).
      if not exists (select 1 from public.cards c where c.id = v_card_id) then
        raise exception 'card not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.cards c join public.boards b on b.id = c.board_id where c.id = v_card_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.cards c join public.boards b on b.id = c.board_id where c.id = v_card_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      perform public.resolve_card(v_card_id);
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('card_id', v_card_id, 'resolved', true));

    when 'unresolve_card' then
      v_card_id := (p_arg->>'card_id')::uuid;
      -- A missing/deleted row must say so, not read as a permission
      -- problem (the convention every op carries).
      if not exists (select 1 from public.cards c where c.id = v_card_id) then
        raise exception 'card not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.cards c join public.boards b on b.id = c.board_id where c.id = v_card_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.cards c join public.boards b on b.id = c.board_id where c.id = v_card_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      return public.unresolve_card(v_card_id);

    -- ── comments + board chat ────────────────────────────────────────────
    when 'add_comment' then
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
      insert into public.card_comments (card_id, user_id, body, seq)
      values (v_card_id, p_user_id, left(p_arg->>'body', 2000),
              public.allocate_chat_seq('card_comment', v_card_id))
      returning id into v_new_id;
      -- Mention delivery: parse user:/team: links and notify everyone
      -- who can see the board (same filter as the app's notify path).
      select c.board_id into v_board_id from public.cards c where c.id = v_card_id;
      insert into public.notifications (user_id, kind, card_id, board_id, actor_id, body)
      select distinct on (x) x::uuid, 'mention', v_card_id, v_board_id, p_user_id,
             left(p_arg->>'body', 200)
      from regexp_matches(p_arg->>'body', '\]\(user:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)', 'g') as m,
           unnest(array[m[1]]) as x
      where x::uuid is distinct from p_user_id
        and (
          exists (select 1 from public.board_access ba
                  where ba.board_id = v_board_id and ba.user_id = x::uuid)
          or exists (select 1 from public.boards b
                     join public.workspace_members wm on wm.workspace_id = b.workspace_id
                     where b.id = v_board_id and wm.user_id = x::uuid
                       and (wm.role in ('owner','admin') or b.owner_id = x::uuid))
          or exists (select 1 from public.team_members tm
                     join public.board_team_access bta on bta.team_id = tm.team_id
                     where bta.board_id = v_board_id and tm.user_id = x::uuid)
        );
      insert into public.notifications (user_id, kind, card_id, board_id, actor_id, body)
      select distinct tm.user_id, 'mention', v_card_id, v_board_id, p_user_id,
             left(p_arg->>'body', 200)
      from regexp_matches(p_arg->>'body', '\]\(team:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)', 'g') as m
      join public.team_members tm on tm.team_id = m[1]::uuid
      where tm.user_id is distinct from p_user_id
        and (
          exists (select 1 from public.board_access ba
                  where ba.board_id = v_board_id and ba.user_id = tm.user_id)
          or exists (select 1 from public.boards b
                     join public.workspace_members wm on wm.workspace_id = b.workspace_id
                     where b.id = v_board_id and wm.user_id = tm.user_id
                       and (wm.role in ('owner','admin') or b.owner_id = tm.user_id))
          or exists (select 1 from public.team_members tm2
                     join public.board_team_access bta on bta.team_id = tm2.team_id
                     where bta.board_id = v_board_id and tm2.user_id = tm.user_id)
        );
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('comment_id', v_new_id));

    when 'edit_comment' then
      -- Editing is the author's alone (RLS, 0057); deletes are the
      -- role-scoped path, not edits.
      -- A missing/deleted row must say so, not read as a permission
      -- problem: a workspace-scoped token hit the scope gate with a
      -- NULL workspace and saw the permission error instead.
      if not exists (select 1 from public.card_comments cm where cm.id = (p_arg->>'comment_id')::uuid and cm.deleted_at is null) then
        raise exception 'comment not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.card_comments cm join public.cards c on c.id = cm.card_id join public.boards b on b.id = c.board_id where cm.id = (p_arg->>'comment_id')::uuid))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.card_comments cm join public.cards c on c.id = cm.card_id join public.boards b on b.id = c.board_id where cm.id = (p_arg->>'comment_id')::uuid)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      update public.card_comments
      set body = left(p_arg->>'body', 2000), edited_at = now()
      where id = (p_arg->>'comment_id')::uuid and deleted_at is null;
      if not found then raise exception 'comment not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('comment_id', (p_arg->>'comment_id')::uuid, 'edited', true));

    when 'delete_comment' then
      -- A missing/deleted row must say so, not read as a permission
      -- problem: a workspace-scoped token hit the scope gate with a
      -- NULL workspace and saw the permission error instead.
      if not exists (select 1 from public.card_comments cm where cm.id = (p_arg->>'comment_id')::uuid and cm.deleted_at is null) then
        raise exception 'comment not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.card_comments cm join public.cards c on c.id = cm.card_id join public.boards b on b.id = c.board_id where cm.id = (p_arg->>'comment_id')::uuid))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.card_comments cm join public.cards c on c.id = cm.card_id join public.boards b on b.id = c.board_id where cm.id = (p_arg->>'comment_id')::uuid)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      -- Role-scoped soft delete (author / owner / admin / team admin) —
      -- the same RPC the web app calls; stamps the tombstone trail.
      perform public.delete_comment((p_arg->>'comment_id')::uuid);
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('comment_id', (p_arg->>'comment_id')::uuid, 'deleted', true));

    when 'post_board_message' then
      v_board_id := (p_arg->>'board_id')::uuid;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      if public.user_board_access(v_board_id) is null then
        raise exception 'board not found or no access';
      end if;
      -- Board chat needs edit access (card comments are open to viewers).
      if public.user_board_access(v_board_id) = 'view' then
        raise exception 'Board chat: read-only — you only have VIEW access to this board. Card comments still work; posting to the board chat does not.';
      end if;
      insert into public.board_messages (board_id, user_id, body, seq)
      values (v_board_id, p_user_id, left(p_arg->>'body', 4000),
              public.allocate_chat_seq('board_message', v_board_id))
      returning id into v_new_id;
      -- Mention delivery: same as add_comment.
      insert into public.notifications (user_id, kind, board_id, actor_id, body)
      select distinct on (x) x::uuid, 'mention', v_board_id, p_user_id,
             left(p_arg->>'body', 200)
      from regexp_matches(p_arg->>'body', '\]\(user:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)', 'g') as m,
           unnest(array[m[1]]) as x
      where x::uuid is distinct from p_user_id
        and (
          exists (select 1 from public.board_access ba
                  where ba.board_id = v_board_id and ba.user_id = x::uuid)
          or exists (select 1 from public.boards b
                     join public.workspace_members wm on wm.workspace_id = b.workspace_id
                     where b.id = v_board_id and wm.user_id = x::uuid
                       and (wm.role in ('owner','admin') or b.owner_id = x::uuid))
          or exists (select 1 from public.team_members tm
                     join public.board_team_access bta on bta.team_id = tm.team_id
                     where bta.board_id = v_board_id and tm.user_id = x::uuid)
        );
      insert into public.notifications (user_id, kind, board_id, actor_id, body)
      select distinct tm.user_id, 'mention', v_board_id, p_user_id,
             left(p_arg->>'body', 200)
      from regexp_matches(p_arg->>'body', '\]\(team:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)', 'g') as m
      join public.team_members tm on tm.team_id = m[1]::uuid
      where tm.user_id is distinct from p_user_id
        and (
          exists (select 1 from public.board_access ba
                  where ba.board_id = v_board_id and ba.user_id = tm.user_id)
          or exists (select 1 from public.boards b
                     join public.workspace_members wm on wm.workspace_id = b.workspace_id
                     where b.id = v_board_id and wm.user_id = tm.user_id
                       and (wm.role in ('owner','admin') or b.owner_id = tm.user_id))
          or exists (select 1 from public.team_members tm2
                     join public.board_team_access bta on bta.team_id = tm2.team_id
                     where bta.board_id = v_board_id and tm2.user_id = tm.user_id)
        );
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('message_id', v_new_id));

    when 'edit_board_message' then
      -- Editing is the author's alone (RLS, 0057); deletes are the
      -- role-scoped path, not edits.
      -- A missing/deleted row must say so, not read as a permission
      -- problem: a workspace-scoped token hit the scope gate with a
      -- NULL workspace and saw the permission error instead.
      if not exists (select 1 from public.board_messages m where m.id = (p_arg->>'message_id')::uuid and m.deleted_at is null) then
        raise exception 'message not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.board_messages m join public.boards b on b.id = m.board_id where m.id = (p_arg->>'message_id')::uuid))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.board_messages m join public.boards b on b.id = m.board_id where m.id = (p_arg->>'message_id')::uuid)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      update public.board_messages
      set body = left(p_arg->>'body', 4000), edited_at = now()
      where id = (p_arg->>'message_id')::uuid and deleted_at is null;
      if not found then raise exception 'message not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('message_id', (p_arg->>'message_id')::uuid, 'edited', true));

    when 'delete_board_message' then
      -- Soft delete: the row stays for history, every read hides it.
      -- A missing/deleted row must say so, not read as a permission
      -- problem: a workspace-scoped token hit the scope gate with a
      -- NULL workspace and saw the permission error instead.
      if not exists (select 1 from public.board_messages m where m.id = (p_arg->>'message_id')::uuid and m.deleted_at is null) then
        raise exception 'message not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.board_messages m join public.boards b on b.id = m.board_id where m.id = (p_arg->>'message_id')::uuid))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.board_messages m join public.boards b on b.id = m.board_id where m.id = (p_arg->>'message_id')::uuid)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      -- Role-scoped soft delete (author / owner / admin / team admin) —
      -- the same RPC the web app calls; stamps the tombstone trail.
      perform public.delete_board_message((p_arg->>'message_id')::uuid);
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('message_id', (p_arg->>'message_id')::uuid, 'deleted', true));

    -- ── workspaces + invites ────────────────────────────────────────────
    when 'create_workspace' then
      -- Account-level op: granted via the '*' bucket when the
      -- connection uses per-workspace permissions.
      if not public.mcp_op_ok(p_ws_ops, p_op, null) then
        raise exception 'this connection does not have that permission';
      end if;

      -- The scope compartmentalization only vetoes LEGACY tokens — for
      -- them, scope is the only grant boundary. A per-workspace token
      -- that carries the account 'create workspaces' grant creates
      -- regardless of which workspaces it is scoped to: the account
      -- bucket is the user's explicit, separate choice.
      if p_ws_ops is null and cardinality(v_scope) > 0 then
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

    when 'invite_member' then
      v_ws := (p_arg->>'workspace_id')::uuid;
      if not public.mcp_scope_ok(v_scope, v_ws)
           or not public.mcp_op_ok(p_ws_ops, p_op, v_ws) then
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
    when 'create_team' then
      v_ws := (p_arg->>'workspace_id')::uuid;
      if not public.mcp_scope_ok(v_scope, v_ws)
           or not public.mcp_op_ok(p_ws_ops, p_op, v_ws) then
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

    when 'update_team' then
      v_new_id := (p_arg->>'team_id')::uuid;
      if not public.mcp_scope_ok(v_scope, (select t.workspace_id from public.teams t where t.id = v_new_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select t.workspace_id from public.teams t where t.id = v_new_id)) then
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

    when 'add_team_member' then
      if not public.mcp_scope_ok(v_scope, (select t.workspace_id from public.teams t where t.id = (p_arg->>'team_id')::uuid))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select t.workspace_id from public.teams t where t.id = (p_arg->>'team_id')::uuid)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      insert into public.team_members (team_id, user_id, role)
      values ((p_arg->>'team_id')::uuid, (p_arg->>'user_id')::uuid,
              case when p_arg->>'role' = 'admin' then 'admin' else 'member' end)
      on conflict (team_id, user_id) do update set role = excluded.role;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('team_id', (p_arg->>'team_id')::uuid, 'user_id', (p_arg->>'user_id')::uuid, 'role', case when p_arg->>'role' = 'admin' then 'admin' else 'member' end));

    when 'remove_team_member' then
      if not public.mcp_scope_ok(v_scope, (select t.workspace_id from public.teams t where t.id = (p_arg->>'team_id')::uuid))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select t.workspace_id from public.teams t where t.id = (p_arg->>'team_id')::uuid)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      delete from public.team_members
      where team_id = (p_arg->>'team_id')::uuid and user_id = (p_arg->>'user_id')::uuid;
      if not found then raise exception 'member not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('team_id', (p_arg->>'team_id')::uuid, 'user_id', (p_arg->>'user_id')::uuid, 'removed', true));

    -- ── tags ─────────────────────────────────────────────────────────────
    when 'list_tags' then
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
            'id', p.id, 'name', p.name, 'description', p.description, 'created_at', p.created_at
          ) order by p.created_at, p.id)
          from (
            select t.id, t.name, t.description, t.created_at
            from public.tags t
            where t.workspace_id = v_ws
              and (v_cur_key is null or (t.created_at, t.id) >= (v_cur_key::timestamptz, v_cur_id))
            order by t.created_at asc, t.id asc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          select t.created_at::text || '|' || t.id::text
          from public.tags t
          where t.workspace_id = v_ws
            and (v_cur_key is null or (t.created_at, t.id) >= (v_cur_key::timestamptz, v_cur_id))
          order by t.created_at asc, t.id asc
          offset v_limit limit 1
        )
      ));

    when 'create_tag' then
      -- Find-or-create, like the app's composer: lowercased, <= 24 chars.
      v_ws := (p_arg->>'workspace_id')::uuid;
      if not public.mcp_scope_ok(v_scope, v_ws)
           or not public.mcp_op_ok(p_ws_ops, p_op, v_ws) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      insert into public.tags (workspace_id, name, description)
      values (v_ws, lower(left(btrim(p_arg->>'name'), 24)), left(coalesce(p_arg->>'description', ''), 500))
      on conflict (workspace_id, name) do nothing
      returning id into v_new_id;
      if v_new_id is null then
        select t.id into v_new_id from public.tags t
        where t.workspace_id = v_ws and t.name = lower(left(btrim(p_arg->>'name'), 24));
      end if;
      if v_new_id is null then
        raise exception 'no access to create tags in this workspace';
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('tag_id', v_new_id));

    when 'rename_tag' then
      if not public.mcp_scope_ok(v_scope, (select t.workspace_id from public.tags t where t.id = (p_arg->>'tag_id')::uuid))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select t.workspace_id from public.tags t where t.id = (p_arg->>'tag_id')::uuid)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      -- Owners/admins only (tags_update_admin policy).
      if nullif(p_arg->>'name', '') is null then raise exception 'tag name cannot be empty'; end if;
      update public.tags set name = lower(left(btrim(p_arg->>'name'), 24))
      where id = (p_arg->>'tag_id')::uuid;
      if not found then raise exception 'tag not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('tag_id', (p_arg->>'tag_id')::uuid, 'name', lower(left(btrim(p_arg->>'name'), 24))));

    when 'delete_tag' then
      if not public.mcp_scope_ok(v_scope, (select t.workspace_id from public.tags t where t.id = (p_arg->>'tag_id')::uuid))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select t.workspace_id from public.tags t where t.id = (p_arg->>'tag_id')::uuid)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      -- Owners/admins only (tags_delete_admin policy); linked cards lose it.
      delete from public.tags where id = (p_arg->>'tag_id')::uuid;
      if not found then raise exception 'tag not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('tag_id', (p_arg->>'tag_id')::uuid, 'deleted', true));

    when 'merge_tags' then
      if not exists (select 1 from public.tags t where t.id = (p_arg->>'source_tag_id')::uuid)
         or not exists (select 1 from public.tags t where t.id = (p_arg->>'target_tag_id')::uuid) then
        raise exception 'tag not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select t.workspace_id from public.tags t where t.id = (p_arg->>'source_tag_id')::uuid))
         or not public.mcp_scope_ok(v_scope, (select t.workspace_id from public.tags t where t.id = (p_arg->>'target_tag_id')::uuid))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select t.workspace_id from public.tags t where t.id = (p_arg->>'source_tag_id')::uuid))
         or not public.mcp_scope_ok(v_scope, (select t.workspace_id from public.tags t where t.id = (p_arg->>'target_tag_id')::uuid)) then
        raise exception 'this connection does not have that permission in this workspace';
      end if;
      if (select t.workspace_id from public.tags t where t.id = (p_arg->>'source_tag_id')::uuid)
         is distinct from
         (select t.workspace_id from public.tags t where t.id = (p_arg->>'target_tag_id')::uuid) then
        raise exception 'cannot merge tags from different workspaces';
      end if;
      -- Owners/admins: links move to the target (duplicates skipped),
      -- the source tag disappears.
      if (p_arg->>'source_tag_id')::uuid = (p_arg->>'target_tag_id')::uuid then
        raise exception 'source and target are the same tag';
      end if;
      -- v_count = cards that actually moved (row count of the insert).
      insert into public.card_tags (card_id, tag_id)
      select ct.card_id, (p_arg->>'target_tag_id')::uuid
      from public.card_tags ct
      where ct.tag_id = (p_arg->>'source_tag_id')::uuid
        and not exists (
          select 1 from public.card_tags t2
          where t2.card_id = ct.card_id and t2.tag_id = (p_arg->>'target_tag_id')::uuid
        );
      get diagnostics v_count = row_count;
      delete from public.tags where id = (p_arg->>'source_tag_id')::uuid;
      if not found then raise exception 'tag not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('target_tag_id', (p_arg->>'target_tag_id')::uuid, 'merged_tag_id', (p_arg->>'source_tag_id')::uuid, 'cards_moved', v_count));

    -- ── mention access flow ─────────────────────────────────────────────
    when 'check_mention_access' then
      v_board_id := (p_arg->>'board_id')::uuid;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
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

    when 'grant_board_access' then
      v_board_id := (p_arg->>'board_id')::uuid;
      if not exists (select 1 from public.boards b where b.id = v_board_id) then
        raise exception 'board not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
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

    when 'request_board_access' then
      v_board_id := (p_arg->>'board_id')::uuid;
      if not exists (select 1 from public.boards b where b.id = v_board_id) then
        raise exception 'board not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
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

    when 'resolve_access_request' then
      v_board_id := (p_arg->>'board_id')::uuid;
      if not exists (select 1 from public.boards b where b.id = v_board_id) then
        raise exception 'board not found or no access';
      end if;
      if not public.mcp_scope_ok(v_scope, (select b.workspace_id from public.boards b where b.id = v_board_id))
           or not public.mcp_op_ok(p_ws_ops, p_op, (select b.workspace_id from public.boards b where b.id = v_board_id)) then
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

    -- ── status ───────────────────────────────────────────────────────────
    when 'set_status' then
      -- Account-level op: granted via the '*' bucket when the
      -- connection uses per-workspace permissions.
      if not public.mcp_op_ok(p_ws_ops, p_op, null) then
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

    else
      raise exception 'unknown op: %', p_op;
  end case;
end;
$$;

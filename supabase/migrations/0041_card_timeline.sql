-- 0041: the card timeline opens up for agents (cards #20 + #44).
--
-- #44: MCP mutations were invisible to the card's timeline — moves made
-- through MCP (and cards created through MCP) never produced card_events,
-- so the history was full of holes. Now every mcp_exec mutation logs the
-- SAME events, with the SAME detail shapes, the web app logs:
--   created { title, list }   renamed { from, to }   priority { from, to }
--   description {}            moved { from, to }     assignees { added, removed }
--
-- New op: get_card_events(card_id, cursor?, limit?) — the card's timeline
-- (kind, detail, actor with display name, created_at), oldest first,
-- cursor-paginated. Reads follow the same RLS as the app's timeline.
-- mcp_exec: chat reads hide deleted rows and expose the edited marker;
-- four new ops cover edit/delete, all role-scoped through the
-- policies above.
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
  v_pos      double precision;
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

  -- Page size clamp shared by every paginated op: default 50, 1..200.
  v_limit := least(greatest(coalesce((p_arg->>'limit')::int, 50), 1), 200);

  case p_op
    -- ── reads ────────────────────────────────────────────────────────────
    when 'list_boards' then
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(
            jsonb_build_object('id', p.id, 'name', p.name, 'workspace_id', p.workspace_id, 'updated_at', p.updated_at)
            order by p.updated_at desc, p.id desc
          )
          from (
            select b.id, b.name, b.workspace_id, b.updated_at
            from public.boards b
            where v_cur_key is null
               or (b.updated_at, b.id) <= (v_cur_key::timestamptz, v_cur_id)
            order by b.updated_at desc, b.id desc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          select b.updated_at::text || '|' || b.id::text
          from public.boards b
          where v_cur_key is null
             or (b.updated_at, b.id) <= (v_cur_key::timestamptz, v_cur_id)
          order by b.updated_at desc, b.id desc
          offset v_limit limit 1
        )
      ));

    when 'get_board' then
      v_board_id := (p_arg->>'board_id')::uuid;
      return jsonb_build_object(
        'ok', true,
        'data', jsonb_build_object(
          'board', (select to_jsonb(b) from public.boards b where b.id = v_board_id),
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
      return jsonb_build_object(
        'ok', true,
        'data', jsonb_build_object(
          'board', (select to_jsonb(b) from public.boards b where b.id = v_board_id),
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
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
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
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', p.id, 'user_id', p.user_id, 'body', p.body, 'seq', p.seq,
            'edited', p.edited_at is not null, 'edited_at', p.edited_at, 'created_at', p.created_at
          ) order by p.seq, p.id)
          from (
            select m.id, m.user_id, m.body, m.seq, m.edited_at, m.created_at
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
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', p.id, 'kind', p.kind, 'detail', p.detail,
            'actor_id', p.actor_id,
            'actor_name', (select pr.display_name from public.profiles pr where pr.id = p.actor_id),
            'created_at', p.created_at
          ) order by p.created_at, p.id)
          from (
            select e.id, e.kind, e.detail, e.actor_id, e.created_at
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
      v_cur := nullif(p_arg->>'cursor', '');      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
      return jsonb_build_object('ok', true, 'data', jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', p.id, 'body', p.body, 'user_id', p.user_id, 'seq', p.seq,
            'edited', p.edited_at is not null, 'edited_at', p.edited_at, 'created_at', p.created_at
          ) order by p.seq, p.id)
          from (
            select cm.id, cm.body, cm.user_id, cm.seq, cm.edited_at, cm.created_at
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
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
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
      -- The app's profile edit: display name only (avatar is a file upload).
      if p_arg ? 'display_name' then
        update public.profiles set display_name = left(p_arg->>'display_name', 80)
        where id = p_user_id;
      end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'list_workspaces' then
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
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
            and (v_cur_key is null or (wm.created_at, w.id) >= (v_cur_key::timestamptz, v_cur_id))
          order by wm.created_at asc, w.id asc
          offset v_limit limit 1
        )
      ));

    when 'list_teams' then
      v_ws := (p_arg->>'workspace_id')::uuid;
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
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
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
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
            and (coalesce(p_arg->>'filter', 'all') <> 'unread' or n.seen_at is null)
            and (coalesce(p_arg->>'filter', 'all') <> 'read' or n.seen_at is not null)
            and (v_cur_key is null or (n.created_at, n.id) <= (v_cur_key::timestamptz, v_cur_id))
          order by n.created_at desc, n.id desc
          offset v_limit limit 1
        )
      ));

    when 'mark_notification_read' then
      update public.notifications set seen_at = now()
      where id = (p_arg->>'notification_id')::uuid and user_id = p_user_id;
      if not found then raise exception 'notification not found'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'mark_notification_unread' then
      update public.notifications set seen_at = null
      where id = (p_arg->>'notification_id')::uuid and user_id = p_user_id;
      if not found then raise exception 'notification not found'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'mark_all_notifications_read' then
      update public.notifications set seen_at = now()
      where user_id = p_user_id and seen_at is null;
      get diagnostics v_count = row_count;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('marked', v_count));

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

    when 'update_board' then
      v_board_id := (p_arg->>'board_id')::uuid;
      if p_arg ? 'name' then
        update public.boards set name = left(p_arg->>'name', 80) where id = v_board_id;
        if not found then raise exception 'board not found or no access'; end if;
        insert into public.activity (board_id, user_id, type, payload)
        values (v_board_id, p_user_id, 'board.renamed', jsonb_build_object('name', p_arg->>'name'));
      end if;
      if p_arg ? 'description' then
        update public.boards set description = left(p_arg->>'description', 4000) where id = v_board_id;
        if not found then raise exception 'board not found or no access'; end if;
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
        if not found then raise exception 'board not found or no access'; end if;
      end if;
      return jsonb_build_object('ok', true, 'data', null);

    -- ── lists ───────────────────────────────────────────────────────────
    when 'create_list' then
      v_board_id := (p_arg->>'board_id')::uuid;
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

    when 'update_list' then
      v_list_id := (p_arg->>'list_id')::uuid;
      if p_arg ? 'name' then
        update public.lists set name = left(p_arg->>'name', 80) where id = v_list_id;
        if not found then raise exception 'list not found or no access'; end if;
      end if;
      if p_arg ? 'description' then
        update public.lists set description = left(p_arg->>'description', 2000) where id = v_list_id;
        if not found then raise exception 'list not found or no access'; end if;
      end if;
      return jsonb_build_object('ok', true, 'data', null);

    -- ── cards ───────────────────────────────────────────────────────────
    when 'create_card' then
      v_list_id := (p_arg->>'list_id')::uuid;
      select l.board_id into v_board_id from public.lists l where l.id = v_list_id;
      if v_board_id is null then raise exception 'list not found or no access'; end if;
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
              jsonb_build_object('title', p_arg->>'title',
                                 'list', (select l.name from public.lists l where l.id = v_list_id)));
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('card_id', v_new_id));

    when 'update_card' then
      v_card_id := (p_arg->>'card_id')::uuid;
      -- Capture the BEFORE state: timeline diffs read "from -> to"
      -- (same events the web app logs).
      select c.board_id, c.title, coalesce(c.priority, '') into v_board_id, v_title, v_prio
      from public.cards c where c.id = v_card_id;
      if v_board_id is null then raise exception 'card not found or no access'; end if;
      if p_arg ? 'title' then
        update public.cards set title = left(p_arg->>'title', 200) where id = v_card_id;
        if not found then raise exception 'card not found or no access'; end if;
        if left(p_arg->>'title', 200) is distinct from v_title then
          insert into public.card_events (card_id, board_id, actor_id, kind, detail)
          values (v_card_id, v_board_id, p_user_id, 'renamed',
                  jsonb_build_object('from', v_title, 'to', left(p_arg->>'title', 200)));
        end if;
      end if;
      if p_arg ? 'description' then
        update public.cards set description = left(p_arg->>'description', 8000) where id = v_card_id;
        if not found then raise exception 'card not found or no access'; end if;
        insert into public.card_events (card_id, board_id, actor_id, kind, detail)
        values (v_card_id, v_board_id, p_user_id, 'description', '{}'::jsonb);
      end if;
      if p_arg ? 'priority' then
        if nullif(p_arg->>'priority', '') is not null
           and p_arg->>'priority' not in ('low', 'medium', 'high', 'urgent') then
          raise exception 'priority must be one of low, medium, high, urgent (or empty)';
        end if;
        update public.cards set priority = nullif(p_arg->>'priority', '') where id = v_card_id;
        if not found then raise exception 'card not found or no access'; end if;
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
        delete from public.card_tags where card_id = v_card_id;
        insert into public.card_tags (card_id, tag_id)
        select v_card_id, x::uuid
        from jsonb_array_elements_text(p_arg->'tag_ids') as x
        where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
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
        -- Timeline: who got assigned / unassigned (display names), like the app.
        insert into public.card_events (card_id, board_id, actor_id, kind, detail)
        values (v_card_id, v_board_id, p_user_id, 'assignees', jsonb_build_object(
          'added', coalesce((
            select jsonb_agg(pr.display_name) from public.card_assignees a
            join public.profiles pr on pr.id = a.user_id
            where a.card_id = v_card_id and not (a.user_id = any (v_prev))
          ), '[]'::jsonb),
          'removed', coalesce((
            select jsonb_agg(pr.display_name) from public.profiles pr
            where pr.id = any (v_prev)
              and not exists (
                select 1 from public.card_assignees a
                where a.card_id = v_card_id and a.user_id = pr.id
              )
          ), '[]'::jsonb)
        ));
      end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'move_card' then
      v_card_id := (p_arg->>'card_id')::uuid;
      select c.board_id, c.list_id, (select l.name from public.lists l where l.id = c.list_id)
      into v_board_id, v_list_id, v_title
      from public.cards c where c.id = v_card_id;
      if v_board_id is null then raise exception 'card not found or no access'; end if;
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
      if not found then raise exception 'card not found or no access'; end if;
      -- Timeline: only when the card actually changed lists (same noise
      -- filter as the app).
      if v_list_id is distinct from (p_arg->>'list_id')::uuid then
        insert into public.card_events (card_id, board_id, actor_id, kind, detail)
        values (v_card_id, v_board_id, p_user_id, 'moved', jsonb_build_object(
          'from', v_title,
          'to', (select l.name from public.lists l where l.id = (p_arg->>'list_id')::uuid)
        ));
      end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'delete_card' then
      v_card_id := (p_arg->>'card_id')::uuid;
      delete from public.cards where id = v_card_id;
      if not found then raise exception 'card not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    -- ── comments + board chat ────────────────────────────────────────────
    when 'add_comment' then
      v_card_id := (p_arg->>'card_id')::uuid;
      insert into public.card_comments (card_id, user_id, body, seq)
      values (v_card_id, p_user_id, left(p_arg->>'body', 2000),
              public.allocate_chat_seq('card_comment', v_card_id))
      returning id into v_new_id;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('comment_id', v_new_id));

    when 'edit_comment' then
      -- Own comments always; any comment for workspace owners/admins (RLS).
      update public.card_comments
      set body = left(p_arg->>'body', 2000), edited_at = now()
      where id = (p_arg->>'comment_id')::uuid and deleted_at is null;
      if not found then raise exception 'comment not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'delete_comment' then
      update public.card_comments
      set deleted_at = now()
      where id = (p_arg->>'comment_id')::uuid and deleted_at is null;
      if not found then raise exception 'comment not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'post_board_message' then
      v_board_id := (p_arg->>'board_id')::uuid;
      insert into public.board_messages (board_id, user_id, body, seq)
      values (v_board_id, p_user_id, left(p_arg->>'body', 4000),
              public.allocate_chat_seq('board_message', v_board_id))
      returning id into v_new_id;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('message_id', v_new_id));

    when 'edit_board_message' then
      -- Own messages always; any message for workspace owners/admins (RLS).
      update public.board_messages
      set body = left(p_arg->>'body', 4000), edited_at = now()
      where id = (p_arg->>'message_id')::uuid and deleted_at is null;
      if not found then raise exception 'message not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'delete_board_message' then
      -- Soft delete: the row stays for history, every read hides it.
      update public.board_messages
      set deleted_at = now()
      where id = (p_arg->>'message_id')::uuid and deleted_at is null;
      if not found then raise exception 'message not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    -- ── workspaces + invites ────────────────────────────────────────────
    when 'create_workspace' then
      insert into public.workspaces (name, slug, owner_id)
      values (left(coalesce(p_arg->>'name', 'Untitled'), 80),
              'ws-' || left(p_user_id::text, 8) || '-' || floor(extract(epoch from now()))::int::text,
              p_user_id)
      returning id into v_new_id;
      insert into public.workspace_members (workspace_id, user_id, role)
      values (v_new_id, p_user_id, 'owner');
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('workspace_id', v_new_id));

    when 'invite_member' then
      v_ws := (p_arg->>'workspace_id')::uuid;
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
      return jsonb_build_object('ok', true, 'data', null);

    when 'add_team_member' then
      insert into public.team_members (team_id, user_id, role)
      values ((p_arg->>'team_id')::uuid, (p_arg->>'user_id')::uuid,
              case when p_arg->>'role' = 'admin' then 'admin' else 'member' end)
      on conflict (team_id, user_id) do update set role = excluded.role;
      return jsonb_build_object('ok', true, 'data', null);

    when 'remove_team_member' then
      delete from public.team_members
      where team_id = (p_arg->>'team_id')::uuid and user_id = (p_arg->>'user_id')::uuid;
      if not found then raise exception 'member not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    -- ── tags ─────────────────────────────────────────────────────────────
    when 'list_tags' then
      v_ws := (p_arg->>'workspace_id')::uuid;
      v_cur := nullif(p_arg->>'cursor', '');
      v_cur_id := public.mcp_cursor_id(v_cur);
      if v_cur is not null and v_cur_id is null then
        raise exception 'malformed cursor';
      end if;
      v_cur_key := public.mcp_cursor_key(v_cur);
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
      insert into public.tags (workspace_id, name, description)
      values (v_ws, lower(left(btrim(p_arg->>'name'), 24)), left(coalesce(p_arg->>'description', ''), 500))
      on conflict (workspace_id, name) do nothing
      returning id into v_new_id;
      if v_new_id is null then
        select t.id into v_new_id from public.tags t
        where t.workspace_id = v_ws and t.name = lower(left(btrim(p_arg->>'name'), 24));
      end if;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('tag_id', v_new_id));

    when 'rename_tag' then
      -- Owners/admins only (tags_update_admin policy).
      if nullif(p_arg->>'name', '') is null then raise exception 'tag name cannot be empty'; end if;
      update public.tags set name = lower(left(btrim(p_arg->>'name'), 24))
      where id = (p_arg->>'tag_id')::uuid;
      if not found then raise exception 'tag not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'delete_tag' then
      -- Owners/admins only (tags_delete_admin policy); linked cards lose it.
      delete from public.tags where id = (p_arg->>'tag_id')::uuid;
      if not found then raise exception 'tag not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'merge_tags' then
      -- Owners/admins: links move to the target (duplicates skipped),
      -- the source tag disappears.
      if (p_arg->>'source_tag_id')::uuid = (p_arg->>'target_tag_id')::uuid then
        raise exception 'source and target are the same tag';
      end if;
      insert into public.card_tags (card_id, tag_id)
      select ct.card_id, (p_arg->>'target_tag_id')::uuid
      from public.card_tags ct
      where ct.tag_id = (p_arg->>'source_tag_id')::uuid
        and not exists (
          select 1 from public.card_tags t2
          where t2.card_id = ct.card_id and t2.tag_id = (p_arg->>'target_tag_id')::uuid
        );
      delete from public.tags where id = (p_arg->>'source_tag_id')::uuid;
      if not found then raise exception 'tag not found or no access'; end if;
      return jsonb_build_object('ok', true, 'data', null);

    -- ── status ───────────────────────────────────────────────────────────
    when 'set_status' then
      insert into public.user_status (user_id, emoji, label, dnd, updated_at)
      values (p_user_id, nullif(p_arg->>'emoji', ''),
              left(coalesce(p_arg->>'label', ''), 60),
              coalesce((p_arg->>'dnd')::boolean, false), now())
      on conflict (user_id) do update
        set emoji = excluded.emoji,
            label = excluded.label,
            dnd = excluded.dnd,
            updated_at = now();
      return jsonb_build_object('ok', true, 'data', null);

    else
      raise exception 'unknown op: %', p_op;
  end case;
end;
$$;

revoke execute on function public.mcp_exec(uuid, text, jsonb) from anon, authenticated;
grant execute on function public.mcp_exec(uuid, text, jsonb) to service_role;

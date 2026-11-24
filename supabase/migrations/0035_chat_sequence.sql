-- 0035: monotonic sequence for board messages and card comments.
--
-- Verified during MCP batch testing: 14 board messages posted in one burst
-- landed with interleaved created_at (all within ~500ms), so the order
-- they were sent ≠ the order stored. Sub-second timestamp collisions
-- reorder conversations nondeterministically. Agents firing parallel
-- calls make this a daily pattern, not a theory.
--
-- Fix: a per-scope monotonic seq column on both chat tables, allocated
-- through a shared counter (chat_seq) whose UPDATE row-lock serializes
-- concurrent posters — the same pattern as 0034's position allocators,
-- so seq order == commit order == send order for bursts. All reads
-- (MCP and web app) order by seq; the seq is exposed in every response.

-- The counter: one row per (kind, scope) — scope is board_id for
-- board_message rows, card_id for card_comment rows.
create table public.chat_seq (
  kind  text not null check (kind in ('board_message', 'card_comment')),
  scope uuid not null,
  last  bigint not null default 0,
  primary key (kind, scope)
);

-- Atomic send sequence for a chat scope. SECURITY DEFINER so the app's
-- server functions (running as authenticated) can use it; it only bumps
-- a monotonic number, no data is exposed. anon is revoked.
create or replace function public.allocate_chat_seq(p_kind text, p_scope uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq bigint;
begin
  insert into public.chat_seq (kind, scope, last) values (p_kind, p_scope, 0)
    on conflict (kind, scope) do nothing;

  update public.chat_seq s
     set last = s.last + 1
   where s.kind = p_kind and s.scope = p_scope
  returning last into v_seq;

  return v_seq;
end;
$$;

revoke execute on function public.allocate_chat_seq(text, uuid) from anon;
grant execute on function public.allocate_chat_seq(text, uuid) to authenticated;
grant execute on function public.allocate_chat_seq(text, uuid) to service_role;

-- The seq column on both chat tables.
alter table public.board_messages add column seq bigint;
alter table public.card_comments  add column seq bigint;

-- Backfill: existing rows get seq in their current read order
-- (created_at, id), so history keeps the order users already saw.
with ranked as (
  select id, row_number() over (partition by board_id order by created_at, id) as rn
  from public.board_messages
)
update public.board_messages m set seq = r.rn from ranked r where r.id = m.id;

with ranked as (
  select id, row_number() over (partition by card_id order by created_at, id) as rn
  from public.card_comments
)
update public.card_comments c set seq = r.rn from ranked r where r.id = c.id;

alter table public.board_messages alter column seq set not null;
alter table public.card_comments  alter column seq set not null;

-- Seed the counters so new posts never collide with backfilled history.
insert into public.chat_seq (kind, scope, last)
select 'board_message', board_id, coalesce(max(seq), 0)
from public.board_messages group by board_id
on conflict (kind, scope) do nothing;
insert into public.chat_seq (kind, scope, last)
select 'card_comment', card_id, coalesce(max(seq), 0)
from public.card_comments group by card_id
on conflict (kind, scope) do nothing;

create index board_messages_board_seq_idx on public.board_messages (board_id, seq);
create index card_comments_card_seq_idx  on public.card_comments (card_id, seq);

-- mcp_exec: chat writes allocate seq; chat reads order by it and expose
-- it. Cursor format for chat is now "<seq>|<id>".
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
            select jsonb_agg(to_jsonb(c) order by c.position)
            from public.cards c where c.board_id = v_board_id
          ), '[]'::jsonb),
          'messages', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', m.id, 'user_id', m.user_id, 'body', m.body, 'seq', m.seq,
              'created_at', m.created_at
            ) order by m.seq)
            from public.board_messages m where m.board_id = v_board_id
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
          select jsonb_agg(to_jsonb(p) order by p.position, p.id)
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
            'id', p.id, 'user_id', p.user_id, 'body', p.body, 'seq', p.seq, 'created_at', p.created_at
          ) order by p.seq, p.id)
          from (
            select m.id, m.user_id, m.body, m.seq, m.created_at
            from public.board_messages m
            where m.board_id = v_board_id
              and (v_cur_key is null or (m.seq, m.id) >= (v_cur_key::bigint, v_cur_id))
            order by m.seq asc, m.id asc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          select m.seq::text || '|' || m.id::text
          from public.board_messages m
          where m.board_id = v_board_id
            and (v_cur_key is null or (m.seq, m.id) >= (v_cur_key::bigint, v_cur_id))
          order by m.seq asc, m.id asc
          offset v_limit limit 1
        )
      ));

    when 'list_comments' then
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
            'id', p.id, 'body', p.body, 'user_id', p.user_id, 'seq', p.seq, 'created_at', p.created_at
          ) order by p.seq, p.id)
          from (
            select cm.id, cm.body, cm.user_id, cm.seq, cm.created_at
            from public.card_comments cm
            where cm.card_id = v_card_id
              and (v_cur_key is null or (cm.seq, cm.id) >= (v_cur_key::bigint, v_cur_id))
            order by cm.seq asc, cm.id asc
            limit v_limit
          ) p
        ), '[]'::jsonb),
        'next_cursor', (
          select cm.seq::text || '|' || cm.id::text
          from public.card_comments cm
          where cm.card_id = v_card_id
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
              select jsonb_agg(jsonb_build_object('user_id', tm.user_id, 'role', tm.role) order by tm.user_id)
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
      return jsonb_build_object('ok', true, 'data', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', n.id, 'kind', n.kind, 'body', n.body, 'board_id', n.board_id,
          'card_id', n.card_id, 'actor_id', n.actor_id, 'subject_id', n.subject_id,
          'seen', n.seen_at is not null, 'created_at', n.created_at
        ) order by n.created_at desc)
        from (
          select * from public.notifications
          where user_id = p_user_id
          order by created_at desc
          limit 50
        ) n
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

    -- ── cards ───────────────────────────────────────────────────────────
    when 'create_card' then
      v_list_id := (p_arg->>'list_id')::uuid;
      select l.board_id into v_board_id from public.lists l where l.id = v_list_id;
      if v_board_id is null then raise exception 'list not found or no access'; end if;
      -- Atomic append: concurrent creators serialize on the list_seq row,
      -- so parallel calls can never land on the same position.
      v_pos := public.allocate_card_position(v_list_id);
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
      if p_arg ? 'priority' then
        update public.cards set priority = nullif(p_arg->>'priority', '') where id = v_card_id;
        if not found then raise exception 'card not found or no access'; end if;
      end if;
      return jsonb_build_object('ok', true, 'data', null);

    when 'move_card' then
      v_card_id := (p_arg->>'card_id')::uuid;
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

    when 'post_board_message' then
      v_board_id := (p_arg->>'board_id')::uuid;
      insert into public.board_messages (board_id, user_id, body, seq)
      values (v_board_id, p_user_id, left(p_arg->>'body', 4000),
              public.allocate_chat_seq('board_message', v_board_id))
      returning id into v_new_id;
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('message_id', v_new_id));

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

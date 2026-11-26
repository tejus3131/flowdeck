-- 0077: the tag capsule reads the log — mention events at write time
-- (ADR-4, phase 3, task 4).
--
-- tag_event_rows (0072) scanned message/comment/description BODIES at
-- read time — unindexable position() scans, re-run per page per visitor.
-- Mentions are now EVENTS: a trigger on board_messages / card_comments /
-- card descriptions extracts the cited tag chips at write time and logs
-- them through log_event, with display snapshots (snippet, author,
-- card title — the 0058 lesson: history renders even after the source
-- row changes or goes). The capsule becomes one indexed read:
--   where tag_ids && ARRAY[p_tag_id] — the gin index carries it.
--
-- Semantics changes, deliberate:
--   * mention rows PERSIST after the source is tombstoned — a time
--     capsule records what happened; deleted sources keep their mention
--     with the write-time snapshot (the 0072 scan silently dropped them)
--   * a description mention logs when the tag ENTERS the description
--     (old-description deltas re-log on re-add after removal) — the
--     scan showed only the current state, one row per source
--   * the text query searches the write-time snippet (160 chars) and
--     titles — the log cannot full-text bodies
--
-- Mention events deliberately carry card_id = null for comments and
-- descriptions: they are capsule facts, not card-trail facts — the
-- drawer's timeline keeps its curated kinds. (RLS is board-scoped, so
-- null card_id reads fine.)

-- ── the mention writer ───────────────────────────────────────────────────
-- One function, three surfaces (chat bodies, comment bodies, card
-- descriptions). SECURITY INVOKER: the events insert policy is the gate;
-- every legitimate writer (web member, MCP agent) can act on the board.
create or replace function public.log_tag_mentions_from_body()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tags uuid[];
  v_where text;
  v_source uuid;
  v_card uuid;
  v_card_title text;
  v_board uuid;
  v_snippet text;
  v_actor uuid;
  v_detail jsonb;
begin
  if tg_table_name = 'board_messages' then
    v_where := 'chat';
    v_source := new.id;
    v_board := new.board_id;
    v_actor := new.user_id;
    v_snippet := left(regexp_replace(regexp_replace(
                   new.body, '\[[^\]\n]*\]\([a-z]+:[0-9a-f-]+\)', '…', 'g'),
                   '\s+', ' ', 'g'), 160);
    v_tags := coalesce(array(
      select distinct (m[1])::uuid
      from regexp_matches(new.body, '\(tag:([0-9a-f-]{36})\)', 'g') m
    ), '{}'::uuid[]);
  elsif tg_table_name = 'card_comments' then
    v_where := 'comment';
    v_source := new.id;
    v_card := new.card_id;
    v_card_title := (select title from public.cards where id = new.card_id);
    v_board := (select board_id from public.cards where id = new.card_id);
    v_actor := new.user_id;
    v_snippet := left(regexp_replace(regexp_replace(
                   new.body, '\[[^\]\n]*\]\([a-z]+:[0-9a-f-]+\)', '…', 'g'),
                   '\s+', ' ', 'g'), 160);
    v_tags := coalesce(array(
      select distinct (m[1])::uuid
      from regexp_matches(new.body, '\(tag:([0-9a-f-]{36})\)', 'g') m
    ), '{}'::uuid[]);
  else -- cards: the description — log only tags NEW to it
    v_where := 'description';
    v_card := new.id;
    v_card_title := new.title;
    v_board := new.board_id;
    v_actor := auth.uid();
    v_snippet := left(regexp_replace(regexp_replace(
                   new.description, '\[[^\]\n]*\]\([a-z]+:[0-9a-f-]+\)', '…', 'g'),
                   '\s+', ' ', 'g'), 160);
    declare
      v_old uuid[] := case when tg_op = 'UPDATE' then coalesce(array(
        select distinct (m[1])::uuid
        from regexp_matches(coalesce(old.description, ''), '\(tag:([0-9a-f-]{36})\)', 'g') m
      ), '{}'::uuid[]) else '{}'::uuid[] end;
    begin
      v_tags := coalesce(array(
        select distinct (m[1])::uuid
        from regexp_matches(coalesce(new.description, ''), '\(tag:([0-9a-f-]{36})\)', 'g') m
      ), '{}'::uuid[]);
      v_tags := array(select unnest(v_tags) except select unnest(v_old));
    end;
  end if;

  if v_tags is null or array_length(v_tags, 1) is null then
    return coalesce(new, old);
  end if;

  -- The chips ride the detail {id, name} — log_event derives tag_ids
  -- from them, and history renders the tag's name as it was cited.
  v_detail := jsonb_build_object(
    'where', v_where,
    'source_id', v_source,
    'snippet', v_snippet,
    'tags', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name) order by x.id)
      from (
        -- The CITED id survives even when the tag row cannot resolve:
        -- ids come from the citation, names from the lookup.
        select tid as id, t.name
        from unnest(v_tags) as tid
        left join public.tags t on t.id = tid
      ) x
    ), '[]'::jsonb)
  ) || case
    when v_card is not null then jsonb_build_object(
      'card_id', v_card,
      'card_title', coalesce(v_card_title, 'a card'))
    else '{}'::jsonb
  end;

  begin
    perform public.log_event(
      v_actor, 'tag-mention', v_where, coalesce(v_source, v_card), v_board, null,
      v_detail
    );
  exception when others then
    -- Best-effort like every event write: a mention must never fail the
    -- mutation it rides on.
    raise warning 'tag mention log failed: %', sqlerrm;
  end;

  return coalesce(new, old);
end;
$$;

create trigger board_messages_tag_mentions
  after insert on public.board_messages
  for each row execute function public.log_tag_mentions_from_body();
create trigger card_comments_tag_mentions
  after insert on public.card_comments
  for each row execute function public.log_tag_mentions_from_body();
create trigger cards_tag_mentions
  after insert or update of description on public.cards
  for each row execute function public.log_tag_mentions_from_body();

-- ── the capsule: one indexed read over the log ─────────────────────────
create or replace function public.tag_event_rows(
  p_tag_id uuid,
  p_query text default '',
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit int default 30,
  p_offset int default 0
)
returns jsonb
language sql
security invoker
set search_path = public
stable
as $$
  select coalesce(jsonb_agg(payload order by created_at desc), '[]'::jsonb)
  from (
    -- Mentions (chat, comment, description) — one event row each, the
    -- display snapshots written at mention time.
    select jsonb_build_object(
             'kind', e.detail->>'where',
             'board_id', e.board_id,
             'board_name', b.name,
             'message_id', case when e.detail->>'where' = 'chat'
                          then e.entity_id::text end,
             'card_id', (e.detail->>'card_id'),
             'card_title', coalesce(e.detail->>'card_title', 'a card'),
             'comment_id', case when e.detail->>'where' = 'comment'
                           then e.entity_id::text end,
             'author', coalesce(p.display_name, 'Someone'),
             'avatar_url', p.avatar_url,
             'snippet', coalesce(e.detail->>'snippet', ''),
             'created_at', e.created_at
           ) as payload,
           e.created_at as created_at
    from public.events e
    join public.boards b on b.id = e.board_id
    left join public.profiles p on p.id = e.actor_id
    where e.kind = 'tag-mention'
      and e.tag_ids && ARRAY[p_tag_id]
      and (coalesce(p_query, '') = '' or e.detail->>'snippet' ilike '%' || p_query || '%')
      and (p_from is null or e.created_at >= p_from)
      and (p_to is null or e.created_at <= p_to)

    union all
    -- Tagged / untagged: the 'tags' events' added and removed arms,
    -- expanded per chip. Left join: a deleted card's history keeps its
    -- capsule row with its write-time title (the 0058 lesson).
    select jsonb_build_object(
             'kind', case when arms.side = 'added' then 'tagged' else 'untagged' end,
             'board_id', e.board_id,
             'board_name', b.name,
             'card_id', e.card_id,
             'card_title', coalesce(c.title, e.detail->>'card_title', 'a card'),
             'author', coalesce(p.display_name, 'Someone'),
             'avatar_url', p.avatar_url,
             'snippet', coalesce(c.title, e.detail->>'card_title', 'a card'),
             'created_at', e.created_at
           ) as payload,
           e.created_at as created_at
    from public.events e
    join public.boards b on b.id = e.board_id
    left join public.cards c on c.id = e.card_id
    left join public.profiles p on p.id = e.actor_id
    cross join lateral (
      select 'added' as side
      where exists (
        select 1 from jsonb_array_elements(coalesce(e.detail->'added', '[]'::jsonb)) el
        where el->>'id' = p_tag_id::text
      )
      union all
      select 'removed'
      where exists (
        select 1 from jsonb_array_elements(coalesce(e.detail->'removed', '[]'::jsonb)) el
        where el->>'id' = p_tag_id::text
      )
    ) arms
    where e.kind = 'tags'
      and (coalesce(p_query, '') = '' or coalesce(c.title, '') ilike '%' || p_query || '%')
      and (p_from is null or e.created_at >= p_from)
      and (p_to is null or e.created_at <= p_to)

    order by created_at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0)
  ) rows;
$$;

revoke execute on function public.tag_event_rows(uuid, text, timestamptz, timestamptz, int, int) from anon;

-- ── history: the mentions that already exist become events ───────────────
-- One-time (this migration runs once); id-ordered by created_at so the
-- folded rows keep the cursor's monotonic sequence. Description mentions
-- take their authorship from the log's own description-edit trail.
insert into public.events (
  actor_id, kind, entity_type, entity_id, workspace_id,
  board_id, card_id, tag_ids, detail, created_at
)
select
  r.actor_id, 'tag-mention', r.surface, r.entity_id, r.workspace_id,
  r.board_id, null, r.tag_ids,
  jsonb_build_object(
    'where', r.surface,
    'source_id', r.entity_id,
    'snippet', r.snippet
  ) || case when r.card_id is not null then jsonb_build_object(
    'card_id', r.card_id,
    'card_title', coalesce(r.card_title, 'a card'))
  else '{}'::jsonb end,
  r.created_at
from (
  select 'chat' as surface, m.id as entity_id, m.user_id as actor_id,
         b.workspace_id, m.board_id, null::uuid as card_id,
         null::text as card_title,
         coalesce(array(select distinct (x[1])::uuid
           from regexp_matches(m.body, '\(tag:([0-9a-f-]{36})\)', 'g') x), '{}'::uuid[]) as tag_ids,
         left(regexp_replace(regexp_replace(
           m.body, '\[[^\]\n]*\]\([a-z]+:[0-9a-f-]+\)', '…', 'g'),
           '\s+', ' ', 'g'), 160) as snippet,
         m.created_at
  from public.board_messages m
  join public.boards b on b.id = m.board_id
  where position('(tag:' in m.body) > 0
    and m.deleted_at is null

  union all
  select 'comment', cm.id, cm.user_id, b.workspace_id, b.id, c.id,
         c.title,
         coalesce(array(select distinct (x[1])::uuid
           from regexp_matches(cm.body, '\(tag:([0-9a-f-]{36})\)', 'g') x), '{}'::uuid[]),
         left(regexp_replace(regexp_replace(
           cm.body, '\[[^\]\n]*\]\([a-z]+:[0-9a-f-]+\)', '…', 'g'),
           '\s+', ' ', 'g'), 160),
         cm.created_at
  from public.card_comments cm
  join public.cards c on c.id = cm.card_id
  join public.boards b on b.id = c.board_id
  where position('(tag:' in cm.body) > 0
    and cm.deleted_at is null

  union all
  select 'description', c.id, coalesce(de.actor_id, c.created_by),
         b.workspace_id, c.board_id, c.id, c.title,
         coalesce(array(select distinct (x[1])::uuid
           from regexp_matches(coalesce(c.description, ''), '\(tag:([0-9a-f-]{36})\)', 'g') x), '{}'::uuid[]),
         left(regexp_replace(regexp_replace(
           c.description, '\[[^\]\n]*\]\([a-z]+:[0-9a-f-]+\)', '…', 'g'),
           '\s+', ' ', 'g'), 160),
         coalesce(de.created_at, c.updated_at)
  from public.cards c
  join public.boards b on b.id = c.board_id
  left join lateral (
    select e.actor_id, e.created_at
    from public.events e
    where e.card_id = c.id and e.kind = 'description'
    order by e.id desc
    limit 1
  ) de on true
  where position('(tag:' in coalesce(c.description, '')) > 0
) r
where array_length(r.tag_ids, 1) is not null
order by r.created_at;

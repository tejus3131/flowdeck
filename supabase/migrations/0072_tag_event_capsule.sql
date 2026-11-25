-- 0072: the per-tag page becomes the tag's time capsule.
--
-- A tag's page is everything that happened to the tag, newest first:
-- cited in board chat, in a card comment, in a card description; added
-- to a card; removed from a card. The tagged-cards LIST moves to the
-- search page (its natural home — ?tag=<name> already filters there);
-- the page links out instead of duplicating it.
--
-- tag_event_rows supersedes tag_mention_rows (0064): the same three
-- mention arms plus two event arms over card_events' tag trail, and
-- GROWS filters — a text query through the entries and a time window.
-- SECURITY INVOKER as before: RLS filters to boards the reader can see.

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
    -- Board chat messages citing the tag.
    select jsonb_build_object(
             'kind', 'chat',
             'board_id', b.id,
             'board_name', b.name,
             'message_id', m.id,
             'author', coalesce(p.display_name, 'Someone'),
             'avatar_url', p.avatar_url,
             'snippet', left(regexp_replace(regexp_replace(
                          m.body, '\[[^\]\n]*\]\([a-z]+:[0-9a-f-]+\)', '…', 'g'),
                          '\s+', ' ', 'g'), 160),
             'created_at', m.created_at
           ) as payload,
           m.created_at as created_at
    from public.board_messages m
    join public.boards b on b.id = m.board_id
    left join public.profiles p on p.id = m.user_id
    where m.deleted_at is null
      and position('(tag:' || p_tag_id::text || ')' in m.body) > 0
      and (coalesce(p_query, '') = '' or m.body ilike '%' || p_query || '%')
      and (p_from is null or m.created_at >= p_from)
      and (p_to is null or m.created_at <= p_to)

    union all
    -- Card comments citing the tag.
    select jsonb_build_object(
             'kind', 'comment',
             'board_id', c.board_id,
             'board_name', b.name,
             'card_id', c.id,
             'card_title', c.title,
             'comment_id', cm.id,
             'author', coalesce(p.display_name, 'Someone'),
             'avatar_url', p.avatar_url,
             'snippet', left(regexp_replace(regexp_replace(
                          cm.body, '\[[^\]\n]*\]\([a-z]+:[0-9a-f-]+\)', '…', 'g'),
                          '\s+', ' ', 'g'), 160),
             'created_at', cm.created_at
           ) as payload,
           cm.created_at as created_at
    from public.card_comments cm
    join public.cards c on c.id = cm.card_id
    join public.boards b on b.id = c.board_id
    left join public.profiles p on p.id = cm.user_id
    where cm.deleted_at is null
      and position('(tag:' || p_tag_id::text || ')' in cm.body) > 0
      and (coalesce(p_query, '') = '' or cm.body ilike '%' || p_query || '%')
      and (p_from is null or cm.created_at >= p_from)
      and (p_to is null or cm.created_at <= p_to)

    union all
    -- Card descriptions citing the tag. Authorship: the LAST description
    -- edit's actor when the trail has one (0063 snapshots onward), else
    -- the card's creator — updated_at is the card's, not the mention's.
    select jsonb_build_object(
             'kind', 'description',
             'board_id', c.board_id,
             'board_name', b.name,
             'card_id', c.id,
             'card_title', c.title,
             'author', coalesce(p.display_name, 'Someone'),
             'avatar_url', p.avatar_url,
             'snippet', left(regexp_replace(regexp_replace(
                          c.description, '\[[^\]\n]*\]\([a-z]+:[0-9a-f-]+\)', '…', 'g'),
                          '\s+', ' ', 'g'), 160),
             'created_at', coalesce(de.created_at, c.updated_at)
           ) as payload,
           coalesce(de.created_at, c.updated_at) as created_at
    from public.cards c
    join public.boards b on b.id = c.board_id
    left join lateral (
      select e.actor_id, e.created_at
      from public.card_events e
      where e.card_id = c.id and e.kind = 'description'
      order by e.created_at desc
      limit 1
    ) de on true
    left join public.profiles p on p.id = coalesce(de.actor_id, c.created_by)
    where position('(tag:' || p_tag_id::text || ')' in c.description) > 0
      and (coalesce(p_query, '') = '' or c.description ilike '%' || p_query || '%')
      and (p_from is null or coalesce(de.created_at, c.updated_at) >= p_from)
      and (p_to is null or coalesce(de.created_at, c.updated_at) <= p_to)

    union all
    -- The tag ADDED to a card (the card trail's tag events, this tag's).
    select jsonb_build_object(
             'kind', 'tagged',
             'board_id', e.board_id,
             'board_name', b.name,
             'card_id', e.card_id,
             'card_title', c.title,
             'author', coalesce(p.display_name, 'Someone'),
             'avatar_url', p.avatar_url,
             'snippet', c.title,
             'created_at', e.created_at
           ) as payload,
           e.created_at as created_at
    from public.card_events e
    join public.cards c on c.id = e.card_id
    join public.boards b on b.id = e.board_id
    left join public.profiles p on p.id = e.actor_id
    where e.kind = 'tags'
      and exists (
        select 1 from jsonb_array_elements(coalesce(e.detail->'added', '[]'::jsonb)) el
        where el->>'id' = p_tag_id::text
      )
      and (coalesce(p_query, '') = '' or c.title ilike '%' || p_query || '%')
      and (p_from is null or e.created_at >= p_from)
      and (p_to is null or e.created_at <= p_to)

    union all
    -- The tag REMOVED from a card.
    select jsonb_build_object(
             'kind', 'untagged',
             'board_id', e.board_id,
             'board_name', b.name,
             'card_id', e.card_id,
             'card_title', c.title,
             'author', coalesce(p.display_name, 'Someone'),
             'avatar_url', p.avatar_url,
             'snippet', c.title,
             'created_at', e.created_at
           ) as payload,
           e.created_at as created_at
    from public.card_events e
    join public.cards c on c.id = e.card_id
    join public.boards b on b.id = e.board_id
    left join public.profiles p on p.id = e.actor_id
    where e.kind = 'tags'
      and exists (
        select 1 from jsonb_array_elements(coalesce(e.detail->'removed', '[]'::jsonb)) el
        where el->>'id' = p_tag_id::text
      )
      and (coalesce(p_query, '') = '' or c.title ilike '%' || p_query || '%')
      and (p_from is null or e.created_at >= p_from)
      and (p_to is null or e.created_at <= p_to)

    order by created_at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0)
  ) rows;
$$;

revoke execute on function public.tag_event_rows(uuid, text, timestamptz, timestamptz, int, int) from anon;

-- 0064's read function retires: the event feed supersedes it.
drop function if exists public.tag_mention_rows(uuid, int, int);

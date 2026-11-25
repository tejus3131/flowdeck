-- 0064: the tags hub's read side — every mention of a tag in one
-- paginated feed. A "mention" is anywhere the tag's chip link
-- (](tag:<uuid>)) appears in a chat message, a card comment, or a card
-- description — plus the tagged cards themselves, which the pages read
-- through card_tags.
--
-- SECURITY INVOKER on purpose: RLS filters the union to the boards the
-- calling reader can see, exactly like the per-board reads. Display is
-- ready-made (board/card names, author, flattened snippet) so the page
-- renders without a second round of lookups.

create or replace function public.tag_mention_rows(
  p_tag_id uuid,
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

    union all
    -- Card descriptions citing the tag.
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
             'created_at', c.updated_at
           ) as payload,
           c.updated_at as created_at
    from public.cards c
    join public.boards b on b.id = c.board_id
    left join public.profiles p on p.id = c.created_by
    where position('(tag:' || p_tag_id::text || ')' in c.description) > 0

    order by created_at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0)
  ) rows;
$$;

revoke execute on function public.tag_mention_rows(uuid, int, int) from anon;

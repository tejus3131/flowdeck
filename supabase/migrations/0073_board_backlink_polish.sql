-- 0073: board-mention backlinks — the three polish fixes.
--
-- The backlink message a cited board receives had three gaps, found in
-- hands-on testing after #39:
--
--   1. IT NEVER SAID WHO. The body read "mentioned this board in the
--      [#Board](board:…) chat" — the author only showed in the chat
--      header. The body now leads with [@Name](user:<actor>) — a real
--      mention chip, so renames follow the profile like every other
--      member chip. No notification fires for it: the app parses
--      mention links for delivery only on ITS send paths; the backlink
--      is inserted directly here, so nobody gets pinged (least of all
--      the actor mentioning themselves).
--
--   2. IT LEAKED THE CITING BOARD'S NAME. Any member of the cited board
--      could read the raw body — and the renderer had no private-board
--      gate (cards render "🔒 private card"; boards rendered the name
--      as written). New bodies carry the neutral label "a board"; the
--      chip renderer resolves the real name for viewers who can reach
--      it and shows a locked placeholder otherwise. The backfill
--      below scrubs the name out of existing rows (the fallback label
--      never displays when a context boards list is present).
--
--   3. IT COULDN'T ANCHOR. Card backlinks carry their source anchor in
--      card_events.detail; the board backlink stored nothing clickable
--      (client_op is a one-way hash). New bodies thread the anchor
--      through the link itself: board:<uuid>?m=<message-id> for chat,
--      card:<uuid>?c=<comment-id> for comments, card:<uuid>?e=description
--      for descriptions — the renderer lifts it onto the chip, and the
--      chip click navigates with ?chat / ?card&comment / ?card&event,
--      where the existing anchor machinery highlights the citation.
--      Old rows can't regain an anchor (the hash isn't reversible):
--      they keep navigating without highlight, same as today.
--
-- log_board_mentions is redefined wholesale on top of 0071's version.

create or replace function public.log_board_mentions(
  p_body text,
  p_where text,            -- 'chat' | 'comment' | 'description'
  p_board_id uuid,         -- the board where the mention happened
  p_card_id uuid default null,  -- the commented/host card (comments/descriptions)
  p_source_id uuid default null -- the message / comment / host card id
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_actor_name text;
  v_source_name text;
  v_card_title text;
  v_count integer := 0;
  v_target record;
  v_msg text;
  v_hash text;
  v_op uuid;
begin
  v_actor := auth.uid();
  if p_where not in ('chat', 'comment', 'description') then
    raise exception 'unknown mention source: %', p_where;
  end if;
  if v_actor is null or p_board_id is null then
    return 0;
  end if;
  if (p_where in ('comment', 'description') and p_card_id is null)
     or (p_where in ('chat', 'comment') and p_source_id is null) then
    return 0;
  end if;
  -- The anchor must be real and sit where the caller says it does.
  if p_where = 'chat' then
    if not exists (
      select 1 from public.board_messages m
      where m.id = p_source_id and m.board_id = p_board_id and m.deleted_at is null
    ) then
      return 0;
    end if;
  elsif p_where = 'comment' then
    if not exists (
      select 1 from public.card_comments cm
      where cm.id = p_source_id and cm.card_id = p_card_id and cm.deleted_at is null
    ) then
      return 0;
    end if;
  else
    if not exists (select 1 from public.cards c where c.id = p_card_id) then
      return 0;
    end if;
  end if;

  select name into v_source_name from public.boards where id = p_board_id;
  if p_card_id is not null then
    select title into v_card_title from public.cards where id = p_card_id;
  end if;
  -- The actor's display name (email prefix as the fallback) — the body
  -- names who mentioned the board, not just the chat header.
  select coalesce(nullif(p.display_name, ''), split_part(p.email, '@', 1))
    into v_actor_name
    from public.profiles p
   where p.id = v_actor;
  v_actor_name := coalesce(v_actor_name, 'someone');

  for v_target in
    select distinct b.id, b.name
    from regexp_matches(coalesce(p_body, ''),
                        '\]\(board:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)', 'g') as m
    join public.boards b on b.id = m[1]::uuid
    -- A board mentioned in its own chat is not news.
    where b.id is distinct from p_board_id
  loop
    -- Posting to a board's chat needs edit access there.
    if public.user_board_access(v_target.id) is distinct from 'edit' then
      continue;
    end if;

    -- The board label is neutral ("a board"): the renderer resolves the
    -- real name for viewers who can reach it — the name is NOT stored in
    -- the body, because every member of this board reads the raw text.
    -- The ?m/?c/?e suffixes thread the source anchor to the chip click.
    v_msg := case p_where
      when 'chat' then
        '[@' || v_actor_name || '](user:' || v_actor || ') mentioned this board in the [a board](board:' || p_board_id || '?m=' || p_source_id || ') chat'
      when 'comment' then
        '[@' || v_actor_name || '](user:' || v_actor || ') mentioned this board in a comment on [#' || coalesce(v_card_title, 'a card') || '](card:' || p_card_id || '?c=' || p_source_id || ')'
      else
        '[@' || v_actor_name || '](user:' || v_actor || ') mentioned this board in [#' || coalesce(v_card_title, 'a card') || '](card:' || p_card_id || '?e=description)'
    end;

    -- Deterministic client_op: one backlink message per (source, target)
    -- pair, however many retries or re-edits follow. ON CONFLICT is the
    -- atomic backstop on top of the exists check — concurrent callers
    -- can no longer double-post.
    v_hash := md5('board-mention:' || p_where || ':' || coalesce(p_source_id::text, '') || ':' || v_target.id::text);
    v_op := substr(v_hash, 1, 8) || '-' || substr(v_hash, 9, 4) || '-' ||
            substr(v_hash, 13, 4) || '-' || substr(v_hash, 17, 4) || '-' ||
            substr(v_hash, 21, 12);

    insert into public.board_messages (board_id, user_id, body, seq, client_op)
    values (v_target.id, v_actor, v_msg,
            public.allocate_chat_seq('board_message', v_target.id), v_op)
    on conflict (client_op) where client_op is not null do nothing;
    if found then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.log_board_mentions(text, text, uuid, uuid, uuid) from anon;

-- ── backfill: existing backlink rows ─────────────────────────────────────
-- (a) The actor's name, same as new rows get it. Idempotent: once
--     prepended, the body no longer starts with the matched phrase.
update public.board_messages m
   set body = '[@' || a.name || '](user:' || m.user_id || ') ' || m.body
  from (
    select id, coalesce(nullif(display_name, ''), split_part(email, '@', 1)) as name
    from public.profiles
  ) a
 where a.id = m.user_id
   and m.body like 'mentioned this board in %';

-- (b) Scrub the citing board's NAME out of chat-arm rows: the label
--     becomes the neutral "a board" (the chip resolves the real name for
--     viewers with access). Only rows that start with the system phrase
--     and carry a board chip are touched.
update public.board_messages
   set body = regexp_replace(
         body,
         '\[#[^\]\n]*\]\(board:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)',
         '[a board](board:\1)',
         'g')
 where body like '%mentioned this board in the [#%';

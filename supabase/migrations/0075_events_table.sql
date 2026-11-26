-- 0075: one events table (ADR-4 — the Jira changegroup pattern).
--
-- Three overlapping systems become one log: `card_events` (the card
-- timeline), `activity` (legacy since 0032 moved the revision cursor to
-- board_revisions), and the tag capsule's read-time position() scans.
-- This migration lays the table itself — additive; writers cut over in
-- 0076, readers after that, and the old tables retire at the end of the
-- phase. No existing row is read or modified except the backfill copy.
--
-- Shape (ADR-4): actor, entity type/id, kind, `detail` jsonb carrying
-- {id, name} snapshots at write time (the 0058 lesson — history must
-- render even when the entity is gone), scoped refs (workspace/board/
-- card), and `tag_ids` extracted at write time so the capsule becomes an
-- indexed cursor read instead of a jsonb crawl.
--
-- The bigint identity id is the cursor: timelines and the capsule page
-- with "since id", monotonic and tie-free (created_at alone cannot order
-- a burst). Backfill inserts in created_at order so copied rows keep a
-- monotonic id sequence.

create table public.events (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles (id) on delete set null,
  kind text not null,
  entity_type text not null,
  entity_id uuid not null,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  board_id uuid not null references public.boards (id) on delete cascade,
  card_id uuid references public.cards (id) on delete cascade,
  tag_ids uuid[] not null default '{}',
  detail jsonb not null default '{}',
  agent boolean not null default false,
  created_at timestamptz not null default now()
);

create index events_card_idx on public.events (card_id, id);
create index events_board_idx on public.events (board_id, id);
-- The capsule's read: every event referencing tag X, cursor-paginated.
create index events_tags_idx on public.events using gin (tag_ids);

alter table public.events enable row level security;

-- Readable exactly where the board is readable (the counters/card_tags
-- pattern; events never leave their board's scope).
create policy events_select on public.events
  for select using (public.user_board_access(board_id) is not null);

-- Writable by anyone who can act on the board — viewers comment too, and
-- a comment deserves its event like any write does. (log_event below is
-- the write path; it runs as its invoker, so this policy IS the gate.)
create policy events_insert on public.events
  for insert with check (public.user_board_access(board_id) is not null);

revoke insert on public.events from anon;

-- The single write helper: web server fns AND the MCP ops call this
-- (within phase 3's reach — the per-op decomposition is phase 5/ADR-5).
-- SECURITY INVOKER on purpose: RLS above is the gate, not the function.
-- Backstop (the 0071 pattern): a card-scoped event must belong to its
-- board — a forged scope must not hang an event on an invented anchor.
create or replace function public.log_event(
  p_actor_id uuid,
  p_kind text,
  p_entity_type text,
  p_entity_id uuid,
  p_board_id uuid,
  p_card_id uuid default null,
  p_detail jsonb default '{}'::jsonb,
  p_tag_ids uuid[] default '{}',
  p_agent boolean default false
)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id bigint;
  v_ws uuid;
begin
  if p_card_id is not null and not exists (
    select 1 from public.cards c
    where c.id = p_card_id and c.board_id = p_board_id
  ) then
    raise exception 'event card does not belong to event board';
  end if;

  select workspace_id into v_ws from public.boards where id = p_board_id;

  insert into public.events (
    actor_id, kind, entity_type, entity_id, workspace_id,
    board_id, card_id, tag_ids, detail, agent
  )
  values (
    p_actor_id, p_kind, p_entity_type, p_entity_id, v_ws,
    p_board_id, p_card_id, p_tag_ids, p_detail, p_agent
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.log_event(uuid, text, text, uuid, uuid, uuid, jsonb, uuid[], boolean) from anon;

-- Backfill: the card timeline's history folds in, created_at order so the
-- copied ids stay monotonic. tag_ids extracts the 'tags' kind's chip ids
-- (added + removed) so the capsule's historical arms page like new rows.
insert into public.events (
  actor_id, kind, entity_type, entity_id, workspace_id,
  board_id, card_id, tag_ids, detail, agent, created_at
)
select
  ce.actor_id,
  ce.kind,
  'card',
  ce.card_id,
  b.workspace_id,
  ce.board_id,
  ce.card_id,
  case
    when ce.kind = 'tags' then coalesce((
      select array (
        select distinct (chip->>'id')::uuid
        from (
          select jsonb_array_elements(coalesce(ce.detail->'added', '[]'::jsonb)) as chip
          union all
          select jsonb_array_elements(coalesce(ce.detail->'removed', '[]'::jsonb)) as chip
        ) chips
      )
    ), '{}'::uuid[])
    else '{}'::uuid[]
  end,
  ce.detail,
  ce.agent,
  ce.created_at
from public.card_events ce
join public.boards b on b.id = ce.board_id
order by ce.created_at;

-- The table is realtime-published: live timelines subscribe to it
-- (phase 3's reader task); the 10s poll dies there.
alter publication supabase_realtime add table public.events;

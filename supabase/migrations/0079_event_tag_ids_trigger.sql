-- 0079: tag_ids is derived by the TABLE, not the function (ADR-4).
--
-- The review carry-over from phase 3: log_event derived tag_ids from the
-- detail's chip arrays, but the events_insert RLS policy admits direct
-- REST inserts, which could carry any tag_ids — the invariant lived only
-- with RPC callers. A BEFORE INSERT trigger makes it table-wide: the
-- detail is the truth, tag_ids is its index, and no write path (RPC,
-- REST, future bulk) can supply or forget it.
--
-- log_event drops its own derivation (the trigger does it now) — one
-- derivation, not two. The backfills (0075, 0078) already replicate the
-- same extraction, so existing rows conform to the invariant as-is; a
-- one-time re-derivation over existing rows runs here as a belt to the
-- braces (idempotent by construction — it writes what the same rule
-- would have written).

create or replace function public.derive_event_tag_ids()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  NEW.tag_ids := coalesce((
    select array (
      select distinct (chip->>'id')::uuid
      from (
        select case when jsonb_typeof(NEW.detail->'added') = 'array'
               then NEW.detail->'added' else '[]'::jsonb end as arr
        union all
        select case when jsonb_typeof(NEW.detail->'removed') = 'array'
               then NEW.detail->'removed' else '[]'::jsonb end as arr
        union all
        select case when jsonb_typeof(NEW.detail->'tags') = 'array'
               then NEW.detail->'tags' else '[]'::jsonb end as arr
      ) batches,
      lateral jsonb_array_elements(batches.arr) as chip
    )
  ), '{}'::uuid[]);
  return NEW;
end;
$$;

create trigger events_tag_ids
  before insert on public.events
  for each row execute function public.derive_event_tag_ids();

-- log_event: the derivation block goes, the trigger owns it.
create or replace function public.log_event(
  p_actor_id uuid,
  p_kind text,
  p_entity_type text,
  p_entity_id uuid,
  p_board_id uuid,
  p_card_id uuid default null,
  p_detail jsonb default '{}'::jsonb
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
    p_board_id, p_card_id, '{}'::uuid[], p_detail, false
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.log_event(uuid, text, text, uuid, uuid, uuid, jsonb) from anon;

-- Belt to the braces: re-derive over existing rows (writes what the same
-- rule already wrote — the backfills conformed, this is a no-op unless
-- a direct insert ever slipped a wrong value through).
update public.events e
   set tag_ids = coalesce((
     select array (
       select distinct (chip->>'id')::uuid
       from (
         select case when jsonb_typeof(e.detail->'added') = 'array'
                then e.detail->'added' else '[]'::jsonb end as arr
         union all
         select case when jsonb_typeof(e.detail->'removed') = 'array'
                then e.detail->'removed' else '[]'::jsonb end as arr
         union all
         select case when jsonb_typeof(e.detail->'tags') = 'array'
                then e.detail->'tags' else '[]'::jsonb end as arr
       ) batches,
       lateral jsonb_array_elements(batches.arr) as chip
     )
   ), '{}'::uuid[])
 where e.tag_ids is distinct from coalesce((
     select array (
       select distinct (chip->>'id')::uuid
       from (
         select case when jsonb_typeof(e.detail->'added') = 'array'
                then e.detail->'added' else '[]'::jsonb end as arr
         union all
         select case when jsonb_typeof(e.detail->'removed') = 'array'
                then e.detail->'removed' else '[]'::jsonb end as arr
         union all
         select case when jsonb_typeof(e.detail->'tags') = 'array'
                then e.detail->'tags' else '[]'::jsonb end as arr
       ) batches,
       lateral jsonb_array_elements(batches.arr) as chip
     )
   ), '{}'::uuid[]);

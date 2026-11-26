-- 0078: card_events and activity retire (ADR-4 — one events table).
--
-- Writers cut over in 0076, readers in the same release (the timeline
-- reads the log; backfilled history folded in 0075). Nothing writes or
-- reads either table since; this drops them.
--
-- Safety (the migration-guard note): both tables are DROPPED, their
-- data superseded by the events log — 0075 backfilled card_events in
-- full at deploy time, and the cutover released with it, so no row was
-- written to card_events after the backfill. The delta copy below is
-- insurance for exactly that window (expected zero rows; if the
-- timeline ever finds one, it lands on the log instead of vanishing).
-- `activity` is copied nowhere by design: after 0032 it fed nothing
-- (the revision fallback and its writers were removed in 0076), and
-- every fact it carried is on the log with richer shape.

-- Delta insurance: any card_events row the backfill missed (a write
-- that raced the 0075/0076 deploy order) folds onto the log now.
-- Deduped on the natural tuple; entity_id keeps the card's uuid (the
-- log's bigint id is minted fresh — cursor pages order by the log's
-- own id, so folded rows sit at the page's end by age, correct).
insert into public.events (
  actor_id, kind, entity_type, entity_id, workspace_id,
  board_id, card_id, tag_ids, detail, agent, created_at
)
select
  ce.actor_id, ce.kind, 'card', ce.card_id, b.workspace_id,
  ce.board_id, ce.card_id,
  case
    when ce.kind = 'tags' then coalesce((
      select array (
        select distinct (chip->>'id')::uuid
        from (
          select case when jsonb_typeof(ce.detail->'added') = 'array'
                 then ce.detail->'added' else '[]'::jsonb end as arr
          union all
          select case when jsonb_typeof(ce.detail->'removed') = 'array'
                 then ce.detail->'removed' else '[]'::jsonb end as arr
        ) batches,
        lateral jsonb_array_elements(batches.arr) as chip
      )
    ), '{}'::uuid[])
    else '{}'::uuid[]
  end,
  ce.detail, ce.agent, ce.created_at
from public.card_events ce
join public.boards b on b.id = ce.board_id
where not exists (
  select 1 from public.events e
  where e.kind = ce.kind
    and e.card_id = ce.card_id
    and e.actor_id is not distinct from ce.actor_id
    and e.created_at = ce.created_at
    and e.detail = ce.detail
)
order by ce.created_at;

-- The drops. Cascades carry the tables' own triggers with them
-- (card_events_agent and the board_revisions bumps on card_events).
drop table public.card_events;
drop table public.activity;

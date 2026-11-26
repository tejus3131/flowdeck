-- 0074: comment stats become materialized counters (ADR-7).
--
-- Every board snapshot ran board_card_comment_stats — an aggregate RPC —
-- as one of its six queries, and every comment INSERT/DELETE re-fetched
-- the card's whole CardView per viewer (card-touch) just to move the
-- unseen badge. The counters are now rows maintained by triggers in the
-- same transaction as the comment change (ADR-7: "counters are rows, not
-- aggregates"), the snapshot joins them instead of aggregating, and
-- card_counters rides row events like any entity.
--
-- Safety (the migration-guard note): a NEW table — no existing row is
-- read or modified. Existing counts are backfilled from card_comments in
-- this same transaction, so the app code that replaces the RPC (deployed
-- by the same, schema-first-ordered release) reads consistent numbers
-- from its first snapshot. card_counters rows cascade with their cards.

create table public.card_counters (
  card_id uuid primary key references public.cards (id) on delete cascade,
  comment_count int not null default 0,
  last_comment_at timestamptz
);

alter table public.card_counters enable row level security;

-- Readable exactly where the card is readable (the card_tags pattern:
-- the inner select is itself RLS-filtered by cards_select_member).
create policy card_counters_select on public.card_counters
  for select using (
    exists (
      select 1 from public.cards c
      where c.id = card_id and public.user_board_access(c.board_id) is not null
    )
  );

-- No insert/update policies: the maintenance trigger below is the single
-- write path — commenters (viewers included) must never carry write
-- rights on the counters themselves.

-- SECURITY DEFINER because the trigger maintains rows its invoking
-- commenter has no business writing directly: viewers can comment
-- (comments_insert_members) but must not touch card_counters; the
-- trigger IS the write path (ADR-7). search_path pinned per repo rule.
--
-- Every path lands in ONE recompute-from-alive-rows statement, so no arm
-- can drift: inserts, the soft-delete flip (delete_comment sets
-- deleted_at — tombstones are updates, not deletes), a restore, and a
-- hard delete all converge to the same arithmetic. Alive = deleted_at is
-- null — the 0014 RPC counted tombstones; the counters do not, so the
-- unseen badge now matches what the comment drawer shows.
create or replace function public.card_counters_maintain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card uuid;
begin
  if tg_op = 'DELETE' then
    v_card := old.card_id;
  elsif tg_op = 'UPDATE' then
    -- Only the alive-flip matters: a body edit (deleted_at stays null)
    -- cannot change the counts.
    if (old.deleted_at is null) <> (new.deleted_at is null) then
      v_card := new.card_id;
    end if;
  else
    v_card := new.card_id; -- INSERT: alive by definition
  end if;
  if v_card is null then
    return null;
  end if;
  -- The purge paths delete cards (and boards) with the comments cascading
  -- behind them — by the time this trigger fires there, the card row is
  -- already gone, and a recompute would re-insert a counter for a dead
  -- card (FK abort — the whole purge transaction would roll back). The
  -- cascade owns the counters in that case; maintenance is for live
  -- cards only. (Cascade order between comments and counters is
  -- unspecified, so the guard — not the ordering — is what makes this
  -- deterministic.)
  if not exists (select 1 from public.cards where id = v_card) then
    return null;
  end if;
  insert into public.card_counters (card_id, comment_count, last_comment_at)
  select v_card, count(*), max(cc.created_at)
    from public.card_comments cc
   where cc.card_id = v_card and cc.deleted_at is null
  on conflict (card_id) do update
    set comment_count = excluded.comment_count,
        last_comment_at = excluded.last_comment_at;
  return null;
end;
$$;

create trigger card_counters_maintain
  after insert or update or delete on public.card_comments
  for each row execute function public.card_counters_maintain();

-- Backfill: one row per card with alive comments, from the truth itself.
insert into public.card_counters (card_id, comment_count, last_comment_at)
select cc.card_id, count(*), max(cc.created_at)
  from public.card_comments cc
 where cc.deleted_at is null
 group by cc.card_id;

-- The counters ride realtime like any entity (the stream's card_counters
-- binding replaces the card_comments card-touch).
alter publication supabase_realtime add table public.card_counters;

-- The RPC the counters replace — nothing reads it after this release.
drop function if exists public.board_card_comment_stats(uuid);

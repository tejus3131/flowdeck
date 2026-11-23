-- 0032: the trustworthy board revision — Phase 2a of docs/performance.md.
--
-- The activity table's head id served as BoardSnapshot.revision, but it is
-- not a safe resume cursor: deletions never logged activity, and activity
-- inserts are deliberately best-effort (an activity row must never fail a
-- mutation). Delta sync (Phase 2b) needs a cursor that bumps
-- transactionally with EVERY change that can reshape a board — deletions
-- included, and regardless of which path wrote (server functions, the MCP
-- server, direct SQL).
--
-- board_revisions is that cursor: one row per board, bumped by a trigger
-- on every board-scoped table, in the same transaction as the change.
-- app-side logging (logActivity) stays: it is the human-readable audit
-- trail; it no longer powers the revision.

create table if not exists public.board_revisions (
  board_id uuid primary key references public.boards(id) on delete cascade,
  revision bigint not null default 0
);

-- Seed: continue from each board's existing activity head so per-board
-- monotonicity survives the cutover.
insert into public.board_revisions (board_id, revision)
select b.id, coalesce(max(a.id), 0)
from public.boards b
left join public.activity a on a.board_id = b.id
group by b.id
on conflict (board_id) do nothing;

alter table public.board_revisions enable row level security;

-- Members read the revision (snapshot() carries it). Nobody writes it
-- directly — only the trigger below, which runs as the table owner.
drop policy if exists board_revisions_select on public.board_revisions;
create policy board_revisions_select on public.board_revisions
  for select using (public.user_board_access(board_id) is not null);

-- The bump: SECURITY DEFINER so every legitimate mutation path (member
-- editors, MCP tokens, the service role) bumps it without needing write
-- policies on board_revisions itself. search_path pinned for safety.
create or replace function public.bump_board_revision() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  target uuid := null;
begin
  -- Resolve the changed row's board. Card-side tables carry only card_id
  -- (the board comes off the card); the rest carry board_id directly.
  case TG_TABLE_NAME
    when 'boards' then target := coalesce(new.id, old.id);
    when 'card_comments' then
      target := (select board_id from public.cards where id = coalesce(new.card_id, old.card_id));
    when 'card_tags' then
      target := (select board_id from public.cards where id = coalesce(new.card_id, old.card_id));
    when 'card_assignees' then
      target := (select board_id from public.cards where id = coalesce(new.card_id, old.card_id));
    else target := coalesce(new.board_id, old.board_id);
  end case;
  -- Null target = a card-side row whose card is already gone (a cascade):
  -- the cards trigger bumps that board anyway. Skip rather than fail.
  if target is null then
    return null;
  end if;
  -- The board row may already be gone (a cascade off a board DELETE fires
  -- child triggers after the board row is deleted): nothing to bump —
  -- the revision row dies with the board.
  if not exists (select 1 from public.boards where id = target) then
    return null;
  end if;
  insert into public.board_revisions (board_id, revision) values (target, 1)
    on conflict (board_id) do update set revision = public.board_revisions.revision + 1;
  return null;
end;
$$;

-- Boards: insert/update only — a DELETE cascades board_revisions away, and
-- bumping a dying board would violate the foreign key. There is no client
-- to serve a deleted board.
drop trigger if exists board_revisions_boards on public.boards;
create trigger board_revisions_boards
  after insert or update on public.boards
  for each row execute function public.bump_board_revision();

-- Directly board-scoped tables: every op bumps.
drop trigger if exists board_revisions_lists on public.lists;
create trigger board_revisions_lists
  after insert or update or delete on public.lists
  for each row execute function public.bump_board_revision();

drop trigger if exists board_revisions_cards on public.cards;
create trigger board_revisions_cards
  after insert or update or delete on public.cards
  for each row execute function public.bump_board_revision();

drop trigger if exists board_revisions_board_messages on public.board_messages;
create trigger board_revisions_board_messages
  after insert or update or delete on public.board_messages
  for each row execute function public.bump_board_revision();

drop trigger if exists board_revisions_board_access on public.board_access;
create trigger board_revisions_board_access
  after insert or update or delete on public.board_access
  for each row execute function public.bump_board_revision();

drop trigger if exists board_revisions_board_team_access on public.board_team_access;
create trigger board_revisions_board_team_access
  after insert or update or delete on public.board_team_access
  for each row execute function public.bump_board_revision();

-- Card-side tables (board resolved through the card): every op bumps.
drop trigger if exists board_revisions_card_comments on public.card_comments;
create trigger board_revisions_card_comments
  after insert or update or delete on public.card_comments
  for each row execute function public.bump_board_revision();

drop trigger if exists board_revisions_card_tags on public.card_tags;
create trigger board_revisions_card_tags
  after insert or update or delete on public.card_tags
  for each row execute function public.bump_board_revision();

drop trigger if exists board_revisions_card_assignees on public.card_assignees;
create trigger board_revisions_card_assignees
  after insert or update or delete on public.card_assignees
  for each row execute function public.bump_board_revision();

-- Phase 2b's producers can subscribe to revision changes alone — a tiny
-- single-payload event instead of one event per table.
alter publication supabase_realtime add table public.board_revisions;

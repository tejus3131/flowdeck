-- 0018: multi-assignees per card.
--
-- cards.assignee_id held exactly one person. Teams need several, so
-- assignment moves to a join table; the single column is backfilled into
-- it and dropped.
create table if not exists public.card_assignees (
  card_id     uuid not null references public.cards(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (card_id, user_id)
);

create index if not exists card_assignees_user_idx on public.card_assignees (user_id);

-- Assignment changes re-snapshot the board (same pattern as board_access).
alter publication supabase_realtime add table public.card_assignees;

create policy card_assignees_select on public.card_assignees
  for select using (
    exists (
      select 1 from public.cards c
      where c.id = card_id and public.user_board_access(c.board_id) is not null
    )
  );
create policy card_assignees_insert on public.card_assignees
  for insert with check (
    exists (
      select 1 from public.cards c
      where c.id = card_id and public.user_board_access(c.board_id) = 'edit'
    )
  );
create policy card_assignees_delete on public.card_assignees
  for delete using (
    exists (
      select 1 from public.cards c
      where c.id = card_id and public.user_board_access(c.board_id) = 'edit'
    )
  );

-- Backfill the single-assignee column, then drop it.
insert into public.card_assignees (card_id, user_id)
  select id, assignee_id from public.cards where assignee_id is not null
  on conflict do nothing;

alter table public.cards drop column if exists assignee_id;

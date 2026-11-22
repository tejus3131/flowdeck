-- 0020: notifications — the team heartbeat.
--
-- Every mention, assignment, and comment on a card someone cares about
-- becomes a row addressed to them: the dashboard's Updates section reads
-- it, and the live stream turns fresh rows into toasts + sound.
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('mention', 'assignment', 'comment')),
  card_id    uuid references public.cards(id) on delete cascade,
  board_id   uuid references public.boards(id) on delete cascade,
  actor_id   uuid references public.profiles(id) on delete set null,
  body       text,
  created_at timestamptz not null default now(),
  seen_at    timestamptz
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);

alter publication supabase_realtime add table public.notifications;

-- Yours alone: only the recipient reads their inbox.
create policy notifications_select_own on public.notifications
  for select using (user_id = auth.uid());
-- Writers act on a board they can see (comments, assignments, mentions
-- happen on visible cards — RLS is the gate).
create policy notifications_insert_actor on public.notifications
  for insert with check (
    public.user_board_access(board_id) is not null
  );
-- Recipients mark their own inbox read.
create policy notifications_update_own on public.notifications
  for update using (user_id = auth.uid());

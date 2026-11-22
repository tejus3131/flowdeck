-- 0029: the card activity timeline — every change to a card, by whom,
-- in one audit trail. Server functions write events alongside the
-- mutation (best-effort: an event never blocks the change); the card
-- drawer's Settings tab streams them live.
create table if not exists public.card_events (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards(id) on delete cascade,
  board_id uuid not null references public.boards(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists card_events_card_idx on public.card_events (card_id, created_at desc);

alter table public.card_events enable row level security;

-- Anyone who can see the board reads its trail; only board editors write
-- (the server writes as the acting user under RLS).
drop policy if exists card_events_select on public.card_events;
create policy card_events_select on public.card_events
  for select using (public.user_board_access(board_id) is not null);

drop policy if exists card_events_insert on public.card_events;
create policy card_events_insert on public.card_events
  for insert with check (public.user_board_access(board_id) = 'edit');

alter publication supabase_realtime add table public.card_events;

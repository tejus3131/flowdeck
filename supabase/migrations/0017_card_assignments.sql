-- 0017: card assignments — priority, tags (assignee_id already exists).
--
-- Cards grow the fields a team runs on: who owns the card, how urgent it
-- is, and free-form tags — the raw material for search and progress
-- dashboards later.
alter table public.cards
  add column if not exists priority text
    check (priority in ('low', 'medium', 'high', 'urgent')),
  add column if not exists tags text[] not null default '{}';

create index if not exists cards_priority_idx on public.cards (board_id, priority);
create index if not exists cards_assignee_idx on public.cards (board_id, assignee_id);
create index if not exists cards_tags_idx on public.cards using gin (tags);

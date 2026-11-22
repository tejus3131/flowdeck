-- 0014: the "boards a team can actually use" data model.
--
--   * boards + lists get descriptions; cards get per-board numbers (#12
--     citations, GitHub-style).
--   * card_comments get the client_op identity stamp (provisional relay
--     retirement must match exactly — the pattern 0012 established).
--   * ACCESS DEFAULTS CHANGE: a workspace member used to get implicit
--     EDIT on every board; now members start with NO board access —
--     access is granted per board (view/write) from the board's settings.
--     The board owner and workspace owners/admins keep implicit edit.
--   * comment stats (count + last activity) for unseen indicators.

alter table public.boards
  add column description text not null default '';
alter table public.lists
  add column description text not null default '';
alter table public.card_comments
  add column client_op uuid;
create index card_comments_client_op_idx on public.card_comments (client_op);

-- ── card numbers: per-board sequence, race-safe via an atomic counter ─────

alter table public.cards add column number integer;

create table public.board_counters (
  board_id uuid primary key references public.boards (id) on delete cascade,
  next_number integer not null
);

alter table public.board_counters enable row level security;

create or replace function public.assign_card_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v integer;
begin
  if new.number is not null then
    return new; -- explicit numbers (backfills) pass through
  end if;
  insert into public.board_counters (board_id, next_number)
  values (new.board_id, 2)
  on conflict (board_id)
    do update set next_number = public.board_counters.next_number + 1
  returning next_number into v;
  new.number := v - 1;
  return new;
end;
$$;

create trigger on_card_insert_number
  before insert on public.cards
  for each row execute function public.assign_card_number();

-- Backfill: number existing cards by creation order per board.
with ordered as (
  select id, row_number() over (partition by board_id order by created_at, id) as rn
  from public.cards
)
update public.cards c
   set number = ordered.rn
  from ordered
 where ordered.id = c.id;

insert into public.board_counters (board_id, next_number)
select b.id, coalesce(max(c.number), 0) + 1
  from public.boards b
  left join public.cards c on c.board_id = b.id
 group by b.id
on conflict (board_id) do nothing;

-- ── access defaults: members see nothing until granted per board ─────────

create or replace function public.user_board_access(p_board_id uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select
    case
      when ba.access is not null then ba.access
      when b.owner_id = auth.uid() then 'edit'
      when wm.role in ('owner', 'admin') then 'edit'
      else null
    end
  from public.boards b
  left join public.board_access ba
    on ba.board_id = b.id and ba.user_id = auth.uid()
  left join public.workspace_members wm
    on wm.workspace_id = b.workspace_id and wm.user_id = auth.uid()
  where b.id = p_board_id
  limit 1
$$;

-- ── comment stats for the unseen indicator ───────────────────────────────

create or replace function public.board_card_comment_stats(p_board_id uuid)
returns table (card_id uuid, comment_count bigint, last_comment_at timestamptz)
language sql
stable
as $$
  select cc.card_id, count(*) as comment_count, max(cc.created_at) as last_comment_at
    from public.card_comments cc
    join public.cards c on c.id = cc.card_id
   where c.board_id = p_board_id
   group by cc.card_id
$$;

revoke execute on function public.board_card_comment_stats(uuid) from anon;

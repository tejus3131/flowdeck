-- 0056: server-side read receipts for chat (#37, #43).
--
-- The board-chat unread dot ran on per-device localStorage stamps: a new
-- device (or a cleared browser) showed every message as unread. The
-- stamp now lives server-side, keyed per user and scope — same shape as
-- chat_prefs (0024). The localStorage value stays as an instant cache
-- seeded from the server; it is no longer the source of truth.
--
-- Reads/writes go through two invoker RPCs: get_chat_seen returns the
-- caller's stamp, mark_chat_seen moves it forward monotonically
-- (greatest of old and new — an out-of-order device can never rewind a
-- read). RLS keeps every row private to its user.

create table public.chat_seen (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  scope_type text not null check (scope_type in ('board', 'card')),
  scope_id   uuid not null,
  seen_at    timestamptz not null default now(),
  primary key (user_id, scope_type, scope_id)
);
create index chat_seen_scope_idx on public.chat_seen (scope_type, scope_id);
alter table public.chat_seen enable row level security;

create policy chat_seen_select_own on public.chat_seen
  for select using (user_id = auth.uid());
create policy chat_seen_insert_own on public.chat_seen
  for insert with check (user_id = auth.uid());
create policy chat_seen_update_own on public.chat_seen
  for update using (user_id = auth.uid());

-- The caller's stamp for a scope — null when it was never seen.
create or replace function public.get_chat_seen(p_scope_type text, p_scope_id uuid)
returns timestamptz
language sql
stable
security invoker
set search_path = public
as $$
  select seen_at from public.chat_seen
  where user_id = auth.uid()
    and scope_type = p_scope_type
    and scope_id = p_scope_id;
$$;

-- Move the stamp forward (never back). Returns the stored value.
create or replace function public.mark_chat_seen(
  p_scope_type text,
  p_scope_id uuid,
  p_seen_at timestamptz default now()
)
returns timestamptz
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_at timestamptz;
begin
  insert into public.chat_seen (user_id, scope_type, scope_id, seen_at)
  values (auth.uid(), p_scope_type, p_scope_id, p_seen_at)
  on conflict (user_id, scope_type, scope_id)
  do update set seen_at = greatest(public.chat_seen.seen_at, excluded.seen_at)
  returning seen_at into v_at;
  return v_at;
end;
$$;

revoke execute on function public.get_chat_seen(text, uuid) from anon;
revoke execute on function public.mark_chat_seen(text, uuid, timestamptz) from anon;

-- 0030: Slack-style user status — emoji + text with optional expiry,
-- saved presets, do-not-disturb, and work hours. DND silences toasts,
-- sound and push while active (rows still land in the bell); work hours
-- narrow toasts to direct mentions outside the window.
create table if not exists public.user_status (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  emoji text,
  label text,
  clear_at timestamptz,
  dnd boolean not null default false,
  presets jsonb not null default '[]'::jsonb,
  work_start text,
  work_end text,
  workdays int[] not null default '{1,2,3,4,5}',
  updated_at timestamptz not null default now()
);

alter table public.user_status enable row level security;

-- Own row: full control. Everyone signed-in reads (hover cards and
-- profile pages show statuses; nothing here is sensitive).
drop policy if exists user_status_select_auth on public.user_status;
create policy user_status_select_auth on public.user_status
  for select using (auth.uid() is not null);

drop policy if exists user_status_write_own on public.user_status;
create policy user_status_write_own on public.user_status
  for insert with check (user_id = auth.uid());

drop policy if exists user_status_update_own on public.user_status;
create policy user_status_update_own on public.user_status
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

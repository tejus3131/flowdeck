-- 0022: push subscriptions — the "site not open" half of notifications.
--
-- Each browser that grants notification permission stores its web-push
-- endpoint here. When a notification row is inserted, the server also
-- sends a VAPID-signed web push, so the service worker can raise a real
-- OS notification even when the tab is closed.
create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- Yours alone: the client reads (to re-sync) and manages only its own rows.
create policy push_subscriptions_select_own on public.push_subscriptions
  for select using (user_id = auth.uid());
create policy push_subscriptions_insert_own on public.push_subscriptions
  for insert with check (user_id = auth.uid());
create policy push_subscriptions_update_own on public.push_subscriptions
  for update using (user_id = auth.uid());
create policy push_subscriptions_delete_own on public.push_subscriptions
  for delete using (user_id = auth.uid());

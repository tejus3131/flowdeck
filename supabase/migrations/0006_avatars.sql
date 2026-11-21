-- ── avatars: public bucket for profile pictures ──────────────────────────
-- Client-side upload from the profile page (WebAuthn-style: the browser does
-- the work under the signed-in session, RLS keeps people to their own
-- folder). Public read so avatars render anywhere without signed-URL
-- round trips; the profile row stores the full public URL.

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Upload/replace/delete only your own avatar (folder = your user id).
create policy avatars_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy avatars_owner_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy avatars_owner_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Anyone (including anon readers of rendered pages) may view avatars.
create policy avatars_public_read on storage.objects
  for select to authenticated, anon
  using (bucket_id = 'avatars');

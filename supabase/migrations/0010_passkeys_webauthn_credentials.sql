-- 0010: passkeys live in auth.webauthn_credentials, not auth.identities.
--
-- GoTrue's dedicated passkey tables (auth.webauthn_credentials) replaced the
-- identity-based flow: registering a passkey writes a row there and never
-- touches auth.identities. The 0005 trigger and auth_check_email both
-- watched identities, so every passkey user looked passkey-less — the
-- profile showed "Add a passkey" right after a successful registration,
-- and the sign-in branch fell back to magic links.

create or replace function public.sync_passkey_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.profiles set has_passkey = true where id = new.user_id;
  elsif tg_op = 'DELETE' then
    update public.profiles p
       set has_passkey = exists (
         select 1 from auth.webauthn_credentials c
          where c.user_id = old.user_id
       )
     where p.id = old.user_id;
  end if;
  return null;
end;
$$;

drop trigger if exists on_identity_change on auth.identities;

create trigger on_webauthn_credential_change
  after insert or delete on auth.webauthn_credentials
  for each row execute function public.sync_passkey_flag();

-- The sign-in branch: { exists, has_passkey } for an email — against the
-- table passkeys actually live in.
create or replace function public.auth_check_email(p_email text)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'exists', exists (select 1 from auth.users u where u.email = p_email),
    'has_passkey', exists (
      select 1
      from auth.users u
      join auth.webauthn_credentials c on c.user_id = u.id
      where u.email = p_email
    )
  );
$$;

revoke execute on function public.auth_check_email(text) from authenticated;

-- Backfill: registrations that landed before this migration.
update public.profiles p
   set has_passkey = true
 where exists (
   select 1 from auth.webauthn_credentials c where c.user_id = p.id
 );

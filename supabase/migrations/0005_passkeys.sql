-- Passkeys: profiles carry a has_passkey flag kept in sync by a trigger on
-- auth.identities (so getMe can report it without an admin round-trip), and
-- a pre-auth RPC tells the sign-in screen whether an email belongs to an
-- existing user with a passkey — the new-user-vs-returning-user branch.
--
-- Enumeration tradeoff (accepted, documented): auth_check_email is callable
-- by anon because the sign-in screen needs it before any session exists.
-- It reveals whether an email has an account — the same signal every
-- passkey-default product (Figma, Dropbox…) reveals via this flow.

alter table public.profiles
  add column has_passkey boolean not null default false;

create or replace function public.sync_passkey_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.provider = 'webauthn' then
    update public.profiles set has_passkey = true where id = new.user_id;
  elsif tg_op = 'DELETE' and old.provider = 'webauthn' then
    update public.profiles p
       set has_passkey = exists (
         select 1 from auth.identities i
          where i.user_id = old.user_id and i.provider = 'webauthn'
       )
     where p.id = old.user_id;
  end if;
  return null;
end;
$$;

create trigger on_identity_change
  after insert or delete on auth.identities
  for each row execute function public.sync_passkey_flag();

-- Backfill for any passkeys registered before this migration.
update public.profiles p
   set has_passkey = true
 where exists (
   select 1 from auth.identities i
    where i.user_id = p.id and i.provider = 'webauthn'
 );

-- The sign-in branch: { exists, has_passkey } for an email.
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
      join auth.identities i on i.user_id = u.id
      where u.email = p_email and i.provider = 'webauthn'
    )
  );
$$;

revoke execute on function public.auth_check_email(text) from authenticated;

-- 0068: team deletion guard — a team holding members refuses.
--
-- The deletion-safety matrix's team rule: nothing gets destroyed while
-- it holds people. Deactivating a team silently stripped every member
-- (and their board access through the team) — an accidental-delete hole
-- the same size as the boards one #35 closed. The guard raises with the
-- count and the way out; it stands down only for the sanctioned purge
-- (a workspace purge cascades teams with everything else).

create or replace function public.guard_team_delete() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_members int;
begin
  if coalesce(current_setting('flowdeck.purge', true), '') = 'on' then
    return old;
  end if;
  select count(*) into v_members from public.team_members where team_id = old.id;
  if v_members > 0 then
    raise exception 'this team still has % member% — remove them first (or deactivate the team once empty)',
      v_members, case when v_members = 1 then '' else 's' end;
  end if;
  return old;
end;
$$;

drop trigger if exists teams_members_guard on public.teams;
create trigger teams_members_guard
  before delete on public.teams
  for each row execute function public.guard_team_delete();

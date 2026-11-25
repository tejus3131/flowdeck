-- 0069: workspace deletion safety — the DB-level guarantee.
--
-- The app's deleteWorkspace pre-checks (cards, and now members) but a
-- direct PostgREST delete by the owner bypassed it: the cascade would
-- hit the boards' capsule guards mid-flight with raw trigger errors and
-- partial deletes. The trigger gives the same rule a DB-level floor:
--
--   * refuse while boards still hold cards — the sanctioned purge path
--     (purge_board / the bulk purge) arms the same flowdeck.purge flag
--     this guard honors;
--   * refuse while OTHER members exist — the cascade would delete
--     their boards and content with the workspace. Remove them (or
--     transfer ownership) first; the owner alone may delete.
--
-- Empty boards cascade with the workspace — consistent with #35, where
-- an empty board deletes freely and only cards make deletion deliberate.

create or replace function public.guard_workspace_delete() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cards int;
  v_members int;
begin
  if coalesce(current_setting('flowdeck.purge', true), '') = 'on' then
    return old;
  end if;
  select count(*) into v_members
  from public.workspace_members
  where workspace_id = old.id and user_id <> old.owner_id;
  if v_members > 0 then
    raise exception 'this workspace still has % other member% — remove them (or transfer ownership) before deleting; their boards and content would go with it',
      v_members, case when v_members = 1 then '' else 's' end;
  end if;
  select count(*) into v_cards
  from public.cards c
  join public.boards b on b.id = c.board_id
  where b.workspace_id = old.id;
  if v_cards > 0 then
    raise exception 'boards in this workspace still hold % card% — delete or purge those boards first (a board with cards deletes only after an explicit confirmation)',
      v_cards, case when v_cards = 1 then '' else 's' end;
  end if;
  -- Checks passed: the deletion is deliberate and sanctioned end-to-end.
  -- Arm the purge flag so the cascade's other capsule guards (tags,
  -- boards, cards, lists) stand down for the rest of the transaction —
  -- the workspace's tags and empty boards go with it, atomically.
  perform set_config('flowdeck.purge', 'on', true);
  return old;
end;
$$;

drop trigger if exists workspaces_capsule_guard on public.workspaces;
create trigger workspaces_capsule_guard
  before delete on public.workspaces
  for each row execute function public.guard_workspace_delete();

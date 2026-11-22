-- 0016: board_access UPDATE policy.
--
-- setBoardAccess() upserts (board_id, user_id). Changing an existing grant
-- (view -> write, write -> view) resolves to an UPDATE, and board_access had
-- only INSERT and DELETE admin policies — the update silently failed RLS,
-- so switching between view and write required going through "none" first.
create policy board_access_update_admin on public.board_access
  for update using (
    public.user_workspace_role(
      (select workspace_id from public.boards where id = board_id)
    ) in ('owner', 'admin')
  )
  with check (
    public.user_workspace_role(
      (select workspace_id from public.boards where id = board_id)
    ) in ('owner', 'admin')
  );

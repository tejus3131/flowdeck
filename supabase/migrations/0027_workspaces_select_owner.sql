-- 0027: THE create-workspace 500, fixed at the root.
--
-- createWorkspace inserts the workspace row with `.select('id').single()`
-- (INSERT ... RETURNING). Postgres runs RETURNING rows past the table's
-- SELECT policies — and workspaces_select_member only checked
-- user_workspace_role(id): at that instant the workspace has NO members
-- (the creator's membership is inserted a beat later), so the fresh row
-- was invisible and Postgres raised
--   'new row violates row-level security policy for table "workspaces"'
-- → 500 on every create. The owner must be able to read their own
-- workspace row regardless of membership state.
drop policy if exists workspaces_select_member on public.workspaces;
create policy workspaces_select_member on public.workspaces
  for select using (
    owner_id = auth.uid()
    or public.user_workspace_role(id) is not null
  );

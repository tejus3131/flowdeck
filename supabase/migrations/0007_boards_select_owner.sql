-- Boards: the insert-with-returning RLS gap, again (the 0003 lesson, applied
-- to the 0004 policy rework).
--
-- supabase-js always inserts with return=representation, so Postgres
-- evaluates the table's SELECT policy against the NEW row while it is still
-- being inserted — and public.user_board_access() (security definer) queries
-- the boards table in a snapshot where the new row is not yet visible, so
-- it returns null and the RETURNING fails with "new row violates row-level
-- security policy".
--
-- Plain SELECTs don't need this clause (user_board_access covers them) —
-- it exists so an owner's own insert can read its returning row.

drop policy boards_select_member on public.boards;
create policy boards_select_member on public.boards
  for select using (
    owner_id = auth.uid()
    or public.user_board_access(id) is not null
  );

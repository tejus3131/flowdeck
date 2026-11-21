-- Fix: boards INSERT with a readback (INSERT ... RETURNING, which is what
-- supabase-js does for every insert) failed with an RLS violation.
--
-- Why: Postgres evaluates the SELECT policies of a table against RETURNING
-- rows BEFORE AFTER-triggers run. The owner's board_members row is created
-- by the boards_add_owner AFTER INSERT trigger — so at RETURNING time it
-- does not exist yet, the boards_select_members policy (membership-based)
-- could not see the brand-new row, and the whole insert errored with
-- "new row violates row-level security policy".
--
-- The owner clause closes the gap: the owner can always read their own
-- boards, including the instant before their membership row exists.

alter policy boards_select_members on public.boards
  using (
    owner_id = auth.uid()
    or public.user_board_role(boards.id) is not null
  );

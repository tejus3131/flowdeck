-- 0028: board-less notifications were being silently dropped.
--
-- notifications_insert_actor required the ACTOR to have access to the
-- notification's board — but team_added, team_removed, invite and
-- role_changed rows carry NO board_id, so user_board_access(null) = null
-- and every such insert was denied (and only console-errored on the
-- server). That's why team additions never notified anyone and invite
-- notifications never landed. Board-scoped rows keep the strict check;
-- board-less rows are allowed for any signed-in user.
drop policy if exists notifications_insert_actor on public.notifications;
create policy notifications_insert_actor on public.notifications
  for insert with check (
    board_id is null
    or public.user_board_access(board_id) is not null
  );

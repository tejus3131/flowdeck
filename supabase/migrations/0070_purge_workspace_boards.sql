-- 0070: the bulk purge — every board in a workspace, one deliberate act.
--
-- Deleting a workspace one board at a time (each with its own typed
-- confirmation) is deliberate but tedious when the intent is "tear it
-- all down". This is the workspace-level analogue of purge_board: the
-- workspace OWNER alone, one call, every board and its cards gone.
-- The capsule guards stand down for exactly this transaction — the
-- flag is transaction-local, and only the purge paths ever arm it.

create or replace function public.purge_workspace_boards(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_boards bigint;
  v_cards   bigint;
begin
  if p_workspace_id is null then raise exception 'workspace not found'; end if;
  -- The bulk purge is the owner's alone (bigger blast radius than
  -- purge_board, which also admits workspace admins).
  if public.user_workspace_role(p_workspace_id) is distinct from 'owner' then
    raise exception 'workspace not found or no access';
  end if;

  select count(*), count(c.id) into v_boards, v_cards
  from public.boards b
  left join public.cards c on c.board_id = b.id
  where b.workspace_id = p_workspace_id;

  if v_boards = 0 then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'boards_purged', 0, 'cards_deleted', 0));
  end if;

  perform set_config('flowdeck.purge', 'on', true);
  delete from public.boards where workspace_id = p_workspace_id;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'boards_purged', v_boards, 'cards_deleted', v_cards));
end;
$$;

revoke execute on function public.purge_workspace_boards(uuid) from anon;

-- Board invite acceptance.
--
-- A new member cannot insert their own board_members row under RLS: the
-- insert policy requires the ACTING user to already be an owner/editor of
-- the board — which is the whole point of an invite. So acceptance is a
-- security-definer function: it validates the one-time token, adds the
-- membership, and marks the invite used — all inside Postgres, called with
-- the new member's JWT so auth.uid() identifies them.

create or replace function public.accept_board_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_board uuid;
  v_role  text;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  select board_id, role, email
    into v_board, v_role, v_email
  from public.board_invites
  where token = p_token
    and status = 'pending';

  if v_board is null then
    raise exception 'invite not found, revoked, or already used';
  end if;

  insert into public.board_members (board_id, user_id, role)
  values (v_board, auth.uid(), v_role)
  on conflict (board_id, user_id) do nothing;

  update public.board_invites
     set status = 'accepted'
   where token = p_token;

  insert into public.activity (board_id, user_id, type, payload)
  values (
    v_board,
    auth.uid(),
    'member.joined',
    jsonb_build_object('email', v_email, 'role', v_role)
  );

  return v_board;
end;
$$;

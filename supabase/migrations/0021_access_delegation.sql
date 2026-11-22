-- 0021: access delegation + the mention-access flow.
--
-- boards.access_delegation: when ON, anyone who can edit a board may
-- grant others access to it (and unblock their mentions); when OFF only
-- workspace owners/admins can.
--
-- notifications grow the access flow: a mention on a board the user
-- can't see never notifies them — instead the author is told, and either
-- grants access (delegation ON) or asks the workspace admins
-- (access_request → access_provided / access_denied).
alter table public.boards
  add column if not exists access_delegation boolean not null default false;

alter table public.notifications
  add column if not exists subject_id uuid references public.profiles(id) on delete set null;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check check (
    kind in ('mention', 'assignment', 'comment', 'access_request', 'access_provided', 'access_denied', 'access_granted')
  );

create index if not exists notifications_card_idx on public.notifications (card_id);
create index if not exists notifications_request_idx
  on public.notifications (kind, board_id, subject_id);

-- board_access write policies: workspace admins always; editors only
-- when the board opted into delegation.
drop policy if exists board_access_manage_admin on public.board_access;
drop policy if exists board_access_update_admin on public.board_access;
drop policy if exists board_access_delete_admin on public.board_access;

create policy board_access_insert_delegated on public.board_access
  for insert with check (
    exists (
      select 1 from public.boards b
      where b.id = board_id
        and (
          public.user_workspace_role(b.workspace_id) in ('owner', 'admin')
          or (public.user_board_access(board_id) = 'edit' and b.access_delegation)
        )
    )
  );
create policy board_access_update_delegated on public.board_access
  for update using (
    exists (
      select 1 from public.boards b
      where b.id = board_id
        and (
          public.user_workspace_role(b.workspace_id) in ('owner', 'admin')
          or (public.user_board_access(board_id) = 'edit' and b.access_delegation)
        )
    )
  )
  with check (
    exists (
      select 1 from public.boards b
      where b.id = board_id
        and (
          public.user_workspace_role(b.workspace_id) in ('owner', 'admin')
          or (public.user_board_access(board_id) = 'edit' and b.access_delegation)
        )
    )
  );
create policy board_access_delete_delegated on public.board_access
  for delete using (
    exists (
      select 1 from public.boards b
      where b.id = board_id
        and (
          public.user_workspace_role(b.workspace_id) in ('owner', 'admin')
          or (public.user_board_access(board_id) = 'edit' and b.access_delegation)
        )
    )
  );

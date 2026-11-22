-- 0024: Slack-style chat notifications, team-member notifications, the
-- GitHub board-creation policy, and team-admin powers on team boards.
--
-- CHAT PREFERENCES: per user, per scope (a board's chat, or a card's
-- comments): all | mentions_team | direct | none. Direct/team mentions
-- notify loudly (toast + push) at any level except none; "all" also
-- files every message as a quiet 'chat' notification (a separate,
-- hidden inbox section — no sound, not in the default list).
--
-- BOARD CREATION POLICY (the GitHub org setting): admins | team_admins |
-- everyone — who may create boards in this workspace.
--
-- TEAM ADMINS: may grant/remove INDIVIDUAL access on boards one of their
-- teams can edit (their team's boards) — the GitHub maintainer flow.

-- ── chat preferences ─────────────────────────────────────────────────────
create table public.chat_prefs (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  scope_type text not null check (scope_type in ('board', 'card')),
  scope_id   uuid not null,
  level      text not null default 'mentions_team'
             check (level in ('all', 'mentions_team', 'direct', 'none')),
  updated_at timestamptz not null default now(),
  primary key (user_id, scope_type, scope_id)
);
create index chat_prefs_scope_idx on public.chat_prefs (scope_type, scope_id);
alter table public.chat_prefs enable row level security;

create policy chat_prefs_select_own on public.chat_prefs
  for select using (user_id = auth.uid());
create policy chat_prefs_insert_own on public.chat_prefs
  for insert with check (user_id = auth.uid());
create policy chat_prefs_update_own on public.chat_prefs
  for update using (user_id = auth.uid());
create policy chat_prefs_delete_own on public.chat_prefs
  for delete using (user_id = auth.uid());

-- ── notifications: quiet chat rows + team membership + team subjects ─────
alter table public.notifications
  add column if not exists subject_team_id uuid references public.teams (id) on delete set null;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check check (
    kind in (
      'mention', 'assignment', 'comment',
      'access_request', 'access_provided', 'access_denied', 'access_granted',
      'access_revoked', 'role_changed',
      'chat', 'team_added', 'team_removed'
    )
  );

-- ── the board-creation policy ─────────────────────────────────────────────
alter table public.workspaces
  add column if not exists board_creation text not null default 'team_admins'
  check (board_creation in ('admins', 'team_admins', 'everyone'));

-- ── team admins manage individual access on their teams' boards ──────────
-- (in addition to workspace owners/admins and delegation-on editors).
create or replace function public.user_is_team_admin_on_board(p_board_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.board_team_access bta
    join public.team_members tm
      on tm.team_id = bta.team_id
     and tm.user_id = auth.uid()
     and tm.role = 'admin'
    where bta.board_id = p_board_id
  )
$$;

drop policy if exists board_access_insert_delegated on public.board_access;
drop policy if exists board_access_update_delegated on public.board_access;
drop policy if exists board_access_delete_delegated on public.board_access;

create policy board_access_insert_delegated on public.board_access
  for insert with check (
    exists (
      select 1 from public.boards b
      where b.id = board_id
        and (
          public.user_workspace_role(b.workspace_id) in ('owner', 'admin')
          or (public.user_board_access(board_id) = 'edit' and b.access_delegation)
          or public.user_is_team_admin_on_board(board_id)
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
          or public.user_is_team_admin_on_board(board_id)
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
          or public.user_is_team_admin_on_board(board_id)
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
          or public.user_is_team_admin_on_board(board_id)
        )
    )
  );

-- 0025: creation-policy fix, invite notifications, team lifecycle, and
-- the chat-prefs read that the notification engine needs.
--
-- CREATE-WORKSPACE 500 FIX: ws_members_insert required the caller to
-- already be owner/admin of the workspace — impossible for the creator
-- of a brand-new one (chicken and egg). The creator may now insert
-- their own owner membership for a workspace they own.
--
-- CHAT PREFS: notification fan-out runs as the AUTHOR, so it must be
-- able to read each recipient's preference row — the own-only SELECT
-- policy made every level read as "default" (mentions always fired,
-- 'all' and 'none' never worked). Now any signed-in user can read
-- levels (they're not sensitive); writes stay owner-only.
--
-- TEAMS: deletion becomes DECOMMISSIONING — deactivated_at keeps the
-- row so @mentions in old messages still resolve the name; members and
-- board grants are dropped (reinstate = fresh slate, name intact).
--
-- INVITES: pending workspace invitations become in-app notifications
-- too (email + bell) via a new 'invite' kind + a clickable href column.

-- ── the creator may join their own new workspace ──────────────────────────
drop policy if exists ws_members_manage_admin on public.workspace_members;
create policy ws_members_insert_admin on public.workspace_members
  for insert with check (
    public.user_workspace_role(workspace_id) in ('owner', 'admin')
    or (
      user_id = auth.uid()
      and role = 'owner'
      and exists (
        select 1 from public.workspaces w
        where w.id = workspace_id and w.owner_id = auth.uid()
      )
    )
  );

-- ── chat prefs: readable by any signed-in user (levels only) ─────────────
drop policy if exists chat_prefs_select_own on public.chat_prefs;
create policy chat_prefs_select_auth on public.chat_prefs
  for select using (auth.uid() is not null);

-- ── notifications: invite kind + clickable link ──────────────────────────
alter table public.notifications
  add column if not exists href text;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check check (
    kind in (
      'mention', 'assignment', 'comment',
      'access_request', 'access_provided', 'access_denied', 'access_granted',
      'access_revoked', 'role_changed',
      'chat', 'team_added', 'team_removed',
      'invite'
    )
  );

-- ── teams: decommissioning instead of deletion ────────────────────────────
alter table public.teams
  add column if not exists deactivated_at timestamptz;
create index if not exists teams_deactivated_idx on public.teams (workspace_id, deactivated_at);

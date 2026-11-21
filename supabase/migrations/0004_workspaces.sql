-- Workspaces: the tenancy unit of Flowdeck.
--
-- Model (Figma-style):
--   * workspaces are the org: workspace_members carry roles
--     (owner / admin / member).
--   * boards belong to a workspace. Every workspace member can see every
--     board; default access is 'edit' (admins and owners always edit).
--   * board_access rows are per-board OVERRIDES (edit/view) — an admin can
--     make one member a viewer on one board without touching their role.
--   * workspace_invites replace board_invites: invite by email + role,
--     accepted after sign-in via accept_workspace_invite().
--   * profiles v2: username (unique, case-insensitive) + theme preference
--     ('system' | 'light' | 'dark') synced across devices.
--
-- Every user gets a personal workspace on signup (handle_new_user), so the
-- solo flow stays zero-config; teams share the workspace.
--
-- Data migration: existing boards move into their owner's personal
-- workspace; former board members become workspace members.

-- ── tables ────────────────────────────────────────────────────────────────

create table public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 80),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  owner_id   uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index workspaces_owner_idx on public.workspaces (owner_id);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  role         text not null default 'member'
               check (role in ('owner', 'admin', 'member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_idx on public.workspace_members (user_id);

alter table public.boards
  add column workspace_id uuid references public.workspaces (id) on delete cascade;

create index boards_workspace_idx on public.boards (workspace_id);

-- Per-board access overrides. No row → default from workspace membership.
create table public.board_access (
  board_id   uuid not null references public.boards (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  access     text not null check (access in ('edit', 'view')),
  created_at timestamptz not null default now(),
  primary key (board_id, user_id)
);

create index board_access_user_idx on public.board_access (user_id);

create table public.workspace_invites (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email        text not null,
  role         text not null default 'member' check (role in ('admin', 'member')),
  token        text not null unique default replace(gen_random_uuid()::text, '-', ''),
  invited_by   uuid not null references public.profiles (id),
  status       text not null default 'pending'
               check (status in ('pending', 'accepted', 'revoked')),
  created_at   timestamptz not null default now(),
  unique (workspace_id, email)
);

-- ── profiles v2 ────────────────────────────────────────────────────────────

alter table public.profiles add column username text;
alter table public.profiles
  add column theme text not null default 'system' check (theme in ('system', 'light', 'dark'));
create unique index profiles_username_key on public.profiles (lower(username))
  where username is not null;

-- ── role + access helpers (security definer: policies use these without
--     recursing through their own RLS) ─────────────────────────────────────

create or replace function public.user_workspace_role(p_workspace_id uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select wm.role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and wm.user_id = auth.uid()
  limit 1
$$;

-- Effective access to a board: explicit override wins, else the workspace
-- role decides (owner/admin/member → 'edit'), else no access (null).
create or replace function public.user_board_access(p_board_id uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select
    case
      when ba.access is not null then ba.access
      when wm.role is not null then 'edit'
      else null
    end
  from public.boards b
  left join public.board_access ba
    on ba.board_id = b.id and ba.user_id = auth.uid()
  left join public.workspace_members wm
    on wm.workspace_id = b.workspace_id and wm.user_id = auth.uid()
  where b.id = p_board_id
  limit 1
$$;

-- ── data migration: personal workspaces for existing users ──────────────

insert into public.workspaces (name, slug, owner_id)
select
  coalesce(nullif(p.display_name, ''), split_part(p.email, '@', 1)) || '''s workspace',
  'ws-' || substr(p.id::text, 1, 8),
  p.id
from public.profiles p
on conflict (slug) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
select w.id, w.owner_id, 'owner'
from public.workspaces w
on conflict (workspace_id, user_id) do nothing;

update public.boards b
set workspace_id = w.id
from public.workspaces w
where w.owner_id = b.owner_id
  and b.workspace_id is null;

-- Former per-board members (non-owners) become workspace members. They had
-- edit access to one board before; workspace membership is the new unit —
-- access is still governed by the policies below.
insert into public.workspace_members (workspace_id, user_id, role)
select distinct b.workspace_id, bm.user_id, 'member'
from public.board_members bm
join public.boards b on b.id = bm.board_id
where b.workspace_id is not null
  and bm.role <> 'owner'
on conflict (workspace_id, user_id) do nothing;

-- ── per-board machinery is replaced by the workspace model ───────────────

-- profiles: peers are now the people sharing a workspace.
drop policy profiles_select_peers on public.profiles;
create policy profiles_select_peers on public.profiles
  for select using (
    id = auth.uid()
    or exists (
      select 1
      from public.workspace_members me
      join public.workspace_members them
        on them.workspace_id = me.workspace_id
      where me.user_id = auth.uid()
        and them.user_id = profiles.id
    )
  );

drop trigger if exists boards_add_owner on public.boards;
drop function if exists public.add_board_owner();
drop function if exists public.accept_board_invite(text);
drop table if exists public.board_invites;
drop table if exists public.board_members;

-- ── RLS: workspaces & members ─────────────────────────────────────────────

alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.board_access      enable row level security;

create policy workspaces_select_member on public.workspaces
  for select using (public.user_workspace_role(id) is not null);
create policy workspaces_insert_owner on public.workspaces
  for insert with check (owner_id = auth.uid());
create policy workspaces_update_admin on public.workspaces
  for update using (public.user_workspace_role(id) in ('owner', 'admin'));
create policy workspaces_delete_owner on public.workspaces
  for delete using (public.user_workspace_role(id) = 'owner');

create policy ws_members_select on public.workspace_members
  for select using (
    user_id = auth.uid() or public.user_workspace_role(workspace_id) is not null
  );
create policy ws_members_manage_admin on public.workspace_members
  for insert with check (public.user_workspace_role(workspace_id) in ('owner', 'admin'));
create policy ws_members_update_admin on public.workspace_members
  for update using (public.user_workspace_role(workspace_id) in ('owner', 'admin'));
create policy ws_members_delete_admin on public.workspace_members
  for delete using (
    public.user_workspace_role(workspace_id) in ('owner', 'admin')
    or user_id = auth.uid()  -- leave yourself
  );

-- ── RLS: invites & overrides ──────────────────────────────────────────────

create policy ws_invites_select on public.workspace_invites
  for select using (
    email = coalesce(auth.jwt() ->> 'email', '')
    or public.user_workspace_role(workspace_id) in ('owner', 'admin')
  );
create policy ws_invites_manage_admin on public.workspace_invites
  for insert with check (public.user_workspace_role(workspace_id) in ('owner', 'admin'));
create policy ws_invites_update_accept on public.workspace_invites
  for update using (
    email = coalesce(auth.jwt() ->> 'email', '')
    or public.user_workspace_role(workspace_id) in ('owner', 'admin')
  );
create policy ws_invites_delete_admin on public.workspace_invites
  for delete using (public.user_workspace_role(workspace_id) in ('owner', 'admin'));

create policy board_access_select on public.board_access
  for select using (
    user_id = auth.uid()
    or public.user_board_access(board_id) = 'edit'
  );
create policy board_access_manage_admin on public.board_access
  for insert with check (
    public.user_board_access(board_id) = 'edit'
    and public.user_workspace_role(
      (select workspace_id from public.boards where id = board_id)
    ) in ('owner', 'admin')
  );
create policy board_access_delete_admin on public.board_access
  for delete using (
    public.user_workspace_role(
      (select workspace_id from public.boards where id = board_id)
    ) in ('owner', 'admin')
  );

-- ── RLS rework: boards / lists / cards / comments ────────────────────────

drop policy boards_select_members on public.boards;
drop policy boards_insert_own on public.boards;
drop policy boards_update_editors on public.boards;
drop policy boards_delete_owner on public.boards;

create policy boards_select_member on public.boards
  for select using (public.user_board_access(id) is not null);
create policy boards_insert_member on public.boards
  for insert with check (
    owner_id = auth.uid()
    and workspace_id is not null
    and public.user_workspace_role(workspace_id) is not null
  );
create policy boards_update_edit on public.boards
  for update using (public.user_board_access(id) = 'edit');
create policy boards_delete_admin on public.boards
  for delete using (
    owner_id = auth.uid()
    or public.user_workspace_role(workspace_id) in ('owner', 'admin')
  );

drop policy lists_select_members on public.lists;
drop policy lists_insert_editors on public.lists;
drop policy lists_update_editors on public.lists;
drop policy lists_delete_editors on public.lists;

create policy lists_select_member on public.lists
  for select using (public.user_board_access(board_id) is not null);
create policy lists_write_edit on public.lists
  for insert with check (public.user_board_access(board_id) = 'edit');
create policy lists_update_edit on public.lists
  for update using (public.user_board_access(board_id) = 'edit');
create policy lists_delete_edit on public.lists
  for delete using (public.user_board_access(board_id) = 'edit');

drop policy cards_select_members on public.cards;
drop policy cards_insert_editors on public.cards;
drop policy cards_update_editors on public.cards;
drop policy cards_delete_editors on public.cards;

create policy cards_select_member on public.cards
  for select using (public.user_board_access(board_id) is not null);
create policy cards_insert_edit on public.cards
  for insert with check (
    public.user_board_access(board_id) = 'edit'
    and created_by = auth.uid()
  );
create policy cards_update_edit on public.cards
  for update using (public.user_board_access(board_id) = 'edit');
create policy cards_delete_edit on public.cards
  for delete using (public.user_board_access(board_id) = 'edit');

-- Comments: any access level can read and comment (viewers comment too).
drop policy comments_select_members on public.card_comments;
drop policy comments_insert_members on public.card_comments;
drop policy comments_delete_own on public.card_comments;

create policy comments_select_member on public.card_comments
  for select using (
    exists (
      select 1 from public.cards c
      where c.id = card_comments.card_id
        and public.user_board_access(c.board_id) is not null
    )
  );
create policy comments_insert_member on public.card_comments
  for insert with check (
    exists (
      select 1 from public.cards c
      where c.id = card_id
        and public.user_board_access(c.board_id) is not null
    )
    and user_id = auth.uid()
  );
create policy comments_delete_own on public.card_comments
  for delete using (user_id = auth.uid());

drop policy attachments_select_members on public.card_attachments;
drop policy attachments_insert_members on public.card_attachments;
drop policy attachments_delete_members on public.card_attachments;

create policy attachments_select_member on public.card_attachments
  for select using (
    exists (
      select 1 from public.cards c
      where c.id = card_attachments.card_id
        and public.user_board_access(c.board_id) is not null
    )
  );
create policy attachments_insert_edit on public.card_attachments
  for insert with check (
    exists (
      select 1 from public.cards c
      where c.id = card_id
        and public.user_board_access(c.board_id) = 'edit'
    )
    and user_id = auth.uid()
  );
create policy attachments_delete_edit on public.card_attachments
  for delete using (
    exists (
      select 1 from public.cards c
      where c.id = card_id
        and public.user_board_access(c.board_id) = 'edit'
    )
  );

drop policy activity_select_members on public.activity;
drop policy activity_insert_members on public.activity;

create policy activity_select_member on public.activity
  for select using (public.user_board_access(board_id) is not null);
create policy activity_insert_member on public.activity
  for insert with check (public.user_board_access(board_id) is not null);

-- ── signup bootstrap: personal workspace for every new user ──────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;

  -- Personal workspace, so solo use needs zero setup.
  insert into public.workspaces (name, slug, owner_id)
  values (
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)) || '''s workspace',
    'ws-' || substr(new.id::text, 1, 8),
    new.id
  )
  on conflict (slug) do nothing;

  insert into public.workspace_members (workspace_id, user_id, role)
  select w.id, new.id, 'owner'
  from public.workspaces w
  where w.owner_id = new.id
  on conflict (workspace_id, user_id) do nothing;

  return new;
end;
$$;

-- ── workspace invite acceptance ──────────────────────────────────────────

create or replace function public.accept_workspace_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace uuid;
  v_role      text;
  v_email     text;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  select workspace_id, role, email
    into v_workspace, v_role, v_email
  from public.workspace_invites
  where token = p_token
    and status = 'pending';

  if v_workspace is null then
    raise exception 'invite not found, revoked, or already used';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace, auth.uid(), v_role)
  on conflict (workspace_id, user_id) do nothing;

  update public.workspace_invites
     set status = 'accepted'
   where token = p_token;

  return v_workspace;
end;
$$;

-- ── realtime: publish the workspace graph + profiles (theme sync, names) ─

alter publication supabase_realtime add table public.workspaces;
alter publication supabase_realtime add table public.workspace_members;
alter publication supabase_realtime add table public.profiles;
alter table public.profiles replica identity full;

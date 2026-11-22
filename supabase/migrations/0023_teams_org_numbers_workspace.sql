-- 0023: teams, org-wide card numbers, workspace management, misc.
--
-- TEAMS (GitHub org-teams model, verified against their docs):
--   * workspace owners/admins create teams; team admins (maintainers)
--     manage membership;
--   * a board grants access to a team — every member inherits it
--     (user_board_access now resolves personal override > team grant >
--     role);
--   * @team mentions fan out to individual notification rows per member
--     (Slack user-group behavior: each person's notification is their own).
--
-- ORG-WIDE CARD NUMBERS: like a GitHub repo's issue numbers, but scoped to
-- the workspace — #N is unique across every board in the org, which makes
-- cross-board references unambiguous. Existing cards are renumbered in
-- creation order per workspace.
--
-- WORKSPACE MANAGEMENT: owners rename workspaces, set an invite domain
-- allowlist, delete them; signup no longer auto-creates a personal
-- workspace (invited users join exactly what they were invited to).
--
-- MISC: tags get a description; notifications learn access_revoked and
-- role_changed (so access changes reach the person on every screen).

-- ── tags: a description taken at creation time ────────────────────────────
alter table public.tags add column if not exists description text not null default '';

-- ── org-wide card numbers ──────────────────────────────────────────────────
create table public.workspace_counters (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  next_number integer not null
);
alter table public.workspace_counters enable row level security;

-- Assign from the WORKSPACE counter (boards without a workspace keep the
-- legacy per-board counter).
create or replace function public.assign_card_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v integer;
  v_ws uuid;
begin
  if new.number is not null then
    return new; -- explicit numbers (backfills) pass through
  end if;
  select b.workspace_id into v_ws from public.boards b where b.id = new.board_id;
  if v_ws is null then
    insert into public.board_counters (board_id, next_number)
    values (new.board_id, 2)
    on conflict (board_id)
      do update set next_number = public.board_counters.next_number + 1
    returning next_number into v;
    new.number := v - 1;
    return new;
  end if;
  insert into public.workspace_counters (workspace_id, next_number)
  values (v_ws, 2)
  on conflict (workspace_id)
    do update set next_number = public.workspace_counters.next_number + 1
  returning next_number into v;
  new.number := v - 1;
  return new;
end;
$$;

-- Renumber existing cards: workspace-wide, in creation order. Cross-board
-- #citations were per-board before; they now read org-wide (accepting the
-- renumber — this is the one-time cost of the switch).
with ordered as (
  select c.id,
         row_number() over (partition by b.workspace_id order by c.created_at, c.id) as rn,
         b.workspace_id
    from public.cards c
    join public.boards b on b.id = c.board_id
   where b.workspace_id is not null
)
update public.cards c
   set number = ordered.rn
  from ordered
 where ordered.id = c.id;

insert into public.workspace_counters (workspace_id, next_number)
select b.workspace_id, coalesce(max(c.number), 0) + 1
  from public.boards b
  left join public.cards c on c.board_id = b.id
 where b.workspace_id is not null
 group by b.workspace_id
on conflict (workspace_id) do update set next_number = excluded.next_number;

-- ── teams ──────────────────────────────────────────────────────────────────
create table public.teams (
  id          uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  description text not null default '',
  created_at  timestamptz not null default now()
);
create index teams_workspace_idx on public.teams (workspace_id);
alter table public.teams enable row level security;

create table public.team_members (
  team_id    uuid not null references public.teams (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_idx on public.team_members (user_id);
alter table public.team_members enable row level security;

create table public.board_team_access (
  board_id   uuid not null references public.boards (id) on delete cascade,
  team_id    uuid not null references public.teams (id) on delete cascade,
  access     text not null check (access in ('view', 'edit')),
  created_at timestamptz not null default now(),
  primary key (board_id, team_id)
);
alter table public.board_team_access enable row level security;

-- The caller's role IN a team ('admin' = maintainer), null when not a member.
create or replace function public.user_team_role(p_team_id uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select tm.role
  from public.team_members tm
  where tm.team_id = p_team_id
    and tm.user_id = auth.uid()
  limit 1
$$;

-- Workspace members see teams and who's on them (visible teams — GitHub's
-- "visible to everyone in the org"; secret teams are out of scope).
create policy teams_select_members on public.teams
  for select using (
    public.user_workspace_role(workspace_id) is not null
  );
create policy teams_insert_admin on public.teams
  for insert with check (
    public.user_workspace_role(workspace_id) in ('owner', 'admin')
  );
create policy teams_update_admin on public.teams
  for update using (
    public.user_workspace_role(workspace_id) in ('owner', 'admin')
    or public.user_team_role(id) = 'admin'
  )
  with check (
    public.user_workspace_role(workspace_id) in ('owner', 'admin')
    or public.user_team_role(id) = 'admin'
  );
create policy teams_delete_admin on public.teams
  for delete using (
    public.user_workspace_role(workspace_id) in ('owner', 'admin')
  );

create policy team_members_select_members on public.team_members
  for select using (
    user_id = auth.uid()
    or public.user_workspace_role((select workspace_id from public.teams where id = team_id)) is not null
  );
-- Team admins add and remove members; they can't touch other admins.
create policy team_members_insert_admin on public.team_members
  for insert with check (
    public.user_workspace_role((select workspace_id from public.teams where id = team_id)) in ('owner', 'admin')
    or public.user_team_role(team_id) = 'admin'
  );
create policy team_members_update_admin on public.team_members
  for update using (
    public.user_workspace_role((select workspace_id from public.teams where id = team_id)) in ('owner', 'admin')
    or (public.user_team_role(team_id) = 'admin' and role = 'member')
  )
  with check (
    public.user_workspace_role((select workspace_id from public.teams where id = team_id)) in ('owner', 'admin')
    or public.user_team_role(team_id) = 'admin'
  );
create policy team_members_delete_admin on public.team_members
  for delete using (
    public.user_workspace_role((select workspace_id from public.teams where id = team_id)) in ('owner', 'admin')
    or (public.user_team_role(team_id) = 'admin' and role = 'member')
  );

-- Board→team grants: visible to board editors and the team's members.
create policy board_team_access_select on public.board_team_access
  for select using (
    public.user_board_access(board_id) = 'edit'
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = board_team_access.team_id and tm.user_id = auth.uid()
    )
  );
-- Granters: workspace owners/admins, or the team's admins (on boards they
-- can already edit) — the GitHub maintainer flow.
create policy board_team_access_insert on public.board_team_access
  for insert with check (
    public.user_workspace_role(
      (select workspace_id from public.boards where id = board_id)
    ) in ('owner', 'admin')
    or (
      public.user_team_role(team_id) = 'admin'
      and public.user_board_access(board_id) = 'edit'
    )
  );
create policy board_team_access_update on public.board_team_access
  for update using (
    public.user_workspace_role(
      (select workspace_id from public.boards where id = board_id)
    ) in ('owner', 'admin')
    or (
      public.user_team_role(team_id) = 'admin'
      and public.user_board_access(board_id) = 'edit'
    )
  )
  with check (
    public.user_workspace_role(
      (select workspace_id from public.boards where id = board_id)
    ) in ('owner', 'admin')
    or (
      public.user_team_role(team_id) = 'admin'
      and public.user_board_access(board_id) = 'edit'
    )
  );
create policy board_team_access_delete on public.board_team_access
  for delete using (
    public.user_workspace_role(
      (select workspace_id from public.boards where id = board_id)
    ) in ('owner', 'admin')
    or (
      public.user_team_role(team_id) = 'admin'
      and public.user_board_access(board_id) = 'edit'
    )
  );

-- user_board_access v2: personal override > role > team grant (a team
-- grant can only add access; an explicit personal override wins over it).
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
      when b.owner_id = auth.uid() then 'edit'
      when wm.role in ('owner', 'admin') then 'edit'
      when tg.access is not null then tg.access
      else null
    end
  from public.boards b
  left join public.board_access ba
    on ba.board_id = b.id and ba.user_id = auth.uid()
  left join public.workspace_members wm
    on wm.workspace_id = b.workspace_id and wm.user_id = auth.uid()
  left join (
    select bta.board_id,
           case when bool_or(bta.access = 'edit') then 'edit' else 'view' end as access
      from public.board_team_access bta
      join public.team_members tm
        on tm.team_id = bta.team_id and tm.user_id = auth.uid()
     group by bta.board_id
  ) tg on tg.board_id = b.id
  where b.id = p_board_id
  limit 1
$$;

-- ── workspace management ─────────────────────────────────────────────────
alter table public.workspaces
  add column if not exists invite_domains text[] not null default '{}';

-- Signup: create the profile only — NO auto workspace. Invited users join
-- exactly what they were invited to; everyone else gets the create-CTA.
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
  return new;
end;
$$;

-- ── notifications: access-change vocabulary ───────────────────────────────
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check check (
    kind in (
      'mention', 'assignment', 'comment',
      'access_request', 'access_provided', 'access_denied', 'access_granted',
      'access_revoked', 'role_changed'
    )
  );

-- ── realtime: the new tables re-shape board lists and settings live ─────
alter publication supabase_realtime add table public.teams;
alter publication supabase_realtime add table public.team_members;
alter publication supabase_realtime add table public.board_team_access;

-- ── board-level chat: same shape as card comments, attached to a board ──
create table public.board_messages (
  id          uuid primary key default gen_random_uuid(),
  board_id    uuid not null references public.boards (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 4000),
  client_op   uuid,
  created_at  timestamptz not null default now()
);
create index board_messages_board_idx on public.board_messages (board_id, created_at);
create index board_messages_client_op_idx on public.board_messages (client_op);

alter table public.board_messages enable row level security;

create policy board_messages_select on public.board_messages
  for select using (public.user_board_access(board_id) is not null);
create policy board_messages_insert on public.board_messages
  for insert with check (public.user_board_access(board_id) = 'edit');
create policy board_messages_delete_own on public.board_messages
  for delete using (user_id = auth.uid());

alter publication supabase_realtime add table public.board_messages;

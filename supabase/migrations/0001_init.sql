-- Flowdeck initial schema.
--
-- Boards → lists → cards, with comments, attachments, member invites, an
-- activity feed, and personal API tokens for the MCP server / CLI.
--
-- Design notes:
--   * Every table has RLS. Access is board-membership based, mediated by
--     the security-definer helper user_board_role() to avoid recursive
--     policies on board_members.
--   * Realtime: boards, board_members, lists, cards, card_comments and
--     activity are added to the supabase_realtime publication so the app's
--     live() server sources can subscribe server-side with the user's JWT
--     (RLS then filters what each connected user receives).
--   * Positions use double precision for fractional reordering (drag a card
--     between two → midpoint), so drags never rewrite a whole column.
--   * invites are a separate table from members: a pending invite has an
--     email but no user yet; accepting (after magic-link sign-in) inserts
--     the board_members row.
--   * api_tokens stores only a sha256 hash; the plaintext token is shown
--     once at creation and never persisted.

create extension if not exists pgcrypto;

-- ── profiles ──────────────────────────────────────────────────────────────

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  display_name text not null default '',
  avatar_url  text,
  created_at  timestamptz not null default now()
);

-- Mirror every new auth user into profiles (display name: user metadata
-- name, else the email local part).
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── boards & membership ──────────────────────────────────────────────────

create table public.boards (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 80),
  owner_id   uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.board_members (
  board_id   uuid not null references public.boards (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null default 'editor'
             check (role in ('owner', 'editor', 'viewer')),
  status     text not null default 'active' check (status in ('active')),
  created_at timestamptz not null default now(),
  primary key (board_id, user_id)
);

create index board_members_user_idx on public.board_members (user_id);

-- The creator of a board becomes its owner member automatically.
create or replace function public.add_board_owner()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.board_members (board_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (board_id, user_id) do nothing;
  return new;
end;
$$;

create trigger boards_add_owner
  after insert on public.boards
  for each row execute function public.add_board_owner();

-- Pending invitations: identified by email + one-time token, no user yet.
create table public.board_invites (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.boards (id) on delete cascade,
  email      text not null,
  role       text not null default 'editor' check (role in ('editor', 'viewer')),
  token      text not null unique default encode(gen_random_bytes(24), 'hex'),
  invited_by uuid not null references public.profiles (id),
  status     text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  created_at timestamptz not null default now(),
  unique (board_id, email)
);

-- The membership helper used by nearly every policy below. security definer
-- so board_member policies don't recurse through their own RLS.
create or replace function public.user_board_role(p_board_id uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select bm.role
  from public.board_members bm
  where bm.board_id = p_board_id
    and bm.user_id = auth.uid()
  limit 1
$$;

-- ── lists & cards ────────────────────────────────────────────────────────

create table public.lists (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.boards (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 80),
  position   double precision not null default 0,
  created_at timestamptz not null default now()
);

create index lists_board_pos_idx on public.lists (board_id, position);

create table public.cards (
  id          uuid primary key default gen_random_uuid(),
  board_id    uuid not null references public.boards (id) on delete cascade,
  list_id     uuid not null references public.lists (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 200),
  description text not null default '',
  position    double precision not null default 0,
  assignee_id uuid references public.profiles (id) on delete set null,
  created_by  uuid not null references public.profiles (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index cards_board_pos_idx on public.cards (board_id, position);
create index cards_list_pos_idx on public.cards (list_id, position);
create index cards_assignee_idx on public.cards (assignee_id);

create table public.card_comments (
  id         uuid primary key default gen_random_uuid(),
  card_id    uuid not null references public.cards (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index card_comments_card_idx on public.card_comments (card_id, created_at);

create table public.card_attachments (
  id           uuid primary key default gen_random_uuid(),
  card_id      uuid not null references public.cards (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  storage_path text not null,
  filename     text not null,
  content_type text,
  size_bytes   bigint,
  created_at   timestamptz not null default now()
);

create index card_attachments_card_idx on public.card_attachments (card_id);

-- Private bucket for attachments; access goes through signed URLs issued
-- by server functions to verified board members.
insert into storage.buckets (id, name, public)
values ('card-attachments', 'card-attachments', false)
on conflict (id) do nothing;

-- ── activity feed ────────────────────────────────────────────────────────

create table public.activity (
  id         bigint generated always as identity primary key,
  board_id   uuid not null references public.boards (id) on delete cascade,
  user_id    uuid references public.profiles (id) on delete set null,
  type       text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index activity_board_idx on public.activity (board_id, id desc);

-- ── personal API tokens (MCP server / CLI) ──────────────────────────────

create table public.api_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  name        text not null default 'token',
  token_hash  text not null unique,  -- sha256 hex of the full plaintext token
  created_at  timestamptz not null default now(),
  last_used_at timestamptz
);

create index api_tokens_user_idx on public.api_tokens (user_id);

-- ── updated_at maintenance ───────────────────────────────────────────────

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger boards_touch before update on public.boards
  for each row execute function public.touch_updated_at();
create trigger cards_touch before update on public.cards
  for each row execute function public.touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table public.profiles        enable row level security;
alter table public.boards         enable row level security;
alter table public.board_members  enable row level security;
alter table public.board_invites  enable row level security;
alter table public.lists          enable row level security;
alter table public.cards          enable row level security;
alter table public.card_comments  enable row level security;
alter table public.card_attachments enable row level security;
alter table public.activity       enable row level security;
alter table public.api_tokens     enable row level security;

-- profiles: you see and edit your own; board members read each other's via
-- the member policies below joining on profiles through board membership.
create policy profiles_select_own on public.profiles
  for select using (id = auth.uid());
create policy profiles_update_own on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- profiles of people you share a board with (for assignee pickers etc.)
create policy profiles_select_peers on public.profiles
  for select using (
    exists (
      select 1
      from public.board_members me
      join public.board_members them
        on them.board_id = me.board_id
      where me.user_id = auth.uid()
        and them.user_id = profiles.id
    )
  );

-- boards
create policy boards_select_members on public.boards
  for select using (public.user_board_role(boards.id) is not null);
create policy boards_insert_own on public.boards
  for insert with check (owner_id = auth.uid());
create policy boards_update_editors on public.boards
  for update using (public.user_board_role(boards.id) in ('owner', 'editor'));
create policy boards_delete_owner on public.boards
  for delete using (public.user_board_role(boards.id) = 'owner');

-- board_members: members see the roster of boards they belong to.
create policy members_select on public.board_members
  for select using (
    user_id = auth.uid() or public.user_board_role(board_id) is not null
  );
create policy members_insert_editors on public.board_members
  for insert with check (public.user_board_role(board_id) in ('owner', 'editor'));
create policy members_delete_editors on public.board_members
  for delete using (public.user_board_role(board_id) in ('owner', 'editor'));
create policy members_leave_self on public.board_members
  for delete using (user_id = auth.uid());

-- board_invites: see invites for your own email, or ones you sent/manage.
create policy invites_select on public.board_invites
  for select using (
    email = coalesce(auth.jwt() ->> 'email', '')
    or public.user_board_role(board_id) in ('owner', 'editor')
  );
create policy invites_insert_editors on public.board_invites
  for insert with check (public.user_board_role(board_id) in ('owner', 'editor'));
create policy invites_update_accept on public.board_invites
  for update using (
    email = coalesce(auth.jwt() ->> 'email', '')
    or public.user_board_role(board_id) in ('owner', 'editor')
  );
create policy invites_delete_editors on public.board_invites
  for delete using (public.user_board_role(board_id) in ('owner', 'editor'));

-- lists
create policy lists_select_members on public.lists
  for select using (public.user_board_role(lists.board_id) is not null);
create policy lists_insert_editors on public.lists
  for insert with check (public.user_board_role(lists.board_id) in ('owner', 'editor'));
create policy lists_update_editors on public.lists
  for update using (public.user_board_role(lists.board_id) in ('owner', 'editor'));
create policy lists_delete_editors on public.lists
  for delete using (public.user_board_role(lists.board_id) in ('owner', 'editor'));

-- cards (board_id is denormalized so policies and realtime filters never
-- need to hop through lists)
create policy cards_select_members on public.cards
  for select using (public.user_board_role(cards.board_id) is not null);
create policy cards_insert_editors on public.cards
  for insert with check (
    public.user_board_role(cards.board_id) in ('owner', 'editor')
    and cards.created_by = auth.uid()
  );
create policy cards_update_editors on public.cards
  for update using (public.user_board_role(cards.board_id) in ('owner', 'editor'));
create policy cards_delete_editors on public.cards
  for delete using (public.user_board_role(cards.board_id) in ('owner', 'editor'));

-- card_comments: any member (including viewers) can comment
create policy comments_select_members on public.card_comments
  for select using (
    exists (
      select 1 from public.cards c
      where c.id = card_comments.card_id
        and public.user_board_role(c.board_id) is not null
    )
  );
create policy comments_insert_members on public.card_comments
  for insert with check (
    exists (
      select 1 from public.cards c
      where c.id = card_id
        and public.user_board_role(c.board_id) is not null
    )
    and user_id = auth.uid()
  );
create policy comments_delete_own on public.card_comments
  for delete using (user_id = auth.uid());

-- card_attachments: same shape as comments
create policy attachments_select_members on public.card_attachments
  for select using (
    exists (
      select 1 from public.cards c
      where c.id = card_attachments.card_id
        and public.user_board_role(c.board_id) is not null
    )
  );
create policy attachments_insert_members on public.card_attachments
  for insert with check (
    exists (
      select 1 from public.cards c
      where c.id = card_id
        and public.user_board_role(c.board_id) in ('owner', 'editor')
    )
    and user_id = auth.uid()
  );
create policy attachments_delete_members on public.card_attachments
  for delete using (
    exists (
      select 1 from public.cards c
      where c.id = card_id
        and public.user_board_role(c.board_id) in ('owner', 'editor')
    )
  );

-- activity: members read; the acting member's session inserts
create policy activity_select_members on public.activity
  for select using (public.user_board_role(activity.board_id) is not null);
create policy activity_insert_members on public.activity
  for insert with check (public.user_board_role(board_id) is not null);

-- api_tokens: strictly your own
create policy tokens_select_own on public.api_tokens
  for select using (user_id = auth.uid());
create policy tokens_insert_own on public.api_tokens
  for insert with check (user_id = auth.uid());
create policy tokens_delete_own on public.api_tokens
  for delete using (user_id = auth.uid());

-- ── realtime ─────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

alter publication supabase_realtime add table public.boards;
alter publication supabase_realtime add table public.board_members;
alter publication supabase_realtime add table public.lists;
alter publication supabase_realtime add table public.cards;
alter publication supabase_realtime add table public.card_comments;
alter publication supabase_realtime add table public.activity;

-- FULL so UPDATE/DELETE events carry row data to RLS-filtered subscribers.
alter table public.cards replica identity full;
alter table public.lists replica identity full;
alter table public.board_members replica identity full;

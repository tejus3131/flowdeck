-- 0019: tags as first-class relations.
--
-- A tag isn't a card's private text — it's a shared vocabulary that
-- CONNECTS cards (and later, search). Tags move to a per-workspace table
-- with stable ids; cards link through card_tags. Same tag name on two
-- cards = same tag row, forever. Names are stored lowercased.
create table if not exists public.tags (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 24),
  created_at   timestamptz not null default now(),
  unique (workspace_id, name)
);

create table if not exists public.card_tags (
  card_id uuid not null references public.cards(id) on delete cascade,
  tag_id  uuid not null references public.tags(id) on delete cascade,
  primary key (card_id, tag_id)
);

create index if not exists card_tags_tag_idx on public.card_tags (tag_id);
alter publication supabase_realtime add table public.tags;
alter publication supabase_realtime add table public.card_tags;

-- Tags are the workspace's vocabulary: any member reads them, members
-- create them, admins remove them.
create policy tags_select_member on public.tags
  for select using (public.user_workspace_role(workspace_id) is not null);
create policy tags_insert_member on public.tags
  for insert with check (public.user_workspace_role(workspace_id) is not null);
create policy tags_delete_admin on public.tags
  for delete using (public.user_workspace_role(workspace_id) in ('owner', 'admin'));

create policy card_tags_select on public.card_tags
  for select using (
    exists (
      select 1 from public.cards c
      where c.id = card_id and public.user_board_access(c.board_id) is not null
    )
  );
create policy card_tags_insert on public.card_tags
  for insert with check (
    exists (
      select 1 from public.cards c
      where c.id = card_id and public.user_board_access(c.board_id) = 'edit'
    )
  );
create policy card_tags_delete on public.card_tags
  for delete using (
    exists (
      select 1 from public.cards c
      where c.id = card_id and public.user_board_access(c.board_id) = 'edit'
    )
  );

-- Backfill: every existing cards.tags text[] value becomes a real tag row
-- in its board's workspace, linked to its card.
do $$
declare
  card record;
  tag_name text;
  tag_id uuid;
begin
  for card in select id, board_id, tags from public.cards where cardinality(tags) > 0
  loop
    foreach tag_name in array card.tags loop
      insert into public.tags (workspace_id, name)
      select b.workspace_id, lower(tag_name)
      from public.boards b where b.id = card.board_id
      on conflict (workspace_id, name) do nothing;

      select t.id into tag_id
      from public.tags t
      join public.boards b on b.workspace_id = t.workspace_id
      where b.id = card.board_id and t.name = lower(tag_name);

      if tag_id is not null then
        insert into public.card_tags (card_id, tag_id) values (card.id, tag_id)
        on conflict do nothing;
      end if;
    end loop;
  end loop;
end $$;

alter table public.cards drop column if exists tags;

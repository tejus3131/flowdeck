-- 0011: account deletion must not be blocked by audit columns.
--
-- Deleting a user cascades their profile row; cards.created_by and
-- workspace_invites.invited_by referenced it WITHOUT a cascade action,
-- so any account that had ever created a card (in a workspace that
-- survives deletion, like a team they were invited to) could not be
-- deleted — Postgres refused the profile delete. Audit columns lose
-- their author on account deletion: they become NULL ("Someone"), the
-- same treatment assignee_id already had.

alter table public.cards alter column created_by drop not null;
alter table public.cards drop constraint cards_created_by_fkey;
alter table public.cards
  add constraint cards_created_by_fkey
  foreign key (created_by) references public.profiles (id) on delete set null;

alter table public.workspace_invites alter column invited_by drop not null;
alter table public.workspace_invites drop constraint workspace_invites_invited_by_fkey;
alter table public.workspace_invites
  add constraint workspace_invites_invited_by_fkey
  foreign key (invited_by) references public.profiles (id) on delete set null;

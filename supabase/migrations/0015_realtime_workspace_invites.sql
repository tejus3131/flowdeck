-- 0015: workspace_invites in the realtime publication.
--
-- The workspace stream binds postgres_changes on workspace_invites, but the
-- table was never added to supabase_realtime — the same silent killer 0009
-- fixed for board_access: the binding is rejected AFTER the join reply as a
-- `system` error, the channel reports SUBSCRIBED, and invite events never
-- flow. Durability for invite sent/revoked/accepted then rested entirely on
-- the relay + the 20s refresh poll.
alter publication supabase_realtime add table public.workspace_invites;

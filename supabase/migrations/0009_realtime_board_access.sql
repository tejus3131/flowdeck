-- 0009: board_access must be in the realtime publication.
--
-- The board live channel subscribes to board_access changes (view→edit
-- overrides re-shape what RLS lets a viewer see), but the table was never
-- added to supabase_realtime. The realtime server rejects the binding
-- AFTER the join reply ("Unable to subscribe to changes with given
-- parameters…") — and that one bad binding silently kills the channel's
-- ENTIRE postgres_changes delivery: the channel still reports SUBSCRIBED,
-- no events ever arrive, and the sync engine's echoes never retire ops
-- ("Couldn't add that list/card" on writes that actually persisted).

alter publication supabase_realtime add table public.board_access;

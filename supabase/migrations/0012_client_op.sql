-- 0012: client_op — an identity stamp for provisional (broadcast) creates.
--
-- The board page relays ops peer-to-peer through the realtime channel so
-- other viewers see changes instantly, while the database echo remains
-- the source of truth. A provisional CREATE needs to retire exactly when
-- its durable row lands (and swap the temp id for the real one); matching
-- by name collides with legitimate duplicates, so every row carries the
-- op id its creator stamped it with. Nullable: server-originated rows
-- (MCP, backfill) simply have none.

alter table public.lists add column client_op uuid;
alter table public.cards add column client_op uuid;

create index cards_client_op_idx on public.cards (client_op);
create index lists_client_op_idx on public.lists (client_op);

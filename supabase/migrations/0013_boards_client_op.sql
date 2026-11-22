-- 0013: boards.client_op — the same provisional-create identity stamp the
-- lists and cards got in 0012, for the dashboard's board create/delete ops
-- (relay + echo retirement must match a created board exactly, duplicates
-- of the name included).

alter table public.boards add column client_op uuid;

create index boards_client_op_idx on public.boards (client_op);

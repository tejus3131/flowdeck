-- Task: connections management. Users rename connections and change their
-- permissions from the connections page — api_tokens needs an UPDATE policy
-- (own rows only). Never a route to widen someone else's token.
create policy tokens_update_own on public.api_tokens
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

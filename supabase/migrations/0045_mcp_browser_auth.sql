-- 0045: browser-based MCP authorization (card #16) — OAuth-style with
-- PKCE, per the MCP spec's authorization flow. API keys stay valid
-- (existing clients must not break), but agents no longer need one
-- copy-pasted by hand: the client opens a browser, the user consents in
-- the logged-in app, and the client receives a token.
--
-- Flow:
--   1. client GET <mcp>/.well-known/oauth-protected-resource
--        -> authorization_servers: [<mcp>]
--   2. client GET <mcp>/.well-known/oauth-authorization-server
--        -> authorization_endpoint: <app>/mcp/authorize (consent page)
--        -> token_endpoint:          <mcp>/token
--        -> code_challenge_methods: [S256] (PKCE, required)
--   3. browser: consent page creates a one-time code row (10 min TTL,
--        sha256-stored like the PATs themselves)
--   4. client POST <mcp>/token with code + code_verifier
--        -> S256(verifier) must equal the stored challenge; the code is
--           single-use; a PAT is minted and returned as access_token
--
-- Codes live in mcp_auth_codes; tokens are the same api_tokens rows the
-- profile page mints (so revocation and last-used tracking are shared).

create table public.mcp_auth_codes (
  id               uuid primary key default gen_random_uuid(),
  code_hash        text not null unique,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  client_id        text not null,
  redirect_uri     text not null,
  code_challenge   text not null,
  challenge_method text not null default 'S256' check (challenge_method in ('S256')),
  expires_at       timestamptz not null default now() + interval '10 minutes',
  used_at          timestamptz,
  created_at       timestamptz not null default now()
);

create index mcp_auth_codes_user_idx on public.mcp_auth_codes (user_id, created_at desc);

alter table public.mcp_auth_codes enable row level security;

-- The consent page (logged-in user) creates its own codes. Everything
-- else — lookup, single-use marking — happens in the edge function via
-- the service role, exactly like api_tokens.
create policy mcp_auth_codes_insert_own on public.mcp_auth_codes
  for insert with check (user_id = auth.uid());

create policy mcp_auth_codes_select_own on public.mcp_auth_codes
  for select using (user_id = auth.uid());

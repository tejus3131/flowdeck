// The OAuth authorization-server metadata, at the ORIGIN ROOT — where
// RFC 8414 clients (VS Code among them) look for it.
//
// NOTE: the scanner's glob skips dot-directories, so this file lives in
// `src/routes/well-known/`; vite.config.ts's `toPath` maps it to the real
// `/.well-known/oauth-authorization-server` route path.
//
// Flowdeck's MCP endpoint lives on the Supabase edge
// (…supabase.co/functions/v1/mcp), but that origin's root well-known
// paths are not routable to an edge function, so strict RFC 8414 clients
// could never fetch authorization-server metadata there. The edge
// function's protected-resource metadata therefore advertises THIS app
// origin as the authorization server (authorization_servers), and this
// route is the document they fetch:
//
//   GET https://<app>/.well-known/oauth-authorization-server
//
// The endpoints it points at are absolute: the consent page lives here
// on the app, and the token exchange is proxied through
// <app>/api/mcp/token (same database for mcp_auth_codes and api_tokens
// either way).
import type { APIHandler, APIEvent } from 'filesystem-routing/api';

// The token exchange is proxied through the app too (`/api/mcp/token`
// forwards to the edge function), so no Supabase URL ever appears in
// the flow — users discover, authorize and exchange against this
// origin alone.
export const GET: APIHandler = async (event: APIEvent) => {
  const origin = new URL(event.request.url).origin;
  const body = {
    issuer: origin,
    authorization_endpoint: `${origin}/mcp/authorize`,
    token_endpoint: `${origin}/api/mcp/token`,
    // RFC 7591 dynamic client registration (stateless — PKCE is the
    // client's authentication); the endpoint is proxied at /api/mcp/register.
    registration_endpoint: `${origin}/api/mcp/register`,
    response_types: ['code'],
    grant_types: ['authorization_code'],
    code_challenge_methods: ['S256'],
    // No other directory information: local clients register themselves
    // by redirecting to loopback — RFC 8414 URL fields must be strings
    // when present, so nothing is nulled.
  };
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      // The document is built from the request origin, so a shared cache
      // could otherwise serve one host's metadata under another (apex vs
      // www vs workers.dev previews). Short TTL keeps that self-healing;
      // the edge function's copy is fine at 3600 because its issuer is
      // the fixed APP_ORIGIN env.
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    },
  });
};

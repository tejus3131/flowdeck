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
// on the app, the token exchange stays on the edge function (same
// database for mcp_auth_codes and api_tokens either way).
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
    response_types: ['code'],
    grant_types: ['authorization_code'],
    code_challenge_methods: ['S256'],
    // Directory information: no client registration yet — local
    // clients register themselves by redirecting to loopback.
    registration_endpoint: null,
  };
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    },
  });
};

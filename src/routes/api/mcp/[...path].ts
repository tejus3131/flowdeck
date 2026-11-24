// The public MCP endpoint: a pass-through proxy to the Supabase edge
// function, so users configure `https://<app>/api/mcp` and never see the
// Supabase project ref. Every request method MCP's streamable HTTP uses
// (GET for the SSE stream, POST for JSON-RPC, DELETE to end a session,
// OPTIONS for preflight) forwards verbatim — method, headers
// (Authorization PAT, Mcp-Session-Id, Last-Event-ID), body and query —
// and the upstream Response is returned untouched so SSE streams
// through without buffering.
//
// Discovery and OAuth ride the same path: /api/mcp/.well-known/* and
// /api/mcp/token are proxied too, so a client only ever learns the app
// origin (the edge function's metadata advertises THIS path via
// MCP_PUBLIC_URL, and the app's /.well-known/oauth-authorization-server
// points token_endpoint at `<origin>/api/mcp/token`).
//
// Notes:
// - The bare `/api/mcp` root is handled by index.ts next to this file —
//   radix3's `**` catch-all doesn't match an empty remainder.
// - The direct Supabase URL keeps working as a fallback entry point.
// - Rate limiting upstream keys off the last X-Forwarded-For hop, which
//   through this proxy is a Cloudflare IP — proxied traffic shares
//   per-Cloudflare-IP buckets (many IPs, spread out; acceptable at this
//   scale). A shared-secret header for per-client-IP limiting through
//   the proxy is a documented follow-up if abuse appears.
import type { APIEvent, APIHandler } from 'filesystem-routing/api';
import { forwardMcp } from '../../../server/mcp-proxy';

function forward(event: APIEvent): Promise<Response> {
  const rest = event.params?.['path'];
  const suffix = (Array.isArray(rest) ? rest.join('/') : String(rest ?? '')).replace(/^\/+/, '');
  return forwardMcp(event, `/${suffix}`);
}

export const GET: APIHandler = (event) => forward(event);
export const POST: APIHandler = (event) => forward(event);
export const PUT: APIHandler = (event) => forward(event);
export const PATCH: APIHandler = (event) => forward(event);
export const DELETE: APIHandler = (event) => forward(event);
export const OPTIONS: APIHandler = (event) => forward(event);

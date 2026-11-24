// Shared forwarder for the MCP proxy routes
// (src/routes/api/mcp/index.ts and [...path].ts): streams the incoming
// request to the Supabase edge function verbatim and hands the upstream
// Response straight back so SSE never buffers.
import type { APIEvent } from 'filesystem-routing/api';
import { env } from 'virtual:solid-env/server';

/** Forwards the request to `<SUPABASE_URL>/functions/v1/mcp/<suffix>`. */
export function forwardMcp(event: APIEvent, suffix: string): Promise<Response> {
  const incoming = new URL(event.request.url);
  const upstream = `${env.SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/mcp${suffix}${incoming.search}`;
  // `new Request(dest, event.request)` carries method, headers and the
  // body stream over and points Host at the upstream origin.
  return fetch(new Request(upstream, event.request));
}

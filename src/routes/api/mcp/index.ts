// The MCP endpoint ROOT (`/api/mcp`) — MCP's streamable HTTP POSTs its
// JSON-RPC messages and opens its SSE stream at exactly this URL, so it
// needs its own route next to the [...path] catch-all (radix3's `**`
// doesn't match an empty remainder). See [...path].ts for the proxy's
// design notes.
import type { APIHandler } from 'filesystem-routing/api';
import { forwardMcp } from '../../../server/mcp-proxy';

export const GET: APIHandler = (event) => forwardMcp(event, '');
export const POST: APIHandler = (event) => forwardMcp(event, '');
export const PUT: APIHandler = (event) => forwardMcp(event, '');
export const PATCH: APIHandler = (event) => forwardMcp(event, '');
export const DELETE: APIHandler = (event) => forwardMcp(event, '');
export const OPTIONS: APIHandler = (event) => forwardMcp(event, '');

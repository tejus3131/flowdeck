// TEMPORARY probe: can this runtime open an outbound WebSocket to the
// Supabase realtime endpoint? Answers {ok, detail} — answers the
// "does realtime work on this host" question in one request.
import type { APIHandler } from 'filesystem-routing/api';
import { env } from 'virtual:solid-env/server';

export const GET: APIHandler = async () => {
  const http = env.SUPABASE_URL.replace(/\/$/, '');
  const url = `${http.replace(/^http/, 'ws')}/realtime/v1/websocket?vsn=1.0.0`;
  const outcome = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    let settled = false;
    try {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch { /* noop */ }
          resolve({ ok: false, detail: 'timeout after 5s' });
        }
      }, 5000);
      ws.addEventListener('open', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          ws.close();
          resolve({ ok: true, detail: 'opened' });
        }
      });
      ws.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, detail: 'error event' });
        }
      });
      ws.addEventListener('close', (event) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, detail: `closed: code=${event.code} reason=${event.reason}` });
        }
      });
    } catch (error) {
      resolve({ ok: false, detail: `threw: ${String(error)}` });
    }
  });
  return Response.json({ url, ...outcome });
};

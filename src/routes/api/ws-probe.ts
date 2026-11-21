// TEMPORARY probe: can workerd dev open an outbound WebSocket to the local
// Supabase realtime endpoint? Answers {ok, detail} — removed after debugging.
import type { APIHandler } from 'filesystem-routing/api';

export const GET: APIHandler = async () => {
  const url = 'ws://127.0.0.1:54321/realtime/v1/websocket?vsn=1.0.0';
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

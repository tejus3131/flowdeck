// The server middleware chain (wired via `start.middleware` in
// vite.config.ts). Each function is `(event, next) => Response`: the request
// is `event.request`, and `next()` takes no arguments — assign
// `event.request` before calling it to hand a different request downstream.
// Per-request render inputs (`event.nonce`, `event.renderMode`) go on the
// event before `next()` too, since the page render runs inside it. The chain
// fronts every request the server dispatches — page renders, server function
// calls, and API routes alike — and runs inside the request-event scope, so
// getRequestEvent() and the session helpers work here exactly as in
// application code.
import type { StartMiddleware } from '@solidjs/vite-plugin';
import { createAPIHandler } from 'filesystem-routing/api';
import routes from 'virtual:file-routes';
import { env } from 'virtual:solid-env/server';

// The first-party PostHog proxy (docs/posthog.md): the browser SDK points
// at OUR origin, and this leg forwards the SDK's /ingest/* (capture,
// flags, replays) and /static/* (recorder assets) paths to PostHog —
// a same-domain path beats the ad-blocker blocklists that match
// *.posthog.com. A dumb pipe: no header or body munging, and a failed
// upstream surfaces the upstream's own response.
const POSTHOG_UPSTREAM = env.POSTHOG_HOST ?? 'https://us.i.posthog.com';

const posthogProxy: StartMiddleware = async (event, next) => {
  const url = new URL(event.request.url);
  const proxied =
    url.pathname === '/ingest' ||
    url.pathname.startsWith('/ingest/') ||
    url.pathname.startsWith('/static/');
  if (!proxied) return next();
  const target = new URL(url.pathname + url.search, POSTHOG_UPSTREAM);
  return fetch(new Request(target, event.request));
};

// createAPIHandler serves the GET/POST/... exports of route modules
// (see src/routes/api) and passes everything else down the chain. It takes
// the request event directly and hands that same event to the handler, with
// the matched params written onto it.
export default [posthogProxy, createAPIHandler(routes)] satisfies StartMiddleware[];

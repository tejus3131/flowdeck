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
// at OUR origin, and this leg forwards ONLY the SDK's known endpoint
// families to PostHog — a same-domain path beats the ad-blocker blocklists
// that match *.posthog.com.
//
// Two hard constraints:
//  * Session safety — the browser sends this request with the app's own
//    cookies (the Supabase session JWT among them) and auth headers.
//    NOTHING from those reaches upstream: only Content-Type is forwarded
//    (the SDK needs it for JSON bodies; replay uploads differ). The
//    response is returned as-is but with any upstream Set-Cookie stripped —
//    PostHog must never be able to write cookies on our origin either.
//  * Not a generic relay — an unmatched path under /ingest is a 404, not a
//    forward. The list below is the SDK's endpoint surface (posthog-js
//    appends these to its api_host): event ingest, batch, decide, client
//    flag evaluation, session-replay and the v1 ingest API, surveys, and
//    the /static/* loader assets.
const POSTHOG_UPSTREAM = env.POSTHOG_HOST ?? 'https://us.i.posthog.com';

const PROXIED_ENDPOINTS = [
  'e', // event capture (incl. $exception)
  'batch',
  'decide',
  'flags', // client-side flag evaluation (?v=2)
  's', // session recording uploads and replays
  'i/v0', // the v1 ingest API
  'surveys',
  'trackers',
] as const;

/** Allowed headers forwarded upstream — everything else is dropped. */
const FORWARDED_HEADERS = ['content-type'] as const;

// Best-effort per-IP rate limit. Worker isolates don't share memory, so
// this caps per-isolate abuse, not a global ceiling — Cloudflare's own
// DDoS layer remains the real backstop. 120/min is ~10x a healthy client.
const RATE_LIMIT_REQUESTS = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
let rateWindowStart = 0;
const rateCounts = new Map<string, number>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  if (now - rateWindowStart >= RATE_LIMIT_WINDOW_MS) {
    rateWindowStart = now;
    rateCounts.clear();
  }
  const count = (rateCounts.get(ip) ?? 0) + 1;
  rateCounts.set(ip, count);
  return count > RATE_LIMIT_REQUESTS;
}

function proxiedPosthogPath(pathname: string): string | null {
  if (!pathname.startsWith('/ingest')) return null;
  const rest = pathname.slice('/ingest'.length);
  if (!rest.startsWith('/')) return null; // '/ingest' itself is not an endpoint
  for (const endpoint of PROXIED_ENDPOINTS) {
    if (rest === `/${endpoint}` || rest.startsWith(`/${endpoint}/`)) return rest;
  }
  return null;
}

const posthogProxy: StartMiddleware = async (event, next) => {
  const url = new URL(event.request.url);
  const upstreamPath = proxiedPosthogPath(url.pathname);
  // /static/* are the SDK's loader assets (array.js et al).
  const isStatic = url.pathname.startsWith('/static/');
  if (!upstreamPath && !isStatic) return next();

  const ip = event.request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (rateLimited(ip)) return new Response('Too Many Requests', { status: 429 });

  const target = new URL((upstreamPath ?? url.pathname) + url.search, POSTHOG_UPSTREAM);
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = event.request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const response = await fetch(
    new Request(target, {
      method: event.request.method,
      headers,
      body:
        event.request.method === 'GET' || event.request.method === 'HEAD'
          ? undefined
          : event.request.body,
      // Undici/workerd refetch semantics: a GET with no body streams fine;
      // duplicating is safe for replayed bodies.
      duplex: 'half',
    } as RequestInit),
  );

  // Strip upstream Set-Cookie: PostHog never writes cookies on our origin.
  const clean = new Headers(response.headers);
  clean.delete('set-cookie');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: clean,
  });
};

// createAPIHandler serves the GET/POST/... exports of route modules
// (see src/routes/api) and passes everything else down the chain. It takes
// the request event directly and hands that same event to the handler, with
// the matched params written onto it.
export default [posthogProxy, createAPIHandler(routes)] satisfies StartMiddleware[];

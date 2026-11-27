// The playground's server-side access check (ADR-17 amendment,
// 2026-11-27): access is ENVIRONMENT-gated, not flag-gated. The preview
// deployment IS the developer cohort (already behind Cloudflare
// Access), and VITE_APP_ENV is baked into the build — so no runtime
// failure (missing config, PostHog outage, quota) can open the gate,
// and production always 404s. Every /playground route runs this in
// preload — the first code that touches a playground request — and the
// client shell reads the SAME baked decision, so server output and
// hydration agree by construction. The response carries
// X-Robots-Tag: noindex as crawler hygiene, not security.
import { httpStatus, getRequestEvent } from '@solidjs/web';

import { env } from 'virtual:solid-env/client';

/** The pure decision — exported for tests. `appEnv` is the build's
 *  VITE_APP_ENV ('preview' | 'production' | undefined), `dev` is
 *  import.meta.env.DEV (the local dev server only).
 *
 *  * preview → allow (the Cloudflare Access-gated developer cohort)
 *  * production or absent (PR CI builds, any misbuild) → deny — fail
 *    closed, the app's normal 404
 *  * local dev → allow (nothing ever ships from `pnpm dev`) */
export function playgroundAccess(appEnv: string | undefined, dev: boolean): boolean {
  return dev || appEnv === 'preview';
}

/** What the routes and the shell call — this build's baked values. */
export function playgroundEnabled(): boolean {
  return playgroundAccess(env.VITE_APP_ENV, import.meta.env.DEV);
}

/** Every playground route's preload: the server-side gate. */
export async function playgroundPreload(): Promise<void> {
  const event = getRequestEvent();
  // Crawler hygiene — applies to the gallery AND its denial response.
  event?.response.headers.append('X-Robots-Tag', 'noindex');
  if (!playgroundEnabled()) httpStatus(404);
}

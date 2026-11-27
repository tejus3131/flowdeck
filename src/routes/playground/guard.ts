// The playground's server-side access check (the flag contract's
// permission decision, ADR-17): every /playground route runs this in
// preload — the first code that touches a playground request — and a
// denied or FAILED evaluation (missing config, timeout, quota) fails
// closed to the app's normal 404. Client flags are never trusted, the
// flag never gates data (RLS does), and the response carries
// X-Robots-Tag: noindex as crawler hygiene, not security.
import { httpStatus, getRequestEvent } from '@solidjs/web';

import { flagValue, getFlagSnapshot, type FlagSnapshot } from '../../lib/flags/snapshot';

/** The pure decision — exported for tests. */
export function playgroundAccess(snapshot: FlagSnapshot | undefined): boolean {
  // flagValue serves the declared fallback while the snapshot is still
  // pending — deny (the registry's fallback for this permission flag).
  return flagValue(snapshot, 'playground-access');
}

/** Every playground route's preload: the server-side gate. */
export async function playgroundPreload(): Promise<void> {
  const event = getRequestEvent();
  // Crawler hygiene — applies to the gallery AND its denial response.
  event?.response.headers.append('X-Robots-Tag', 'noindex');
  const snapshot = await getFlagSnapshot();
  if (!playgroundAccess(snapshot)) httpStatus(404);
}

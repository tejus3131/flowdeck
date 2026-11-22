// The instant half of "mark read": marking is applied to an in-memory set
// the moment it's clicked, and the server write follows under it. The
// live inbox confirms a beat later; the overlay just becomes redundant.
// (Same pattern as lib/seen.ts — the version signal re-runs every read.)
import { createSignal } from 'solid-js';

import type { NotificationRow } from './notifications';

const [version, setVersion] = createSignal(0, { equals: false });
const seenIds = new Set<string>();

/** Mark rows optimistically seen (ids are safe to repeat). */
export function markSeenOptimistic(...ids: (string | null | undefined)[]): void {
  let changed = false;
  for (const id of ids) {
    if (id && !seenIds.has(id)) {
      seenIds.add(id);
      changed = true;
    }
  }
  if (changed) setVersion(version() + 1);
}

/** A row's effective read state: server value OR the optimistic overlay. */
export function isRowSeen(row: Pick<NotificationRow, 'id' | 'seen_at'>): boolean {
  version(); // track: optimistic marks re-run this
  return Boolean(row.seen_at) || seenIds.has(row.id);
}

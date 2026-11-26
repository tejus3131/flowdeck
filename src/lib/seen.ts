// Per-device "seen" tracking for card activity: how many of a card's
// comments this viewer has already seen. Powers the unseen-comment badge
// on cards (the board snapshot carries the total; this map carries the
// seen count, so the badge shows exactly what's NEW — not the total).
//
// Keys are stored per card row id AND per "op:<client_op>" — a card's
// stable identity, so the marker survives the provisional→durable id
// swap when a card is opened mid-relay.
//
// A module-level version signal makes the map reactive: marking a card
// seen re-runs every open computation reading unseenCount(), so the badge
// clears the moment the drawer opens.
import { createSignal } from 'solid-js';

const KEY = 'flowdeck:comments-seen';

type SeenMap = Record<string, number | string>;

// One per-page-load cache of the persisted map.
let cache: SeenMap | null = null;
const [version, setVersion] = createSignal(0, { equals: false });

function readMap(): SeenMap {
  cache ??= (() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '{}') as SeenMap;
    } catch {
      return {};
    }
  })();
  return cache;
}

function writeMap(map: SeenMap): void {
  cache = map;
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Best effort — a lost marker just means the badge shows once more.
  }
  setVersion(version() + 1);
}

/** The stable-identity key for a card (null when the row has no stamp). */
const opKey = (clientOp: string | null | undefined) => (clientOp ? `op:${clientOp}` : null);

/** The highest seen-count recorded for the card under any of its keys.
 *  Returns -1 when nothing numeric is recorded (legacy timestamps or a
 *  card never opened). */
function seenCountOf(keys: (string | null | undefined)[]): number {
  let best = -1;
  for (const key of keys) {
    if (!key) continue;
    const value = readMap()[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      best = Math.max(best, value);
    }
  }
  return best;
}

/** How many of this card's comments this device has NOT seen yet. */
export function unseenCount(card: {
  id: string;
  client_op?: string | null;
  comment_count: number;
}): number {
  version(); // track: markSeen bumps this
  const seen = seenCountOf([card.id, opKey(card.client_op)]);
  const effective = seen < 0 ? 0 : seen;
  return Math.max(0, (card.comment_count ?? 0) - effective);
}

/** Record that the viewer has seen this many of the card's comments. */
export function markSeen(cardId: string, count: number, clientOp?: string | null): void {
  const map = { ...readMap() };
  let changed = false;
  for (const key of [cardId, opKey(clientOp)]) {
    if (!key) continue;
    const prev = typeof map[key] === 'number' ? (map[key] as number) : 0;
    if (prev < count) {
      map[key] = count;
      changed = true;
    }
  }
  if (changed) writeMap(map);
}

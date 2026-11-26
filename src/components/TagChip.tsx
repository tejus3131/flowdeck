// One tag chip — the L5 worked example from docs/layers/l5-views.md: the
// name resolves from the entity store (L2), so a rename re-renders every
// chip in the same frame it lands, with zero refetches. The chip has no
// idea how the name arrived — that is the whole point.
//
// `fallbackName` covers the two moments the store cannot have the row
// yet: a cold paint before any snapshot carrying the tag has merged, and
// SSR of a cache miss. It is a display fallback, never a second source
// of truth — the store wins the moment it has the row.
import type { JSX } from '@solidjs/web';

import { useEntities } from '../lib/entity-store';

const FACE =
  'rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-500/15 dark:text-sky-300';
const DRAWER =
  'inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-500/15 dark:text-sky-300';

export function TagChip(props: {
  tagId: string;
  fallbackName?: string;
  /** `face` (card faces, backlink rows) or `drawer` (the card drawer's
   * removable chips — carries the remove button as children). */
  variant?: 'face' | 'drawer';
  children?: JSX.Element;
}) {
  const entities = useEntities();
  const name = () => entities.tagById(props.tagId)?.name ?? props.fallbackName ?? 'tag';
  return (
    <span class={props.variant === 'drawer' ? DRAWER : FACE}>
      #{name()}
      {props.children}
    </span>
  );
}

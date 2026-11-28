// The playground's synthetic fixtures — NEVER real workspace content.
// The tag rows ride the REAL entity store's write path (writeTags) so
// the production TagChip renders exactly as it does on a board; the
// rows below are invented ids and names.
import { onSettled } from 'solid-js';
import { createEntityStore, EntityContext } from '../../lib/entity-store';
import type { TagRow } from '../../lib/board-fold';
import type { JSX } from '@solidjs/web';

export const SYNTHETIC_WORKSPACE_ID = '00000000-0000-0000-0000-0000000000fd';

export const SYNTHETIC_TAGS: TagRow[] = [
  { id: 'fd-fixture-tag-1', name: 'design', description: null },
  { id: 'fd-fixture-tag-2', name: 'backend', description: null },
  { id: 'fd-fixture-tag-3', name: 'needs-review', description: null },
];

/** A playground-scoped entity store seeded with the synthetic rows —
 *  the app's own store is never touched (gallery selection stays local,
 *  and no production surface can read fixture rows). */
export function createSeededEntities() {
  const entities = createEntityStore();
  entities.writeTags(SYNTHETIC_WORKSPACE_ID, SYNTHETIC_TAGS);
  return entities;
}

/** Wrap gallery content in the seeded store so REAL components that read
 *  selectors (TagChip) render against synthetic entities. The seed
 *  write lands on settle (component bodies never write reactive state —
 *  Solid 2.0), and the chips' `fallbackName` carries the first paint —
 *  exactly the cold-paint → store-lands behavior a real surface has. */
export function FixtureContext(props: { children: JSX.Element }) {
  const entities = createEntityStore();
  onSettled(() => {
    entities.writeTags(SYNTHETIC_WORKSPACE_ID, SYNTHETIC_TAGS);
  });
  return <EntityContext value={entities}>{props.children}</EntityContext>;
}

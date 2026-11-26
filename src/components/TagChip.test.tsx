// TagChip tests — the chip reads its name from the entity store (L2), so
// the canonical test's view half holds here: ONE store write, every chip
// on screen re-renders; no refetch, no remount, no prop change.
import { describe, expect, it } from 'vitest';
import { render } from '@solidjs/testing-library';
import { flush } from 'solid-js';

import { TagChip } from './TagChip';
import { EntityContext, createEntityStore } from '../lib/entity-store';

/** The chip under the app's provider, plus the store driving it. */
function harness() {
  const store = createEntityStore();
  const utils = render(() => (
    <EntityContext value={store}>
      <TagChip tagId="t1" fallbackName="old" />
    </EntityContext>
  ));
  return { store, ...utils };
}

describe('TagChip', () => {
  it('renders the store row over the fallback once one exists', () => {
    const h = harness();
    // Nothing in the store yet: the embedded fallback name paints.
    expect(h.container.textContent).toContain('#old');

    h.store.writeTags('ws1', [{ id: 't1', name: 'urgent' }]);
    flush();
    expect(h.container.textContent).toContain('#urgent');
    expect(h.container.textContent).not.toContain('#old');
    h.unmount();
  });

  it('a rename is one store write — the chip re-renders in the same pass', () => {
    const h = harness();
    h.store.writeTags('ws1', [{ id: 't1', name: 'old' }]);
    flush();
    expect(h.container.textContent).toContain('#old');

    h.store.writeTags('ws1', [{ id: 't1', name: 'renamed' }]);
    flush();
    expect(h.container.textContent).toContain('#renamed');
    expect(h.container.textContent).not.toContain('#old');
    h.unmount();
  });

  it('falls back to the embedded name when the store never saw the tag', () => {
    const store = createEntityStore();
    const utils = render(() => (
      <EntityContext value={store}>
        <TagChip tagId="unknown" fallbackName="stale-embed" />
      </EntityContext>
    ));
    expect(utils.container.textContent).toContain('#stale-embed');
    utils.unmount();
  });
});

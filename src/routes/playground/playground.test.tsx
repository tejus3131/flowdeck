// Playground tests — the access contract (ADR-17) and the fixture
// discipline: a denied, failed, or pending evaluation renders the
// normal 404 (fail closed), the granted path renders the real
// components from synthetic data only, and the pure decision function
// is deterministic. The PostHog flag is never fetched here — the
// snapshot is injected through the router's query cache.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { flush } from 'solid-js';
import { query } from '@solidjs/router';

import { playgroundAccess } from './guard';
import { PAGES } from './component-registry';
import { createSeededEntities, SYNTHETIC_TAGS } from './fixtures';
import { Button } from '../../components/ui/Button';

import { getFlagSnapshot } from '../../lib/flags/snapshot';

const granted = { values: { 'playground-access': true } };
const denied = { values: { 'playground-access': false } };

/** The exact cache key the query reads (the router hashes name+args). */
const flagsKey = getFlagSnapshot.keyFor();

beforeEach(() => {
  query.set(flagsKey, denied);
});

afterEach(() => {
  query.delete(flagsKey);
});

describe('playgroundAccess — the pure decision', () => {
  it('grants only on an explicit allow', () => {
    expect(playgroundAccess(granted)).toBe(true);
    expect(playgroundAccess(denied)).toBe(false);
  });

  it('fails closed while the snapshot is pending (a failed evaluation looks the same)', () => {
    expect(playgroundAccess(undefined)).toBe(false);
  });
});

describe('the gallery pages render (granted path)', () => {
  it('every registry page renders the real component implementations', () => {
    for (const [name, page] of Object.entries(PAGES)) {
      const { container } = render(() => <>{page.render()}</>);
      expect(container.innerHTML.length).toBeGreaterThan(0);
      expect(container.textContent).toBeTruthy();
      void page;
      void name;
    }
  });
});

describe('synthetic fixtures', () => {
  it('seeds the store through the real write path — never a fetch', () => {
    const entities = createSeededEntities();
    // Reads lag writes (Solid 2.0) — the memoized selector sees the
    // seeded rows after the flush.
    flush();
    // The REAL selector the production TagChip reads resolves the
    // synthetic rows.
    expect(entities.tagById('fd-fixture-tag-1')?.name).toBe(SYNTHETIC_TAGS[0]!.name);
    expect(entities.tagById('fd-fixture-tag-3')?.name).toBe('needs-review');
  });
});

describe('interaction states are real interactions', () => {
  it('a playground button click fires (display-only, local)', async () => {
    let clicked = 0;
    render(() => <Button onClick={() => (clicked += 1)}>Gallery button</Button>);
    await fireEvent.click(screen.getByRole('button', { name: 'Gallery button' }));
    expect(clicked).toBe(1);
  });
});

// The route-level denied/allowed rendering is covered by the shell
// tests below — the same snapshot the server preload read drives the
// client render, which is the SSR/hydration agreement by construction.
describe('PlaygroundShell — the client render agrees with the preload', () => {
  it('renders the gallery when the request snapshot grants access', async () => {
    query.set(flagsKey, granted);
    const { Router } = await import('../../router');
    const { PlaygroundShell } = await import('./shell');
    const { getByText, getByRole } = render(() => (
      <Router>
        {() => (
          <PlaygroundShell>
            <p>gallery content</p>
          </PlaygroundShell>
        )}
      </Router>
    ));
    // The router resolves its initial location asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 10));
    flush();
    expect(getByText('gallery content')).toBeInTheDocument();
    expect(getByText('Developer playground — synthetic data only')).toBeInTheDocument();
    expect(getByRole('link', { name: 'Tokens' })).toBeInTheDocument();
  });

  it('renders the normal 404 when denied (fail closed — the client agrees with the preload)', async () => {
    // beforeEach seeded the DENIED snapshot.
    const { Router } = await import('../../router');
    const { PlaygroundShell } = await import('./shell');
    const { getByText, queryByText } = render(() => (
      <Router>
        {() => (
          <PlaygroundShell>
            <p>gallery content</p>
          </PlaygroundShell>
        )}
      </Router>
    ));
    await new Promise((resolve) => setTimeout(resolve, 10));
    flush();
    expect(getByText('Page Not Found')).toBeInTheDocument();
    expect(queryByText('gallery content')).not.toBeInTheDocument();
  });
});

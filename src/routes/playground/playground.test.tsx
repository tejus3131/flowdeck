// Playground tests — the access contract (ADR-17 amendment:
// environment gating, not flags) and the fixture discipline. The
// decision is pure — baked build values in, a boolean out — so
// production (and any build without VITE_APP_ENV=preview) fails closed
// to the normal 404. No PostHog call, no snapshot mock: the gate has
// no runtime dependency left to mock.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { flush } from 'solid-js';

import { playgroundAccess, playgroundEnabled } from './guard';
import { PAGES } from './component-registry';
import { createSeededEntities, SYNTHETIC_TAGS } from './fixtures';
import { Button } from '../../components/ui/Button';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('playgroundAccess — the pure decision', () => {
  it('allows the preview deployment (the developer cohort)', () => {
    expect(playgroundAccess('preview', false)).toBe(true);
  });

  it('denies production — always the normal 404 there', () => {
    expect(playgroundAccess('production', false)).toBe(false);
  });

  it('fails closed when the env is absent (PR CI builds, a misbuild)', () => {
    expect(playgroundAccess(undefined, false)).toBe(false);
  });

  it('allows local dev — nothing ever ships from pnpm dev', () => {
    expect(playgroundAccess(undefined, true)).toBe(true);
  });

  it('wires the build values — vitest runs as dev mode with no env', () => {
    // The test environment IS the dev-mode allow: DEV=true, env absent.
    expect(playgroundEnabled()).toBe(true);
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

// The route-level allowed/denied rendering: the shell reads the same
// build-baked decision the preload read — SSR output and hydration
// agree by construction (there is no second evaluation to diverge).
describe('PlaygroundShell — the client render agrees with the preload', () => {
  it('renders the gallery in the dev cohort (vitest runs as DEV)', async () => {
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
    // The router resolves its initial location asynchronously — wait for
    // the content, not the clock.
    await waitFor(() => expect(getByText('gallery content')).toBeInTheDocument());
    expect(getByText('Developer playground — synthetic data only')).toBeInTheDocument();
    expect(getByRole('link', { name: 'Tokens' })).toBeInTheDocument();
  });

  it('renders the normal 404 outside the cohort (fail closed)', async () => {
    // A production-shaped environment: DEV off, env not preview.
    vi.stubEnv('DEV', false);
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
    await waitFor(() => expect(getByText('Page Not Found')).toBeInTheDocument());
    expect(queryByText('gallery content')).not.toBeInTheDocument();
  });
});

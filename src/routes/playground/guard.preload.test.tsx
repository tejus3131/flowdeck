// @vitest-environment node
// The SERVER half of the playground gate (the security-relevant leg —
// the client <Show> is belt-and-braces): every route's preload runs
// playgroundPreload, which must set X-Robots-Tag: noindex on BOTH
// outcomes and 404 the production-shaped environment. Node environment
// because the response stub and httpStatus live on the server posture
// of @solidjs/web.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequestEvent, type RequestEvent } from '@solidjs/web';

import { playgroundPreload } from './guard';

// The request scope is the framework's AsyncLocalStorage under a
// Symbol.for key (the deliberate global contract getRequestEvent reads;
// the documented `provideRequestEvent` helper hasn't shipped). The test
// establishes the same scope so the preload's httpStatus/header writes
// land on a real response stub.
const requestScope = new AsyncLocalStorage<RequestEvent>();
beforeAll(() => {
  (globalThis as Record<symbol, unknown>)[Symbol.for('solid.RequestContext')] = requestScope;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Run the preload inside a request scope and return the event. */
async function preloadInRequestScope(): Promise<RequestEvent> {
  const event = createRequestEvent(new Request('https://flowdeck.test/playground'));
  await requestScope.run(event, () => playgroundPreload());
  return event;
}

describe('playgroundPreload — the server-side gate', () => {
  it('404s a production-shaped environment before anything renders', async () => {
    // DEV off (a build), env not preview — the production shape.
    vi.stubEnv('DEV', false);
    const event = await preloadInRequestScope();
    // httpStatus(404) lands on the request event's response head.
    expect(event.response.status).toBe(404);
    expect(event.response.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('keeps noindex on the ALLOWED path too (crawler hygiene either way)', async () => {
    // Vitest runs as dev mode — the allowed shape.
    const event = await preloadInRequestScope();
    expect(event.response.status).toBeUndefined();
    expect(event.response.headers.get('x-robots-tag')).toBe('noindex');
  });
});

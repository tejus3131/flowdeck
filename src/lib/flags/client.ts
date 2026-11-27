// The browser half of the flag runtime: the posthog-js identity and
// flag-context lifecycle. The SDK INSTANCE is owned by lib/telemetry.ts
// (one posthog-js for flags + telemetry, initialized once with the
// privacy posture); this module owns the flag contract's override rules
// (identify on sign-in, refresh on workspace switch, reset on
// sign-out) and stays the test seam for that lifecycle.
import { isServer } from '@solidjs/web';
import { env } from 'virtual:solid-env/client';

import { telemetryRuntime } from '../telemetry';

/** The structural slice of posthog-js the flag lifecycle drives (and
 *  the seam tests inject). */
export type FlagClient = {
  identify(distinctId: string): void;
  /** Sign-out: clears the distinct ID, stored overrides, and flag state. */
  reset(): void;
  /** Transient per-evaluation overrides — not persisted on the person,
   *  not emitted as a $set event; triggers a flag reload by default. */
  setPersonPropertiesForFlags(properties: Record<string, string>): void;
  /** Clears the overrides WITHOUT reloading — the contract pairs this
   *  with an explicit reloadFeatureFlags(). */
  resetPersonPropertiesForFlags(): void;
  reloadFeatureFlags(): void;
};

let testOverride: FlagClient | null = null;

/** The app's single posthog-js instance (flags + telemetry), or null
 *  when flags have no client runtime (SSR, local dev, or a build without
 *  the public env values — the server snapshot still resolves). */
export function flagClient(): FlagClient | null {
  if (testOverride) return testOverride;
  // No VITE_POSTHOG_HOST: the shared runtime (lib/telemetry.ts) talks to
  // OUR origin — the worker's /ingest proxy forwards to PostHog
  // (docs/posthog.md), past the ad-blocker lists that match *.posthog.com.
  if (isServer || !env.VITE_POSTHOG_KEY) return null;
  // The shared runtime (lib/telemetry.ts) owns the instance: it talks to
  // OUR origin under /ingest — the worker's allowlisted proxy forwards
  // to PostHog (docs/posthog.md), past the ad-blocker lists that match
  // *.posthog.com.
  return telemetryRuntime();
}

/** The identity/workspace state FlagSync feeds the client each turn. */
export type FlagSyncState = {
  userId: string | null;
  workspaceId: string | null;
};

/** Drive the client SDK through an identity/workspace transition (the
 *  contract's override lifecycle):
 *  - sign-in / account switch → identify (the stable user UUID is the
 *    PostHog distinct ID — never email);
 *  - workspace switch → setPersonPropertiesForFlags (reloads by default);
 *  - workspace cleared while signed in → resetPersonPropertiesForFlags
 *    + an explicit reload (the web SDK does not reload on reset);
 *  - sign-out → reset (identity, overrides, and cached flag state).
 *  `prev === undefined` is the hydration run: the SDK initialized with
 *  the page, so we still seed identity/context but never churn reloads
 *  for an unchanged state. */
export function syncFlagClient(prev: FlagSyncState | undefined, next: FlagSyncState): void {
  const client = flagClient();
  if (!client) return;
  const userChanged = prev === undefined || prev.userId !== next.userId;
  if (next.userId === null) {
    // First run while signed out has nothing to clear; a real sign-out
    // (prev had a user) resets the whole client state.
    if (prev !== undefined && prev.userId !== null) client.reset();
    return;
  }
  if (userChanged) client.identify(next.userId);
  const workspaceChanged = userChanged || prev.workspaceId !== next.workspaceId;
  if (!workspaceChanged) return;
  if (next.workspaceId) {
    client.setPersonPropertiesForFlags({ flowdeck_workspace_id: next.workspaceId });
  } else {
    client.resetPersonPropertiesForFlags();
    client.reloadFeatureFlags();
  }
}

/** Test seam: drive the lifecycle with a deterministic fake. */
export function setFlagClientForTests(fake: FlagClient | null): void {
  testOverride = fake;
}

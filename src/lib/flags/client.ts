// The browser half of the flag runtime: one posthog-js instance whose
// only job in the foundation is identity and flag context — the person-
// property override lifecycle from the flag contract (identify on
// sign-in, refresh on workspace switch, reset on sign-out). Telemetry
// (events, replays, autocapture) is deliberately OFF here; the
// observability sink turns capture on with its privacy config.
import posthog from 'posthog-js';
import { isServer } from '@solidjs/web';
import { env } from 'virtual:solid-env/client';

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

let instance: FlagClient | null = null;
let testOverride: FlagClient | null = null;

/** The app's single posthog-js instance, or null when flags have no
 *  client runtime (SSR, local dev without PostHog, or a build without
 *  the public env values — the server snapshot still resolves). */
export function flagClient(): FlagClient | null {
  if (testOverride) return testOverride;
  if (isServer || !env.VITE_POSTHOG_KEY) return null;
  if (!instance) {
    posthog.init(env.VITE_POSTHOG_KEY, {
      // First-party: the SDK talks to OUR origin — the worker's
      // /ingest proxy forwards to PostHog (docs/posthog.md) — so
      // telemetry rides a same-domain path past the ad-blocker
      // blocklists that match *.posthog.com.
      api_host: window.location.origin,
      // Flags only: this PR must not start sending telemetry anywhere.
      // The sink PR enables capture with the privacy config (masking,
      // replay sampling) decided there.
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
    });
    instance = posthog as unknown as FlagClient;
  }
  return instance;
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
  instance = null;
}

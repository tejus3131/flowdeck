// The flag runtime's sync component: keeps the posthog-js identity and
// the workspace person-property override in step with the app (the flag
// contract's override lifecycle), and refreshes the server snapshot so
// `flag()` re-reads against the new context. Mirrors ThemeSync's shape:
// a client-only null renderer mounted once in App.
import { revalidate } from '@solidjs/router';
import { createEffect, createMemo, onSettled } from 'solid-js';

import type { MeProfile } from '../lib/auth';
import { syncFlagClient, type FlagSyncState } from '../lib/flags/client';
import { FLAGS } from '../lib/flags/registry';
import { setAuthStateForTelemetry, startTelemetry } from '../lib/telemetry';
import { getMyWorkspaces } from '../lib/workspaces';

export function FlagSync(props: { me: () => MeProfile | null }) {
  // The same request-scoped query WorkspaceSwitcher reads — no extra
  // fetch, and the workspace list is already serialized for hydration.
  const workspaces = createMemo(() => getMyWorkspaces());

  // The telemetry sinks (perf marks + cache counters → minute buckets)
  // start once per app load; FlagSync owns their teardown, and the
  // auth-state accessor rides the same identity lifecycle as the flags.
  onSettled(() => {
    setAuthStateForTelemetry(() => !!props.me());
    // null = no client runtime (dev, SSR): nothing to tear down.
    return startTelemetry() ?? undefined;
  });

  const state = (): FlagSyncState => ({
    userId: props.me()?.id ?? null,
    workspaceId: workspaces().find((w) => w.current)?.id ?? null,
  });

  createEffect(
    () => state(),
    (next, prev) => {
      syncFlagClient(prev, next);
      // After the context changed, re-evaluate the snapshot on the
      // server (same identity + the new fd_ws cookie) so `flag()` reads
      // fresh values. Skipped on the hydration run — the SSR render
      // already resolved this exact state.
      if (
        prev !== undefined &&
        (prev.userId !== next.userId || prev.workspaceId !== next.workspaceId) &&
        // No-op while the registry is empty — there is no flag whose
        // value could have changed, so don't pay a server round-trip.
        // Self-heals: the first registered flag arms this path again.
        Object.keys(FLAGS).length > 0
      ) {
        revalidate('flags');
      }
    },
  );

  return null;
}

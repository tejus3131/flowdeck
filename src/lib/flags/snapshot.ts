// The request-scoped flag snapshot and the single typed accessor
// (ADR-17). On the server, getFlagSnapshot() resolves the authenticated
// user UUID plus the VERIFIED active workspace, evaluates the registered
// flags ONCE against PostHog, validates every value against the registry,
// and keeps the result in this request's context — the router's query is
// request-scoped on the server, never a module-global Worker cache. The
// same query call on the client returns the value serialized with the
// SSR render, so server output and hydration agree by construction (no
// variant flash, no second evaluation).
import { query } from '@solidjs/router';
import { getRequestEvent } from '@solidjs/web';
import { createMemo, type Accessor } from 'solid-js';
import { env } from 'virtual:solid-env/server';

import { createSupabaseRequestClient } from '../../server/supabase';
import { evaluateAllFlags, type FlagValues } from './evaluate';
import { posthogEvaluateFlags } from './provider';
import { FLAGS, type FlagDef, type FlagKey, type FlagValue } from './registry';

const WORKSPACE_COOKIE = /(?:^|;\s*)fd_ws=([0-9a-f-]{36})/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The workspace the request's cookie names — a CANDIDATE until the
 *  caller's own membership verifies it (never trust the cookie alone:
 *  the flag contract derives the workspace from the verified
 *  relationship, not from an untrusted value). */
export function readWorkspaceCandidate(cookieHeader: string): string | null {
  const match = cookieHeader.match(WORKSPACE_COOKIE);
  return match?.[1] ?? null;
}

/** Resolve the flag identity for THIS request: the authenticated user
 *  UUID (the PostHog distinct ID) and the verified active workspace. */
async function resolveIdentity(): Promise<{ userId: string | null; workspaceId: string | null }> {
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { userId: null, workspaceId: null };

  const candidate = readWorkspaceCandidate(getRequestEvent()?.request.headers.get('cookie') ?? '');
  if (!candidate || !UUID.test(candidate)) return { userId: user.id, workspaceId: null };
  // Verify the caller is a member of the cookie's workspace — RLS shows
  // peer rows too, so the filter is on the caller's own user_id.
  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', candidate)
    .eq('user_id', user.id)
    .maybeSingle();
  return { userId: user.id, workspaceId: data ? candidate : null };
}

export type FlagSnapshot = {
  readonly values: FlagValues;
};

export const getFlagSnapshot = query(async (): Promise<FlagSnapshot> => {
  'use server';
  const identity = await resolveIdentity();
  // Anonymous requests never call PostHog (quota discipline — there is
  // no identity to evaluate against), and neither does a build without
  // PostHog configured (local dev, or a deployment that opts out).
  const host = env.POSTHOG_HOST;
  const token = env.POSTHOG_KEY;
  if (!identity.userId || !host || !token) {
    return { values: evaluateAllFlags(null, { workspaceId: identity.workspaceId }) };
  }
  try {
    const raw = await posthogEvaluateFlags({
      host,
      token,
      distinctId: identity.userId,
      workspaceId: identity.workspaceId,
    });
    return { values: evaluateAllFlags(raw, { workspaceId: identity.workspaceId }) };
  } catch (error) {
    // Provider failure (network, timeout, quota) is an expected state on
    // the free tier — every flag resolves to its declared fallback and
    // the app stays usable. The diagnostic is for Workers Logs.
    console.error('[flags] evaluation failed — serving declared fallbacks:', error);
    return { values: evaluateAllFlags(null, { workspaceId: identity.workspaceId }) };
  }
}, 'flags');

/** The single typed accessor — the ONLY way application code reads a
 *  flag value. Takes the snapshot (observed via useFlags(), or awaited
 *  from getFlagSnapshot() at a server boundary) and selects the typed
 *  value; while the snapshot is still pending it serves the registry
 *  fallback (safe by declaration, never a guess). A component selects a
 *  variant; it never evaluates PostHog or decides how failures are
 *  handled. */
export function flagValue<K extends FlagKey>(
  snapshot: FlagSnapshot | undefined,
  key: K,
): FlagValue<K> {
  // While the snapshot is still pending (a route's guard raced ahead of
  // the evaluation), serve the registry's declared fallback — safe by
  // definition, never a guess.
  return snapshot ? snapshot.values[key] : ((FLAGS[key] as FlagDef).fallback as FlagValue<K>);
}

/** The reactive read for render code: a memo over the same request/
 *  session query every consumer shares (the app's getMe/getMyWorkspaces
 *  idiom — Solid 2.0 unwraps the query's promise, re-runs on
 *  revalidation, and SSR/hydration agree because the router serializes
 *  the value). */
export function useFlags(): Accessor<FlagSnapshot | undefined> {
  return createMemo(() => getFlagSnapshot());
}

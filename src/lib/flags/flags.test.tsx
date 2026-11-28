// Flag runtime tests — the fail-safe contract (ADR-17) in miniature:
// every evaluation state resolves to a DECLARED value. Provider failures,
// unknown variants, and missing workspace context never invent behavior;
// two members of one workspace evaluate with identical context; and the
// client SDK lifecycle follows the override rules (identify on sign-in,
// refresh on workspace switch, reset on sign-out). PostHog fetching is
// never real here — the provider takes an injected fetch and the client
// an injected instance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearFlagDiagnostics,
  evaluateAllFlags,
  resolveFlagDef,
  type FlagContext,
} from './evaluate';
import { posthogEvaluateFlags } from './provider';
import {
  setFlagClientForTests,
  syncFlagClient,
  type FlagClient,
  type FlagSyncState,
} from './client';
import { readWorkspaceCandidate } from './snapshot';
import { FLAGS } from './registry';

beforeEach(() => {
  clearFlagDiagnostics();
});

// ── the registry ──────────────────────────────────────────────────────────

describe('the flag registry', () => {
  it('is deliberately empty — flags register with the PR that consumes them', () => {
    // Playground access is environment-gated (ADR-17's amendment), not a
    // flag; the redesign's release flags arrive with their surfaces.
    expect(Object.keys(FLAGS)).toEqual([]);
  });
});

// ── value resolution (evaluate.ts) ────────────────────────────────────────

const noWorkspace: FlagContext = { workspaceId: null };
const inWorkspace: FlagContext = { workspaceId: '22222222-2222-2222-2222-222222222222' };

describe('resolveFlagDef (the core every registry key resolves through)', () => {
  it('reads a boolean flag: on is on, off is off, missing is the fallback', () => {
    const def = {
      kind: 'boolean',
      purpose: 'release',
      scope: 'user',
      owner: 'test',
      expiry: 'test',
      fallback: false,
      rollback: 'test',
    } as const;
    expect(resolveFlagDef(def, { enabled: true, variant: null }, noWorkspace)).toBe(true);
    expect(resolveFlagDef(def, { enabled: false, variant: null }, noWorkspace)).toBe(false);
    expect(resolveFlagDef(def, undefined, noWorkspace)).toBe(false);
  });

  it('emits one bounded diagnostic for a missing value, never a storm', () => {
    const def = {
      kind: 'boolean',
      purpose: 'release',
      scope: 'user',
      owner: 'test',
      expiry: 'test',
      fallback: false,
      rollback: 'test',
    } as const;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveFlagDef(def, undefined, noWorkspace);
    resolveFlagDef(def, undefined, noWorkspace);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('resolveFlagDef with synthetic definitions (kinds the registry does not use yet)', () => {
  const variantDef = {
    kind: 'variant',
    purpose: 'release',
    scope: 'user',
    owner: 'test',
    expiry: 'test',
    fallback: 'control',
    variants: ['control', 'candidate'],
    rollback: 'test',
  } as const;

  it('resolves a known variant; a null variant is the declared control', () => {
    expect(resolveFlagDef(variantDef, { enabled: true, variant: 'candidate' }, noWorkspace)).toBe(
      'candidate',
    );
    expect(resolveFlagDef(variantDef, { enabled: true, variant: null }, noWorkspace)).toBe(
      'control',
    );
  });

  it('falls back on an UNKNOWN variant — never an arbitrary value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveFlagDef(variantDef, { enabled: true, variant: 'mystery' }, noWorkspace)).toBe(
      'control',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('resolves a workspace-scoped flag to its control when no workspace is verified', () => {
    const workspaceDef = { ...variantDef, scope: 'workspace' } as const;
    // Even a value PostHog returned for the person is ignored: without
    // verified workspace context, teammates must not split by user.
    expect(resolveFlagDef(workspaceDef, { enabled: true, variant: 'candidate' }, noWorkspace)).toBe(
      'control',
    );
    expect(resolveFlagDef(workspaceDef, { enabled: true, variant: 'candidate' }, inWorkspace)).toBe(
      'candidate',
    );
  });
});

describe('evaluateAllFlags', () => {
  it('an empty registry resolves to an empty snapshot — provider failures are vacuously safe', () => {
    expect(evaluateAllFlags(null, noWorkspace)).toEqual({});
    expect(evaluateAllFlags({}, noWorkspace)).toEqual({});
  });
});

// ── the PostHog adapter (provider.ts) ─────────────────────────────────────

type CapturedRequest = { url: string; body: Record<string, unknown> };

function capturingFetch(result: { ok: boolean; status: number }): {
  impl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const impl = ((_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(_url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const response = {
      ok: result.ok,
      status: result.status,
      json: () => Promise.resolve({ flags: {} }),
    } as unknown as Response;
    return Promise.resolve(response);
  }) as typeof fetch;
  return { impl, requests };
}

describe('posthogEvaluateFlags', () => {
  const base = {
    host: 'https://us.example.posthog.com/',
    token: 'phc-test-token',
    distinctId: '11111111-1111-1111-1111-111111111111',
  };

  it('calls the public /flags endpoint with the identity and workspace override', async () => {
    const { impl, requests } = capturingFetch({ ok: true, status: 200 });
    await posthogEvaluateFlags({
      ...base,
      workspaceId: '22222222-2222-2222-2222-222222222222',
      fetchImpl: impl,
    });
    expect(requests[0]!.url).toBe('https://us.example.posthog.com/flags?v=2');
    expect(requests[0]!.body).toEqual({
      token: 'phc-test-token',
      distinct_id: '11111111-1111-1111-1111-111111111111',
      person_properties: { flowdeck_workspace_id: '22222222-2222-2222-2222-222222222222' },
    });
  });

  it('sends an empty person_properties override when no workspace is active', async () => {
    const { impl, requests } = capturingFetch({ ok: true, status: 200 });
    await posthogEvaluateFlags({ ...base, workspaceId: null, fetchImpl: impl });
    expect(requests[0]!.body.person_properties).toEqual({});
  });

  it('two members of one workspace evaluate with identical context — only the distinct ID differs', async () => {
    const { impl, requests } = capturingFetch({ ok: true, status: 200 });
    const workspaceId = '22222222-2222-2222-2222-222222222222';
    await posthogEvaluateFlags({ ...base, distinctId: 'user-a', workspaceId, fetchImpl: impl });
    await posthogEvaluateFlags({
      ...base,
      distinctId: 'user-b',
      workspaceId,
      fetchImpl: impl,
    });
    const [a, b] = requests;
    expect(a.body.person_properties).toEqual(b.body.person_properties);
    expect(a.body.distinct_id).not.toBe(b.body.distinct_id);
    // The distinct ID is the user UUID — never an email or any PII.
    expect(String(a.body.distinct_id)).not.toContain('@');
  });

  it('throws on a non-OK response (the caller serves declared fallbacks)', async () => {
    const { impl } = capturingFetch({ ok: false, status: 429 });
    await expect(
      posthogEvaluateFlags({ ...base, workspaceId: null, fetchImpl: impl }),
    ).rejects.toThrow(/429/);
  });

  it('throws on timeout — SSR must never hang on a flag', async () => {
    // A fetch that never resolves on its own: only the abort can end it.
    const hanging = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    await expect(
      posthogEvaluateFlags({ ...base, workspaceId: null, fetchImpl: hanging, timeoutMs: 10 }),
    ).rejects.toThrow();
  });
});

// ── the workspace cookie candidate (snapshot.ts pure half) ────────────────

describe('readWorkspaceCandidate', () => {
  it('extracts the ob_ws cookie value only when it is a UUID', () => {
    expect(readWorkspaceCandidate('ob_ws=22222222-2222-2222-2222-222222222222')).toBe(
      '22222222-2222-2222-2222-222222222222',
    );
    expect(readWorkspaceCandidate('a=1; ob_ws=22222222-2222-2222-2222-222222222222; b=2')).toBe(
      '22222222-2222-2222-2222-222222222222',
    );
    expect(readWorkspaceCandidate('ob_ws=not-a-uuid')).toBeNull();
    expect(readWorkspaceCandidate('')).toBeNull();
  });
});

// ── the client SDK lifecycle (client.ts) ──────────────────────────────────

type Recorded = { calls: [string, unknown[]] };

function fakeClient(): { client: FlagClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push({ calls: [name, args] });
  return {
    client: {
      identify: record('identify') as FlagClient['identify'],
      reset: record('reset') as FlagClient['reset'],
      setPersonPropertiesForFlags: record('set') as FlagClient['setPersonPropertiesForFlags'],
      resetPersonPropertiesForFlags: record(
        'resetProps',
      ) as FlagClient['resetPersonPropertiesForFlags'],
      reloadFeatureFlags: record('reload') as FlagClient['reloadFeatureFlags'],
    },
    calls,
  };
}

const names = (calls: Recorded[]) => calls.map((c) => c.calls[0]);

const user = { userId: '11111111-1111-1111-1111-111111111111', workspaceId: null };
const state = (over: Partial<FlagSyncState> = {}): FlagSyncState => ({ ...user, ...over });

afterEach(() => {
  setFlagClientForTests(null);
});

describe('syncFlagClient — the override lifecycle', () => {
  it('seeds identity and workspace context on the hydration run without churn', () => {
    const { client, calls } = fakeClient();
    setFlagClientForTests(client);
    syncFlagClient(undefined, state({ workspaceId: 'ws-1' }));
    expect(names(calls)).toEqual(['identify', 'set']);
  });

  it('identifies once per user and refreshes the override on workspace switch', () => {
    const { client, calls } = fakeClient();
    setFlagClientForTests(client);
    syncFlagClient(undefined, state({ workspaceId: 'ws-1' }));
    calls.length = 0;
    syncFlagClient(state({ workspaceId: 'ws-1' }), state({ workspaceId: 'ws-2' }));
    // Only the override changes: no re-identify for the same user.
    expect(names(calls)).toEqual(['set']);
    expect(calls[0]!.calls[1][0]).toEqual({ flowdeck_workspace_id: 'ws-2' });
  });

  it('clears the override and explicitly reloads when the workspace goes away', () => {
    const { client, calls } = fakeClient();
    setFlagClientForTests(client);
    syncFlagClient(undefined, state({ workspaceId: 'ws-1' }));
    calls.length = 0;
    syncFlagClient(state({ workspaceId: 'ws-1' }), state({ workspaceId: null }));
    // The web SDK does not reload on reset — the contract pairs them.
    expect(names(calls)).toEqual(['resetProps', 'reload']);
  });

  it('resets everything on sign-out', () => {
    const { client, calls } = fakeClient();
    setFlagClientForTests(client);
    syncFlagClient(undefined, state({ workspaceId: 'ws-1' }));
    calls.length = 0;
    syncFlagClient(state({ workspaceId: 'ws-1' }), { userId: null, workspaceId: null });
    expect(names(calls)).toEqual(['reset']);
  });

  it('identifies again on a sign-in as a different user', () => {
    const { client, calls } = fakeClient();
    setFlagClientForTests(client);
    syncFlagClient(undefined, state({ workspaceId: 'ws-1' }));
    calls.length = 0;
    const other = { userId: '99999999-9999-9999-9999-999999999999', workspaceId: 'ws-1' };
    syncFlagClient(state({ workspaceId: 'ws-1' }), other);
    expect(names(calls)).toEqual(['identify', 'set']);
  });

  it('is a no-op without a client runtime (local dev without PostHog)', () => {
    setFlagClientForTests(null);
    expect(() => syncFlagClient(undefined, state())).not.toThrow();
  });
});

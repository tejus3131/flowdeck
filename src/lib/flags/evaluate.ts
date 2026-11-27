// Flag value resolution — the pure, isomorphic half of the runtime.
// Raw PostHog values (or their absence) become declared, typed values;
// nothing here touches the network, so tests drive every failure mode
// deterministically. Every failure path lands on a registered fallback:
// a missing, timed-out, quota-limited, or unknown value never invents
// behavior (ADR-17).
import type { FlagDef, FlagKey, FlagValue, VariantFlagDef } from './registry';
import { FLAGS } from './registry';

/** What PostHog's public /flags endpoint returns per evaluated flag. */
export type RawFlagValue = { enabled: boolean; variant: string | null };

/** One resolved value per registry key — never partial. */
export type FlagValues = { readonly [K in FlagKey]: FlagValue<K> };

/** Flag evaluation context: the verified workspace for workspace-scoped
 *  flags (null = none active / not resolvable). */
export type FlagContext = { workspaceId: string | null };

// Bounded diagnostics: a broken flag configuration must surface in
// Workers Logs, but never spam them. The cap keeps a runaway loop (say,
// a per-request unknown variant) from filling the log budget.
const warned = new Set<string>();
const WARN_CAP = 25;

function warnOnce(topic: string, message: string): void {
  if (warned.has(topic) || warned.size >= WARN_CAP) return;
  warned.add(topic);
  console.warn(`[flags] ${message}`);
}

/** Resolve a flag definition against its raw evaluation — the generic
 *  core `resolveFlag` specializes for registry keys (tests drive it
 *  with synthetic definitions for kinds the registry doesn't use yet).
 *
 *  - missing raw (not created, quota-limited, provider failure) → the
 *    declared fallback;
 *  - boolean flags read `enabled` as-is (a returned `false` is a valid
 *    "off", not a failure);
 *  - variant flags: no variant → the declared control; a variant outside
 *    the registry union → the declared fallback plus one diagnostic;
 *  - workspace-scoped flags without verified workspace context always
 *    resolve to their control — a shared surface must never split
 *    teammates because one request lacked context (the contract's rule:
 *    no user-percentage fallback for workspace UI).
 */
export function resolveFlagDef(
  def: FlagDef,
  raw: RawFlagValue | undefined,
  context: FlagContext,
): boolean | string {
  if (def.scope === 'workspace' && !context.workspaceId) {
    if (raw) {
      warnOnce(
        `ws-missing:${def.kind}`,
        'a workspace-scoped flag was evaluated without verified workspace context — control value',
      );
    }
    return def.fallback;
  }
  if (!raw) {
    warnOnce(
      `missing:${def.kind}`,
      'a flag returned no value (not created, quota-limited, or failed) — declared fallback',
    );
    return def.fallback;
  }
  if (def.kind === 'boolean') return raw.enabled;
  const variantDef = def as VariantFlagDef;
  if (raw.variant === null) return variantDef.fallback;
  if (!variantDef.variants.includes(raw.variant)) {
    warnOnce(
      `unknown:${def.kind}`,
      `an unknown variant "${raw.variant}" was returned — declared fallback`,
    );
    return variantDef.fallback;
  }
  return raw.variant;
}

/** Resolve ONE registered flag against its raw evaluation. */
export function resolveFlag<K extends FlagKey>(
  key: K,
  raw: RawFlagValue | undefined,
  context: FlagContext,
): FlagValue<K> {
  return resolveFlagDef(FLAGS[key], raw, context) as FlagValue<K>;
}

/** Resolve every registered flag from a raw evaluation result. Null raw
 *  (provider failure, absent config) resolves the whole snapshot to
 *  declared fallbacks — the app stays fully usable. */
export function evaluateAllFlags(
  raw: Record<string, RawFlagValue> | null,
  context: FlagContext,
): FlagValues {
  const values = {} as Record<FlagKey, FlagValue<FlagKey>>;
  for (const key of Object.keys(FLAGS) as FlagKey[]) {
    values[key] = resolveFlag(key, raw?.[key], context) as FlagValue<FlagKey>;
  }
  return values as FlagValues;
}

/** Test/reset hook for the bounded diagnostic set. */
export function clearFlagDiagnostics(): void {
  warned.clear();
}

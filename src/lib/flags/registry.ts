// The typed flag registry (ADR-17): the single source of truth for every
// feature flag Flowdeck consumes. Application code reads decisions through
// `flag()` (./snapshot.ts) — components never import a PostHog SDK or name
// a PostHog key directly.
//
// Every registered flag records the metadata the flag contract requires
// (docs/feature-flags-and-ui-playground.md): purpose, safe fallback, scope,
// owner, and expiry, plus the exact behavior the fallback restores. The
// registry is code — a key is renamed by migration, and a flag is removed
// here AND in PostHog when its lifecycle ends (governance and lifecycle
// rules: docs/posthog.md).
export type FlagPurpose = 'release' | 'operational' | 'permission' | 'experiment';

/** Who the flag must be consistent for. Workspace-scoped flags evaluate
 *  with the verified active workspace as a person-property override, and
 *  their PostHog rules must use exact workspace IDs at 100% rollout — a
 *  user-percentage rule would split teammates (the contract's limit). */
export type FlagScope = 'user' | 'workspace';

export type FlagMeta = {
  readonly purpose: FlagPurpose;
  readonly scope: FlagScope;
  /** The responsible maintainer (the review/expiry owner). */
  readonly owner: string;
  /** Removal/review date for temporary flags, or the explicit reason a
   *  permission/ops flag is permanent (data-playbook lifecycle table). */
  readonly expiry: string;
  /** The exact behavior the fallback restores. */
  readonly rollback: string;
};

export type BooleanFlagDef = FlagMeta & {
  readonly kind: 'boolean';
  /** The value when evaluation is missing, times out, is quota-limited,
   *  or returns an unknown value. There is no universal safe value. */
  readonly fallback: boolean;
};

export type VariantFlagDef = FlagMeta & {
  readonly kind: 'variant';
  /** The finite, stable variant union. Renaming a variant is a migration. */
  readonly variants: readonly string[];
  /** The declared control — the value for "off", unknown, and missing. */
  readonly fallback: string;
};

export type FlagDef = BooleanFlagDef | VariantFlagDef;

// The registry is EMPTY right now — deliberately. Playground access is
// environment-gated (ADR-17's amendment: preview deployments are already
// Cloudflare-Access-gated to the maintainer, so VITE_APP_ENV decides —
// production always 404s; no PostHog flag involved). A flag registers
// here ONLY with the PR that consumes it: the redesign's release flags
// arrive with the first redesigned surface, each carrying the full
// metadata plus its removal task (docs/posthog.md governs).
export const FLAGS = {} as const satisfies Record<string, FlagDef>;

export type FlagKey = keyof typeof FLAGS;

/** The typed value of a flag: its variant union, or a boolean. */
export type FlagValue<K extends FlagKey> = (typeof FLAGS)[K] extends VariantFlagDef
  ? (typeof FLAGS)[K]['variants'][number]
  : boolean;

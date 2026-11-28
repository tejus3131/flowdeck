// The brand config — the single source of truth for every brand fact
// (docs/pwa-seo-brand-plan.md, phase 5). Everything user-facing derives
// from here: page titles, headings, invite emails, the MCP server text,
// the SW notification title, the manifest (emitted at build time by the
// plugin in vite.config.ts). The name is NOT decided yet — this module
// exists so the rename, when it happens, is a one-file change plus the
// edge function's JSON (see supabase/functions/mcp/brand.json).
//
// Renamed with the brand (pre-launch, sole user): wire-protocol strings
// (`orb_` token prefix, `orbit-card-ref:`, `ob_*` cookies), storage keys,
// the PostHog property (`orbit_workspace_id`) and DB identifiers. The one
// deliberate holdout is the `--fd-*` CSS token prefix — the design system
// is frozen (ADR-16) and the prefix carries no brand meaning.
//
// Server code imports this module directly (it is dependency-free and
// isomorphic); the edge function cannot import `src/`, so its strings
// live in `supabase/functions/mcp/brand.json` and a parity test pins
// the two files to the same values.

/** The brand facts. `name` reads the VITE_APP_NAME override so a
 *  deployment can carry a different display name without a fork. */
export const brand = {
  /** The product name (manifest `name`, titles, headings). */
  name: import.meta.env?.VITE_APP_NAME ?? 'Orbit',
  /** The short name (manifest `short_name`; ≤ 12 chars). */
  shortName: import.meta.env?.VITE_APP_NAME ?? 'Orbit',
  /** The landing <h1> area / OG description. */
  tagline: 'Realtime kanban boards for you, your team — and your agents',
  /** The manifest + meta description seed. */
  description: 'A realtime kanban board your team can work on together.',
  /** The legal identity (privacy policy's data controller). */
  legalName: 'Orbit',
  /** The policy + support contact. */
  contactEmail: 'orbit@tejusgupta.dev',
  /** The canonical/OG base URL — the deployment's own origin when
   *  advertised (VITE_APP_URL), the prod URL otherwise. */
  url: import.meta.env?.VITE_APP_URL ?? 'https://orbit.tejusgupta.dev',
  /** Manifest + <meta name="theme-color">. */
  themeColor: '#4f46e5',
  /** The OG/Twitter card image (1200×630), site-absolute. */
  ogImage: '/og.png',
  /** Organization JSON-LD `sameAs` (empty until real profiles exist). */
  social: [] as string[],
  /** The invite-email sender — the RESEND_FROM default. */
  senderEmail: 'orbit@tejusgupta.dev',
} as const;

/** The app's display name — the one accessor most call sites want. */
export const appName = brand.name;

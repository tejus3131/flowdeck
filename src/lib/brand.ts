// The brand config — the single source of truth for every brand fact
// (docs/pwa-seo-brand-plan.md, phase 5). Everything user-facing derives
// from here: page titles, headings, invite emails, the MCP server text,
// the SW notification title, the manifest (emitted at build time by the
// plugin in vite.config.ts). The name is NOT decided yet — this module
// exists so the rename, when it happens, is a one-file change plus the
// edge function's JSON (see supabase/functions/mcp/brand.json).
//
// What NOT to rename even at rebrand: internal identifiers — the `fd_`
// CSS token prefix, `flowdeck_workspace_id` PostHog property, cache
// names (`flowdeck-cache`), env var names, DB/schema identifiers.
// Brand rename ≠ identifier rename.
//
// Server code imports this module directly (it is dependency-free and
// isomorphic); the edge function cannot import `src/`, so its strings
// live in `supabase/functions/mcp/brand.json` and a parity test pins
// the two files to the same values.

/** The brand facts. `name` reads the VITE_APP_NAME override so a
 *  deployment can carry a different display name without a fork. */
export const brand = {
  /** The product name (manifest `name`, titles, headings). */
  name: import.meta.env?.VITE_APP_NAME ?? 'Flowdeck',
  /** The short name (manifest `short_name`; ≤ 12 chars). */
  shortName: import.meta.env?.VITE_APP_NAME ?? 'Flowdeck',
  /** The landing <h1> area / OG description. */
  tagline: 'Realtime kanban boards for you, your team — and your agents',
  /** The manifest + meta description seed. */
  description: 'A realtime kanban board your team can work on together.',
  /** The legal identity (privacy policy's data controller). */
  legalName: 'Flowdeck',
  /** The policy + support contact. */
  contactEmail: 'flowdeck@tejusgupta.dev',
  /** The canonical/OG base URL — the deployment's own origin when
   *  advertised (VITE_APP_URL), the prod URL otherwise. */
  url: import.meta.env?.VITE_APP_URL ?? 'https://flowdeck.tejusgupta.dev',
  /** Manifest + <meta name="theme-color">. */
  themeColor: '#4f46e5',
  /** The OG/Twitter card image (1200×630), site-absolute. */
  ogImage: '/og.png',
  /** Organization JSON-LD `sameAs` (empty until real profiles exist). */
  social: [] as string[],
  /** The invite-email sender — the RESEND_FROM default. */
  senderEmail: 'flowdeck@tejusgupta.dev',
} as const;

/** The app's display name — the one accessor most call sites want. */
export const appName = brand.name;

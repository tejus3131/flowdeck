# PWA, SEO & Brand — the phase 5–6 plan

The implementation contract for the offline/PWA, SEO, and rebrand work,
grounded in [`research/seo.md`](./research/seo.md),
[`research/pwa-and-offline.md`](./research/pwa-and-offline.md), and
[`research/brand-and-legal.md`](./research/brand-and-legal.md). These
phases run **before the UI redesign sprint starts**, alongside the flag
foundation (ADR-17) — the redesign consumes the brand config and the
SEO'd document head that land here.

## Phase 5 — Brand foundation + SEO shell

One source of truth for the brand; the SEO document head built on it.

**Deliverables:**

1. `src/lib/brand.ts` — the typed brand config (schema in
   [`research/brand-and-legal.md`](./research/brand-and-legal.md)):
   `name`, `shortName`, `tagline`, `description`, `legalName`,
   `contactEmail`, `url`, `themeColor`, `ogImage`, `social`. Reads
   `VITE_APP_NAME` as the override; server code (invite emails, MCP
   server text) imports the same constant.
2. Migrate the ~36 hardcoded brand strings: every `<Title>`, landing and
   sign-in headings, invite emails, MCP server description + consent page,
   SW notification title, manifest. Add the grep guard to pr-prep (no
   literal brand name in components).
3. Document head via the `@solidjs/meta` registry (not hardcoded in
   `Document.tsx`, which the registry won't dedupe): per-route `<Title>` +
   `<Meta name="description">`, OG + Twitter tags, self-referencing
   canonicals on public pages. Replace the `Solid App` fallback title.
4. `public/robots.txt` (allow all except `Disallow: /api/`; never disallow
   the noindexed app routes) + `public/sitemap.xml` (absolute URLs,
   public routes only).
5. `X-Robots-Tag: noindex, nofollow` middleware for auth-gated routes
   (`/b/*`, `/w/*`, `/profile`, `/search`, `/u/*`, `/invite/*`,
   `/connection/*`, `/mcp/authorize`) and the preview deployment.
6. JSON-LD on the landing page: `Organization` + `WebSite` +
   `SoftwareApplication` (price 0, no fabricated ratings). Skip FAQPage
   (deprecated May 2026).
7. Fonts: self-host Inter variable woff2, `preload` + `font-display:
swap` + `size-adjust` fallback metrics.
8. Manifest: `id`, `shortcuts` (2–3), `screenshots` with `form_factor` +
   `label`s, `launch_handler: focus-existing` — all derived from brand
   config.
9. Legal pages (content work, seeded here): privacy, terms, contact;
   subprocessors, DPA, security + `/.well-known/security.txt` follow.
10. Verify Search Console + Bing Webmaster **now**, before any domain
    change, to baseline.

**Explicitly out of scope:** the new landing page design (that's redesign
work; it consumes this head), any domain move.

## Phase 6 — Offline experience

The SW makes the shell survive; the entity store + outbox (already built)
make the data survive.

**Deliverables:**

1. **App-shell precache** — hashed build assets, cache-first; versioned
   cache name + expected-caches allowlist + delete-on-activate; never
   cache `cache-control: no-store` responses.
2. **Navigation handling** — network-first for navigations with cached-shell
   fallback, allowlisted to app routes only (`/b/*`, `/w/*`, `/u/*`,
   `/profile`, `/search`); network-only for `/sign-in`, `/auth`,
   `/invite`, `/api/*`, `/mcp/*`; `offline.html` as the last-resort
   document fallback. Skip navigation preload.
3. **Outbox-aware update flow** (replaces the unconditional `skipWaiting`):
   new SW waits; "Update ready" chip; apply on next navigation when the
   outbox is empty; after drain or explicit user action when pending;
   reload once on `controllerchange` with a re-entrancy guard. Serve
   `sw.js` with `Cache-Control: max-age=0`; `registration.update()` on
   client-side navigation.
4. **Offline UX layer** — app-wide connection banner (passive chip, never
   blocks editing), per-board last-synced watermark, pending badges on
   outboxed mutations, disabled-vs-hidden actions, visible reconnect
   (replay → refresh → resolve conflicts).
5. **Storage persistence** — `navigator.storage.persist()` at an
   engagement moment (install / first board edit); monitor `estimate()`.
6. **Install UX** — capture `beforeinstallprompt`, in-app affordance at an
   engagement moment, `userChoice` analytics, iOS instructions only under
   `@media (display-mode: browser)`.

**Canonical test for phase 6:** with the network dead, a previously
opened board renders from the entity store, edits queue in the outbox
with visible pending state, and everything syncs on reconnect — with the
update flow never discarding queued edits.

## PR breakdown

| PR               | Phase | Contents                                                                     |
| ---------------- | ----- | ---------------------------------------------------------------------------- |
| Brand foundation | 5     | `brand.ts`, string migration, grep guard, manifest from config               |
| SEO shell        | 5     | head/meta/OG/canonicals, robots, sitemap, noindex middleware, JSON-LD, fonts |
| Legal pages      | 5     | privacy, terms, contact; then subprocessors/DPA/security.txt                 |
| Offline shell    | 6     | SW precache + navigation fallback + update flow                              |
| Offline UX       | 6     | banner, watermarks, pending badges, persistence, install UX                  |

Each PR: `pnpm preflight` green, one concern per commit, docs updated in
the same commit. The SW PR needs a migration-style note (cache name
change evicts the old image cache once — acceptable, it rebuilds).

## Order of operations (the full pre-redesign sequence)

1. Flags foundation (ADR-17 runtime — in flight on `feat/flags-typed-runtime`)
2. Phase 5 (brand + SEO) — the redesign consumes `brand.ts` and the head
3. Phase 6 (offline) — independent of 5, can interleave
4. Shared UI foundation (tokens/primitives) → playground → redesign sprint

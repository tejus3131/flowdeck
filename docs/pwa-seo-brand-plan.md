# PWA, SEO & Brand — the phase 5–6 plan

The implementation contract for the offline/PWA, SEO, and rebrand work,
grounded in [`research/seo.md`](./research/seo.md),
[`research/pwa-and-offline.md`](./research/pwa-and-offline.md),
[`research/brand-and-legal.md`](./research/brand-and-legal.md), and
[`research/legal-compliance.md`](./research/legal-compliance.md). These
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
   `VITE_APP_NAME` as the override; server code (invite emails) imports
   the same constant.
   **Edge-function exception:** `supabase/functions/mcp/index.ts` is a
   separately-deployed Deno bundle that cannot import `src/`. Its brand
   strings get a duplicated constant with a parity test (or the text is
   moved to a shared JSON file both graphs read) — decided in the PR.
2. Migrate the ~36 hardcoded brand strings: every `<Title>`, landing and
   sign-in headings, invite emails, MCP server description + consent page,
   SW notification title, manifest. Add the grep guard to pr-prep (no
   literal brand name in components) — **scoped to `src/routes/**` +
   `src/components/**`** (docs, tests, `wrangler.jsonc`, `fd_*` internals,
   and the edge function legitimately contain the name; decide in the PR
   whether any `src/lib/` strings are UI-facing enough to include).
   **Hard gate before this PR opens:** the name decision + USPTO
   trademark search are completed and recorded — the rename is the one
   irreversible decision in the sprint (domain, email sender, trademark).
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
   **Static-asset caveat:** `/robots.txt`, `/sitemap.xml`, `/sw.js`,
   `/manifest.webmanifest`, images, and JS are served by Cloudflare's
   asset layer (`wrangler.jsonc` `assets` binding) and never pass through
   `src/middleware.ts`. The belt-and-braces for the preview environment
   is a `dist/client/_headers` file with `X-Robots-Tag` — land the
   `_headers` infrastructure in this PR (it also carries the
   `Cache-Control: max-age=0` for `/sw.js` that phase 6 needs), and
   decide in the PR whether middleware or `_headers` is authoritative
   for HTML routes.
6. JSON-LD on the landing page: `Organization` + `WebSite` +
   `SoftwareApplication` (price 0, no fabricated ratings). Skip FAQPage
   (deprecated May 2026).
7. Fonts: self-host Inter variable woff2 in `public/fonts/`, `preload` +
   `crossorigin` + `font-display: swap` + `size-adjust` fallback metrics
   (no CSP in the codebase today, so no header changes needed).
8. Manifest: `id`, `shortcuts` (2–3), `screenshots` with `form_factor` +
   `label`s, `launch_handler: focus-existing` — all derived from brand
   config. **Build-time emit:** a small Vite plugin writes
   `dist/client/manifest.webmanifest` from `brand.ts`; the `public/`
   copy is removed so there is exactly one source.
9. Legal pages (content work, seeded here): privacy, terms, contact;
   subprocessors, DPA, security + `/.well-known/security.txt` follow.
   The compliance decisions land with them: PostHog cookieless mode
   (`cookieless_mode: 'always'`), the in-app export/delete-account flows,
   and the subprocessor table with each vendor's transfer mechanism —
   **PostHog Cloud US (DPF)** specifically, since the proxy sends
   analytics to `us.i.posthog.com`; Supabase = SCCs; Cloudflare/Resend =
   DPF. The `/.well-known/security.txt` route must not collide with the
   existing `/well-known/oauth-authorization-server` route.
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
   document fallback. Skip navigation preload. **Verify the allowlist
   against the full route tree** (`src/routes/`) — a missed app route
   means users on flaky networks get `offline.html` inside the app, the
   exact failure mode this PR exists to avoid.
3. **Outbox-aware update flow** (replaces the unconditional `skipWaiting`):
   new SW waits; "Update ready" chip; apply on next navigation when the
   outbox is empty; after drain or explicit user action when pending;
   reload once on `controllerchange` with a re-entrancy guard. Serve
   `sw.js` with `Cache-Control: max-age=0` via the `_headers` file landed
   in phase 5 (the asset layer, not the Worker, serves `/sw.js`);
   `registration.update()` on client-side navigation. **Enumerate what is
   carried over unchanged:** the `push`, `notificationclick`,
   `pushsubscriptionchange` handlers and the `fd-navigate` /
   `fd-resubscribe` postMessage protocol are load-bearing (push already
   shipped) — the PR diff must prove they survive the rework.
4. **Offline UX layer** — app-wide connection banner (passive chip, never
   blocks editing), per-board last-synced watermark, pending badges on
   outboxed mutations, disabled-vs-hidden actions, visible reconnect
   (replay → refresh → resolve conflicts).
5. **Storage persistence** — `navigator.storage.persist()` at an
   engagement moment (install / first board edit); monitor `estimate()`.
   `persist()` can be **denied** — the UX copy must not promise
   persistence unconditionally.
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

**Export/delete PR (data rights) specifics:**

- `SUPABASE_SECRET_KEY` is already a validated server env (`env.ts`) —
  the delete-user admin call needs **no new secret** and stays inside
  ADR-15's credential policy; state this in the PR.
- **Orphaned-workspace decision required:** deleting the auth user while
  workspace rows the user created (or is the last member of) persist
  needs a defined answer — transfer, delete, or leave with invite-only
  access. This is an RLS + possibly schema question; if a migration is
  needed, the migration-guard routine applies.

**Gate phrasing:** the flag gate reads "first release flag registers and
evaluates correctly" — the registry currently holds zero flags and the
playground is environment-gated per the ADR-17 amendment; there is no
existing flag infrastructure to "verify in prod."

## Order of operations (the full pre-redesign sequence)

1. Flags foundation (ADR-17 runtime — in flight on `feat/flags-typed-runtime`)
2. Phase 5 (brand + SEO) — the redesign consumes `brand.ts` and the head
3. Phase 6 (offline) — independent of 5, can interleave
4. Shared UI foundation (tokens/primitives) → playground → redesign sprint

**Sequencing notes:**

- The trademark/name gate is a **hard external dependency** for the brand
  chain (brand → SEO → legal → data rights). The offline chain (shell →
  UX) has no dependency on it and can start anytime for overlap.
- Search Console verification needs a deployed SEO PR + DNS/access — a
  post-merge task tracked in the gate, not in the PR.
- The `_headers` infrastructure (preview noindex + `/sw.js` max-age)
  lands in the SEO PR so the offline PR doesn't own header
  infrastructure it doesn't need.

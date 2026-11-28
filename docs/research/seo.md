# SEO Research — Orbit → Orbit

Deep research grounding for the SEO work that ships with the rebrand and
the new landing page. Companion docs: [`pwa-and-offline.md`](./pwa-and-offline.md)
(the PWA half of "industry standard"), [`brand-and-legal.md`](./brand-and-legal.md)
(the rebrand/brand-config half). This is research + contract, not an
implementation claim.

**Repo baseline (verified):** `<title>Solid App</title>` is hardcoded in
`src/Document.tsx`; per-route `<Title>` exists on some routes; there are no
meta descriptions, OG tags, canonicals, robots.txt, sitemap, or structured
data. The 404 route already emits a real HTTP 404 via `httpStatus()`. Prod
URL is `orbit.tejusgupta.dev` (`VITE_APP_URL`). `@solidjs/meta` v2 is
already a dependency.

## Core Web Vitals on the edge

Budgets (75th percentile, mobile + desktop segmented): **LCP ≤ 2.5s**,
**INP ≤ 200ms**, **CLS ≤ 0.1** ([vitals](https://web.dev/articles/vitals)).
TTFB ≤ 0.8s is a guide, not a vital; a server-rendered site can tolerate
higher TTFB and still beat a CSR SPA on FCP/LCP
([optimize-ttfb](https://web.dev/articles/optimize-ttfb)).

- SSR sends text and links instead of JS-heavy payloads, which lowers
  blocking time and INP ([rendering-on-the-web](https://web.dev/articles/rendering-on-the-web)).
  Google: server-side or pre-rendering "makes your website faster for users
  and crawlers, and not all bots can run JavaScript"
  ([javascript-seo-basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)).
- Cloudflare Workers static assets are served without invoking the Worker;
  unmatched requests hit the Solid handler
  ([workers/static-assets](https://developers.cloudflare.com/workers/static-assets/)).
  Edge proximity directly attacks the TTFB component of LCP
  ([optimize-lcp](https://web.dev/articles/optimize-lcp)).
- **Fonts (Inter variable):** self-host the woff2 from `public/` (same-origin,
  no preconnect needed), inline the `@font-face` declaration, `preload` with
  `crossorigin`, `font-display: swap`, and define a metric-adjusted local
  fallback via `size-adjust` (~107% for Arial/Helvetica against Inter is the
  standard starting point) to kill font-swap CLS
  ([font-best-practices](https://web.dev/articles/font-best-practices),
  [optimize-webfont-loading](https://web.dev/articles/optimize-webfont-loading),
  [size-adjust](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/size-adjust),
  [optimize-cls](https://web.dev/articles/optimize-cls)).
- Images: always set `width`/`height` (or aspect-ratio) — the #1 CLS cause
  ([optimize-cls](https://web.dev/articles/optimize-cls)).
- INP matters mainly on landing/docs (static text); the auth-gated board is
  irrelevant to search. The low-JS SSR shell is already the right shape.

## Technical checklist (a new small SaaS)

- **Titles:** every page needs one; descriptive, no stuffing, brand concisely
  with a delimiter ("Orbit: Sign in"); Google truncates by device width and
  may rewrite from `<h1>`/`og:title`/anchor text
  ([title-link](https://developers.google.com/search/docs/appearance/title-link)).
- **Meta descriptions:** Google "sometimes uses" them; unique per page;
  programmatic generation is "appropriate and encouraged"; keyword lists are
  ignored ([snippet](https://developers.google.com/search/docs/appearance/snippet)).
- **Canonicals:** signals stack (redirects > canonical > sitemap); include a
  **self-referencing canonical on the canonical page itself**; never
  canonicalize via robots.txt
  ([consolidate-duplicate-urls](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)).
  Pick one trailing-slash form, self-canonical, link internally to one form,
  301 the other.
- **robots.txt vs noindex:** robots.txt manages crawler traffic, "it is not a
  mechanism for keeping a web page out of Google" — a disallowed page can
  still be indexed URL-only
  ([robots/intro](https://developers.google.com/search/docs/crawling-indexing/robots/intro)).
  `noindex` (meta or `X-Robots-Tag`) drops a page from results entirely but
  **requires the page be crawlable** — robots.txt blocking hides the noindex
  ([block-indexing](https://developers.google.com/search/docs/crawling-indexing/block-indexing),
  [robots-meta-tag](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)).
- **sitemap.xml:** absolute fully-qualified URLs, ≤ 50k URLs/50MB, host at
  root, canonical URLs only
  ([build-sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)).
  For Orbit: a tiny static sitemap listing `/`, `/sign-in`, `/docs/mcp`, and
  the legal pages is sufficient.
- **hreflang:** only for multiple language/region versions — single-locale
  site: **skip entirely**
  ([localized-versions](https://developers.google.com/search/docs/specialty/international/localized-versions)).
- **404/410:** all 4xx (except 429) are treated alike — dropped from the
  index; a `200` page that looks like an error is a soft 404
  ([http-status-codes](https://developers.google.com/crawling/docs/troubleshooting/http-status-codes)).
  Keep the true-404 catch-all; use 410 for deliberately removed content.
- **Structured data (2025-26 status):** JSON-LD recommended; must represent
  visible content
  ([sd-policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)).
  - `SoftwareApplication` — name required; `applicationCategory:
"WebApplication"`, `offers` price 0; **never fabricate
    `aggregateRating`** ([software-app](https://developers.google.com/search/docs/appearance/structured-data/software-app)).
  - `Organization` — name/url/logo/sameAs; influences logo/knowledge panel
    ([organization](https://developers.google.com/search/docs/appearance/structured-data/organization)).
  - `WebSite` — Google's site-name system prefers it over `og:site_name`
    ([site-names](https://developers.google.com/search/docs/appearance/site-names)).
  - `BreadcrumbList` — only if a real hierarchy exists (docs/legal)
    ([breadcrumb](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb)).
  - **FAQPage is dead** — FAQ rich results stopped appearing in Google
    Search as of May 2026; skip the markup; FAQ-style visible copy is still
    fine ([faqpage](https://developers.google.com/search/docs/appearance/structured-data/faqpage)).
- **OG + Twitter:** required OG: `og:title`, `og:type`, `og:image`,
  `og:url`; recommended: `og:description`, `og:site_name`,
  `og:image:width/height/alt` ([ogp.me](https://ogp.me/)). X cards:
  `twitter:card` `summary_large_image` with a 1200×630 image remains the
  standard pattern. Google also reads `og:title` as a title-link source.
- **Favicon:** Google supports `rel="icon"` + `apple-touch-icon`; one favicon
  per hostname; don't block the icon in robots.txt
  ([favicon-in-search](https://developers.google.com/search/docs/appearance/favicon-in-search)).
  The current icon set is compliant — re-skin for Orbit.
- **SolidStart note:** `@solidjs/meta`'s registry replaces the static
  `<title>` when a `<Title>` mounts but **leaves other hardcoded head tags
  alone** — a hardcoded `<meta name="description">` next to a
  registry-rendered one duplicates. Render defaults through the registry
  (`<Meta>`, `<Link>`) and keep `Document.tsx` as pure fallback
  ([solid head docs](https://docs.solidjs.com/building-apps/head-and-metadata)).

## Auth-gated app routes

The three tools and what they actually do:

1. **robots.txt disallow** — stops crawling, not indexing; the URL can still
   appear from external links ([robots/intro](https://developers.google.com/search/docs/crawling-indexing/robots/intro)).
2. **`noindex`** — removes from results entirely; requires crawlability
   ([block-indexing](https://developers.google.com/search/docs/crawling-indexing/block-indexing)).
3. **Auth itself** — Google treats 401/403 like other 4xx: dropped from the
   index ([http-status-codes](https://developers.google.com/crawling/docs/troubleshooting/http-status-codes)).

**Orbit pattern:** app routes (`/b/*`, `/w/*`, `/profile`, `/search`, `/u/*`,
`/invite/*`, `/connection/*`, `/mcp/authorize`) send
**`X-Robots-Tag: noindex, nofollow`** from middleware; robots.txt must **not**
disallow those paths (or the noindex is never seen). robots.txt only manages
crawl traffic on non-page endpoints: `Disallow: /api/`. Password protection
is Google's own recommended method for genuinely private content.

**Login-wall policy:** gating is not cloaking "if Google can see the full
content of what's behind the paywall just like any person who has access"
under Flexible Sampling
([spam policies](https://developers.google.com/search/docs/essentials/spam-policies),
[flexible-sampling](https://developers.google.com/search/docs/appearance/flexible-sampling)).
If board content is ever to be indexed, it needs genuinely public share
pages rendering real content to everyone — never a Googlebot-sees-all split.

**`/u/[userId]`** currently renders near-empty content for non-members —
either noindex it or server-render a public subset if profiles should be
public.

**Preview deployment** is an accidental-duplicate-variant risk
([canonicalization](https://developers.google.com/search/docs/crawling-indexing/canonicalization)
lists "the demo version of the site accidentally left accessible to
crawlers"): send `X-Robots-Tag: noindex` on the preview worker and keep it
out of the sitemap.

## Landing-page positioning (saturated market)

"There are no secrets here that'll automatically rank your site first"
([seo-starter-guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)).
Head terms ("kanban board", "project management tool") are owned by
Trello/Linear/Notion; a new small site competes on long-tail, differentiated
queries.

The differentiation is already in the product: realtime kanban **plus an MCP
server for AI agents**. The defensible territory is the intersection:
"kanban board MCP server", "AI agent kanban", "connect Claude/Cursor to a
kanban board". `/docs/mcp` is static, crawlable, content-rich — exactly the
docs-SEO pattern that works for dev tools; expand it (guides, recipes,
per-client setup pages).

Content patterns with policy caveats:

- **Alternatives/comparison pages** — legitimate when substantive and
  honest; **doorway abuse** if they're "substantially similar pages closer to
  search results than a clearly defined, browseable hierarchy"
  ([spam policies](https://developers.google.com/search/docs/essentials/spam-policies)).
- **Templates / changelog** — original, useful content.
- **Programmatic SEO** — pages from a real dataset where each page is
  genuinely useful; don't generate thousands of near-empty pages
  ([ahrefs programmatic SEO](https://ahrefs.com/blog/programmatic-seo/)).

**On-page fixes for the landing route:** the current `<h1>` is just the
product name — thin for a page that must rank for something. Give it a
descriptive `<h1>`, a unique title, a meta description, OG tags, and
`Organization` + `WebSite` + `SoftwareApplication` JSON-LD.

## Rebrand migration (Orbit → Orbit)

**Scenario A — same domain, new name:** no URL changes → **no site move at
all**. Update titles, OG, structured data, manifest, favicon, visible copy;
backlinks keep passing value
([site-move-with-url-changes](https://developers.google.com/search/docs/crawling-indexing/site-move-with-url-changes)).

**Scenario B — new domain:** full site move:

1. Prepare the new site fully first; verify both properties in Search
   Console ([site-move-with-url-changes](https://developers.google.com/search/docs/crawling-indexing/site-move-with-url-changes)).
2. **1:1 URL mapping**, 301 old → new; "301 and other permanent redirects
   don't cause a loss in PageRank"; avoid chains (keep under 3-5 hops);
   **never redirect everything to the homepage** — that's a soft 404.
3. **Change of Address tool** — domain/subdomain moves only; submit for all
   verified variants (www, non-www); don't chain moves; combining a move
   with a redesign "will probably see some traffic loss"
   ([CoA tool](https://support.google.com/webmasters/answer/9370220)).
4. Update self-canonicals, internal links, submit a new-URL sitemap.
5. Keep redirects long-term — the move completes per-URL as Googlebot
   revisits every old URL.
6. Failure modes: mass-redirect to homepage, redirect chains, leftover
   dev-time noindex/robots blocks, forgetting CoA variants, combining
   redesign + move, removing redirects early, letting the old domain lapse.

**Cloudflare detail for this repo:** the `_redirects` file supports 301s
**but "redirects defined in the `_redirects` file are not applied to
requests served by your Worker code"** — and HTML routes here are served by
the Solid Worker, not static assets
([workers redirects](https://developers.cloudflare.com/workers/static-assets/redirects/),
[static assets](https://developers.cloudflare.com/workers/static-assets/)).
For a domain move, implement old-domain 301s in the old Worker's middleware
or via Cloudflare Bulk Redirects / Redirect Rules at the edge.

## Measurement at near-zero traffic

- **Search Console first, before the rebrand** — verify now to baseline;
  submit the sitemap; URL Inspection + "Request indexing" for key pages
  ([ask-google-to-recrawl](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl)).
  GSC's Performance report is the only free query-level data.
- **Bing Webmaster + IndexNow** — free ping protocol (Bing, Naver, Seznam,
  Yandex, Yep); one API call on deploy
  ([indexnow.org](https://www.indexnow.org/)).
- **GA4 vs PostHog:** PostHog web analytics covers visitors/pageviews/
  sessions/channels with bot classification
  ([posthog web-analytics](https://posthog.com/docs/web-analytics)); GA4
  adds no SEO-specific data and costs a second script + consent overhead.
  **GSC + PostHog; skip GA4.**
- **Rank trackers:** not worth it at near-zero traffic — GSC covers it free.
- **CrUX/PSI field data won't exist** for a low-traffic site; use Lighthouse
  lab runs plus a `web-vitals` RUM feed into PostHog if field CWV numbers are
  wanted ([optimize-lcp note](https://web.dev/articles/optimize-lcp)).

## Prioritized recommendations

**P0 — ship with the rebrand (blocking):**

1. Replace the `Document.tsx` fallback `<title>Solid App</title>` with the
   brand default; per-route `<Title>` everywhere; `<Meta
name="description">` per public route via the `@solidjs/meta` registry
   (not hardcoded in `Document.tsx`).
2. OG + Twitter card tags on landing, sign-in, docs, and legal pages.
3. Self-referencing canonicals on public pages; one trailing-slash form.
4. `public/robots.txt`: allow everything except `Disallow: /api/`; do **not**
   disallow the noindexed app routes.
5. `X-Robots-Tag: noindex, nofollow` from middleware for all auth-gated
   routes and the preview deployment.
6. `sitemap.xml` with absolute URLs for public routes only.
7. JSON-LD on the landing page: `Organization` + `WebSite` +
   `SoftwareApplication` (price 0, no fake ratings). Skip FAQPage.
8. Verify Search Console (and Bing) **now**, before any domain change.

**P1 — first weeks:**

9. Fonts: self-host Inter variable woff2, `preload` + `font-display: swap` +
   `size-adjust` fallback metrics.
10. Rewrite the landing `<h1>`/copy around the defensible long-tail
    (realtime kanban + AI agents/MCP), not the head terms.
11. Grow `/docs/mcp` into a small docs section (per-client setup guides).
12. Keep the true-404 catch-all; use 410 for deliberately removed URLs.

**P2 — post-launch, if pursuing growth:**

13. If the domain changes: 1:1 301 map (Worker middleware or Cloudflare Bulk
    Redirects — `_redirects` won't cover Worker-served HTML), Change of
    Address for all old-domain variants, new sitemap, long-term redirects.
14. Comparison/alternatives/templates content only where substantive.
15. If public board sharing ever ships: genuinely public URLs rendering real
    content to everyone.
16. IndexNow ping on deploy; PostHog web-analytics + `web-vitals` RUM
    instead of GA4 and paid rank trackers.

**Gaps/uncertainties:** X's card docs moved into a restructured index and
could not be fetched directly; the `twitter:*` tag set cited is the
long-standing standard — verify against current X docs when implementing.
The 180-day minimum for post-migration redirects is practitioner lore; the
verified guidance is "keep redirects until Googlebot has revisited every
URL", i.e., long-term.

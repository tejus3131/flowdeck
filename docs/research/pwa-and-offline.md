# PWA & Offline Research — Flowdeck → Orbit

Deep research grounding for the offline/PWA work (phases 5–6 of the redesign
prep). Companion docs: [`seo.md`](./seo.md), [`brand-and-legal.md`](./brand-and-legal.md).
This is research + contract, not an implementation claim.

**Repo baseline (verified):** `public/sw.js` is hand-rolled — web-push +
`notificationclick` + `pushsubscriptionchange` + a bounded
stale-while-revalidate image cache (TTL 7d, 100 entries, sweep every 25
puts), with **unconditional `skipWaiting()` + `clients.claim()`** on
install/activate. `public/manifest.webmanifest` has the basics (name,
192/512/maskable icons, standalone, theme color). Registration is
client-side in `src/components/PushSetup.tsx`. App data already lives in
IndexedDB (entity store) with an outbox replay queue — the hard part of
offline is done; the SW only needs to make the shell survive.

## The model the industry converged on

**The service worker handles the shell; the data layer handles offline
data.** Figma is the canonical validation of Flowdeck's own architecture:
"lets you go offline for an arbitrary amount of time and continue editing.
When you come back online, the client downloads a fresh copy of the
document, **reapplies any offline edits on top of this latest state**, and
then continues syncing" —
[figma multiplayer](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/).
That is precisely the outbox-replay design.

## App-shell caching for SSR apps

In an SPA the shell is one `index.html` you precache. In SSR (SolidStart),
HTML is rendered per route and per user, so the pattern is **not** "cache
the HTML" — it's:

1. **Precache hashed build assets** at install (cache-first; the URL hash
   is the cache key).
2. **Network-first for navigations**, falling back to the cached shell or
   an `offline.html` only when the network fails
   ([Workbox app-shell](https://developer.chrome.com/docs/workbox/app-shell-model),
   [workbox-recipes pageCache](https://developer.chrome.com/docs/workbox/modules/workbox-recipes),
   [offline-cookbook](https://web.dev/articles/offline-cookbook)).
3. **Never cache authed HTML.** Cache Storage is origin-scoped with no
   notion of "which user" — the defense is a navigation allowlist: serve the
   shell fallback only for authenticated app routes (`/b/*`, `/w/*`, `/u/*`,
   `/profile`, `/search`); network-only for `/sign-in`, `/auth`, `/invite`,
   `/api/*`, `/mcp/*` (Excalidraw's `navigateFallbackAllowlist` pattern —
   [excalidraw vite.config](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/vite.config.mts)).
   The shell is user-agnostic markup; user data comes from the per-browser
   IndexedDB store, auth-checked at the API layer.
4. **Never cache `cache-control: no-store` responses** (SvelteKit's SW does
   exactly this check before `cache.put` —
   [svelte.dev/docs/kit/service-workers](https://svelte.dev/docs/kit/service-workers)).
5. **Skip navigation preload** once an HTML fallback exists — Workbox is
   explicit that it's only for SWs that pass navigations through to the
   network ([navigation-preload](https://developer.chrome.com/docs/workbox/modules/workbox-navigation-preload)).

Reference implementations read from source:

- **SvelteKit** (closest SSR analogue): version-scoped cache
  `cache-${version}`; precache immutable assets; activate deletes
  non-current caches; network-first with cache fallback elsewhere. Two
  SSR-critical notes: the SW is bundled for production but not dev; and
  "client-side navigations are neither" full-page navigations, so SPA
  route changes **never trigger the browser's SW update check** — they
  recommend `registration.update()` on navigation.
- **SVGOMG** (Jake Archibald, hand-rolled): `expectedCaches` allowlist,
  delete-on-activate, and **conditional `skipWaiting()`** — only for
  same-major-version updates ([svgomg sw](https://github.com/jakearchibald/svgomg/blob/master/src/js/sw/index.js)).
- **Squoosh** (GoogleChromeLabs): versioned caches, engagement-gated
  precaching of heavy WASM, message-driven `skipWaiting` (user consent)
  ([squoosh sw](https://github.com/GoogleChromeLabs/squoosh/blob/dev/src/sw/index.ts)).

## Update flow — the current SW's biggest risk

Lifecycle mechanics: an updated SW installs alongside the old one and
**waits**; a page refresh is not enough to activate it
([service-worker-lifecycle](https://web.dev/articles/service-worker-lifecycle)).
`skipWaiting()` takes over immediately, but "your new service worker is
likely controlling pages that were loaded with an older version… If this
might break things, don't use `skipWaiting()`" — lazily-loaded subresources
can break until the next navigation
([workbox lifecycle](https://developer.chrome.com/docs/workbox/service-worker-lifecycle)).

vite-plugin-pwa's `autoUpdate` docs carry the warning that matters here:
"the user can lose data in any browser windows/tabs in which the
application is open and is filling in a form. If your application has
forms, we recommend… `prompt`"
([auto-update](https://vite-pwa-org.netlify.app/guide/auto-update.html)).

**Flowdeck today:** unconditional `skipWaiting()` + `clients.claim()` with
no reload — a mid-session takeover can mix old-page/new-SW fetch handling
with zero user visibility, while the outbox holds unsynced edits. This is
the riskiest part of the current SW.

**The outbox-aware pattern (contract for the implementation PR):**

- New SW waits; the page shows an "Update ready" chip.
- If the outbox is empty → apply on next navigation (message-driven
  `skipWaiting`, Squoosh-style).
- If edits are pending → apply after the outbox drains, or on explicit
  user action.
- Reload once on `controllerchange` with a re-entrancy guard (multi-tab
  `controllerchange` storms can loop) —
  [workbox-window](https://developer.chrome.com/docs/workbox/modules/workbox-window).
- Serve `sw.js` with `Cache-Control: max-age=0`
  ([fresher-sw](https://developer.chrome.com/blog/fresher-sw)).
- Add SPA update checks: `registration.update()` on client-side navigation
  (or hourly) — client-side routes never trigger the browser's check
  ([svelte.kit sw docs](https://svelte.dev/docs/kit/service-workers)).

## Offline UX patterns

Platform guidance
([offline-cookbook](https://web.dev/articles/offline-cookbook),
[learn/pwa serving](https://web.dev/learn/pwa/serving)):

- Never block on the network for content you already have; don't
  "disappear" something the user is reading (insert new content above,
  preserve scroll).
- Honest failure states: an "Unavailable while offline" page for
  documents; network-only for "things that have no offline equivalent,
  such as analytics pings, non-GET requests".

Real products (verified from primary pages):

- **Figma** — offline-for-arbitrary-time with replay-on-reconnect (above).
- **Google Docs** — offline is opt-in per device, and surfaces a
  **per-document status indicator** (the cloud icon next to the title):
  make offline a visible, per-artifact state, not a hidden global
  ([docs offline](https://support.google.com/docs/answer/6388102)).
- Linear/Notion/Slack/Trello/Airtable offline pages: moved or 404 —
  reported as gaps, not asserted.

**Synthesized pattern set for Orbit (the UX contract):**

1. **Connection banner** — passive chip ("Offline — changes will sync"),
   never a modal, never blocks editing.
2. **Last-synced timestamp** — per-board, from the entity store's sync
   watermark (Google Docs' per-doc status is the precedent).
3. **Pending badges on optimistic mutations** — cards/fields with outbox
   entries get a subtle syncing state that resolves on ack.
4. **Disabled vs hidden** — hide actions that are meaningless offline
   (invites, anything requiring server truth); keep editing enabled since
   the outbox makes it safe.
5. **Reconnect flow** — replay outbox, then refresh server state (Figma's
   fresh-download-then-reapply), resolve/flag conflicts visibly.

## Cache versioning, quota, eviction

Every reference implementation converges on: **version-scoped cache names

- an expected-caches allowlist + delete-on-activate**
  ([offline-cookbook "On activate"](https://web.dev/articles/offline-cookbook)).
  Flowdeck's image cache is bounded but uses a static name with no
  activate-time cleanup — fine while it's the only cache; the allowlist
  pattern must land with precaching.

Quota (MDN, current): Chrome/Chromium up to 60% of disk; Firefox
min(10% disk, 10 GiB) best-effort / 50% if persisted; Safari ~60% for
browser apps, and **home-screen-installed web apps get the browser-app
quota** ([storage quotas](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)).
Best-effort data is evicted LRU under pressure; persistent data "is only
evicted… if the user chooses to".

**High-stakes for Orbit:** the outbox holds unsynced user work whose only
copy is IndexedDB. Two APIs:

- `navigator.storage.estimate()` → `{usage, quota}` (approximate) —
  [StorageManager.estimate](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate).
- `navigator.storage.persist()` → protects the SW registration, IndexedDB,
  and cache storage from eviction; Chromium grants via heuristics and
  **PWA installation is one criterion** —
  [StorageManager.persist](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist),
  [persistent-storage](https://web.dev/articles/persistent-storage).

**Contract:** call `persist()` at an engagement moment (install / first
board edit) and monitor `estimate()`.

## Manifest completeness for a kanban app

Current manifest has the basics. Against the
[W3C spec](https://w3c.github.io/manifest/):

| Member                                               | Worth it?                                                                                                       | Evidence                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                 | **Yes** — decouples PWA identity from `start_url` so it can change later                                        | [manifest id](https://developer.chrome.com/docs/capabilities/pwa-manifest-id)                                             |
| `shortcuts`                                          | **Yes** — 2–3, most-important-first ("New card", "My boards"); not on iOS                                       | [shortcuts](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/shortcuts)               |
| `screenshots` + `form_factor`                        | **Yes (moderate)** — unlocks Chrome's richer install dialog; ≥1 per form factor (`narrow`/`wide`) with `label`s | [richer install](https://developer.chrome.com/blog/richer-pwa-installation)                                               |
| `launch_handler`                                     | **Yes (small)** — `focus-existing` complements the existing `notificationclick` focus logic                     | [launch_handler](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/launch_handler)     |
| `display_override`                                   | Noise — plain standalone                                                                                        | [display_override](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/display_override) |
| `share_target`                                       | Skip initially — plausible "share into a card" later; requires SW POST handling, Chromium-only                  | [share_target](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target)         |
| `file_handlers`, `protocol_handlers`, `handle_links` | Noise for a kanban app                                                                                          | —                                                                                                                         |

## Installability edge cases

- **iOS/Safari:** no `beforeinstallprompt`, no browser prompt — manual
  Add to Home Screen; only `standalone` honored; web push (16.4+) works
  **only for Home Screen web apps** and requires direct user interaction
  (Flowdeck's subscribe-button flow already matches);
  `apple-touch-icon` takes precedence over manifest icons (already
  shipped) — [webkit.org iOS push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/),
  [learn/pwa installation](https://web.dev/learn/pwa/installation).
- **Desktop (Chrome/Edge):** install badge in the address bar; only
  `standalone`/`minimal-ui`; installed PWAs get Badging + App Shortcuts.
- **`beforeinstallprompt` UX:** capture → `preventDefault()` → stash →
  show your own UI at an engagement moment → `prompt()` once → read
  `userChoice` for analytics → null the stash. Render iOS manual
  instructions only under `@media (display-mode: browser)`. Detect launch
  mode with `matchMedia('(display-mode: standalone)')` —
  [customize-install](https://web.dev/articles/customize-install),
  [installation-prompt](https://web.dev/learn/pwa/installation-prompt).
  Note: MDN marks the event non-standard/experimental (moved to a WICG
  incubator) but Chrome "has no plans to remove or deprecate" it.

## Recommendations — ranked by impact

1. **Precache the app shell + network-first navigations with cached-shell
   fallback + `offline.html`.** Biggest user-visible win: instant repeat
   loads and a real offline app (boards render from the entity store).
   Version-scoped cache name, allowlist cleanup on activate, `no-store`
   never cached, shell fallback allowlisted to app routes only.
2. **Replace unconditional `skipWaiting()` with the outbox-aware update
   flow** (above). Highest risk-reduction item.
3. **`navigator.storage.persist()` at an engagement moment + monitor
   `estimate()`.** The outbox is the only copy of unsynced work.
4. **Ship the offline UX layer:** connection banner, per-board
   last-synced watermark, pending badges on outboxed mutations.
5. **SPA update checks:** `registration.update()` on client-side
   navigation; `sw.js` served with `Cache-Control: max-age=0`.
6. **Manifest additions:** `id`, 2–3 `shortcuts`, `screenshots` with
   `form_factor` + `label`s, `launch_handler: focus-existing`.
7. **Install prompt UX:** capture `beforeinstallprompt`, in-app install
   affordance at an engagement moment, `userChoice` analytics, iOS
   instructions only in browser display-mode.

## Gaps and uncertainties

- Chrome DevTools frontend ships no production SW (premise unverified —
  only test fixtures exist in the repo).
- Linear's sync-engine talk is video-only; no written SW/offline detail.
- Notion/Slack/Trello/Airtable offline pages moved or 404 — current UX
  claims for those products are unverified.
- web.dev's older "Offline UX considerations" article is 404 in every
  current URL form; guidance was synthesized from the learn/pwa course
  and the offline-cookbook.
- vite-plugin-pwa has no SolidStart-specific guide; the existing
  client-only registration in `PushSetup.tsx` already satisfies the
  general SSR guidance.

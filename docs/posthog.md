# The PostHog project — settings, environments, and flag governance

The operational record of Orbit's PostHog integration (ADR-8 chose the
stack; ADR-17 defines the flag contract; the runtime is
`src/lib/flags/`). What exists, how it is configured, and who may change
what — so "why is this set this way" never needs re-deriving.

## The project

One PostHog Cloud project, **Free (no-card) tier**. Free monthly
allowances are the design constraint, not an accident:

| Allowance       | Limit (free tier)             | Consequence in this repo                                                                                                                                     |
| --------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Events          | 1M/mo                         | the lean taxonomy + batched sinks ([`observability.md`](./observability.md) rule 1)                                                                          |
| Flag requests   | 1M/mo (first bucket included) | request-scoped SSR evaluation, lazy: a route that reads no flag makes no `/flags` call; workspace override changes reload once per switch, not per component |
| Session replays | 5K/mo                         | 10% sampling + trigger groups (the replay budget in [`data-playbook.md`](./data-playbook.md))                                                                |

The **no-card** posture is deliberate: usage stops at the free limits
instead of billing, so quota exhaustion is a "flags fall back, replays
stop" event, never an invoice. Every registered flag declares the
fallback served in that state ([`feature-flags-and-ui-playground.md`](./feature-flags-and-ui-playground.md)).

- **No Group Analytics** — a paid add-on billed across all identified
  events (excluded by ADR-8's $0 rule). The project has no group types;
  workspace targeting uses the transient person-property override
  instead. Do not enable it.
- **Privacy posture (project settings):** IP anonymization ON (PostHog
  drops the IP from every ingested event); session recording ON with
  10% baseline sampling, 100% on signup/onboarding/invite URLs, and
  100% of exception sessions (event trigger) — the SDK config masks
  every text node, attribute, and input in a recording; autocapture ON
  for the friction signals with `mask_all_text` +
  `mask_all_element_attributes` (dead/rage clicks are read as rates per
  element, never as content); a test-account filter excludes internal
  traffic from insights. The taxonomy's no-PII rule is the parent
  policy ([`observability.md`](./observability.md) rules 2–3).
- **Server-side flag evaluation** uses the public `POST /flags?v=2`
  endpoint (project token only, no secret on the evaluation path, no
  sensitive data returned). Verified live: distinct-ID conditions and
  `person_properties` overrides evaluate as documented.
- The browser SDK (`posthog-js`) is initialized flags-only
  (`autocapture`, pageview/leave capture, and session recording OFF)
  until the telemetry sink lands with its privacy config — reviewed in
  the observability PR, not here.

## Environments: one project, one property

Preview and production share this single project (the free tier's
one-project limit). Separation is an event property, not a project
split:

- **Every event carries `app_environment`**: `preview` | `production`,
  registered as a super property by the telemetry sink from the
  `VITE_APP_ENV` build value (baked per environment by CI, like the
  Supabase vars; absent = local dev, which sends nothing anyway).
  Dashboards and weekly-review filters segment on it; preview traffic
  (Cloudflare Access-gated, ~1 user) never mixes into production tiles.
- **Flag configuration is shared across environments.** A rollout change
  applies to preview and production simultaneously — there is no
  per-environment flag config. The mitigation is procedural, from
  [`data-playbook.md`](./data-playbook.md)'s rollout ladder: target the
  maintainer's account first (canary — preview and prod both, but one
  user), watch guardrails on the `preview`-filtered tiles, then broaden.
  A flag change is a production change: treat it with the same review.
- Server-side evaluation context is identical on both environments:
  `distinct_id` = the Orbit user UUID of that environment's Supabase
  project (the same human has different UUIDs on preview and prod —
  exact-ID flag conditions must list both).

## Flag governance

**Who may change production flags:** the maintainer, and only through a
deliberate change — flag edits are reviewed like code. PostHog project
access is the maintainer's account alone; no service account can edit
flags. A flag change that alters user-visible behavior ships paired with
the PR that consumes it, never as a quiet dashboard edit.

**Required metadata** — every flag carries all of it, in BOTH places:
the typed registry (`src/lib/flags/registry.ts`, the source of truth)
and the PostHog flag's description (for dashboard visibility):

| Field    | Meaning                                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Purpose  | release / operational kill switch / permission / experiment                                                                       |
| Scope    | user or workspace (workspace rules: exact IDs, 100% rollout)                                                                      |
| Owner    | the responsible maintainer                                                                                                        |
| Expiry   | removal/review date; permanent flags say why (lifecycle table in [`data-playbook.md`](./data-playbook.md))                        |
| Fallback | the exact value served when evaluation is missing/timed out/quota-limited/unknown — deny for permissions, existing UI for release |
| Rollback | the exact behavior the fallback restores and how to trigger it                                                                    |

**Rules:**

1. The registry is code. Adding a flag = a registry entry in the PR
   that consumes it + the PostHog flag created with the metadata above.
   A key rename is a migration. At 100%, the flag is done: remove the
   branch, delete/archive the flag, clean the registry.
2. The removal task is created at flag creation (an issue or the PR
   checklist item), per the lifecycle discipline.
3. PostHog flags we don't register are ignored (evaluation reads only
   registry keys); registered keys must exist in PostHog or they resolve
   to their declared fallback (with a bounded diagnostic in Workers Logs).
4. Permission flags fail closed and never replace server authorization
   or RLS ([ADR-17](./adr.md)).
5. Never send PII to PostHog — the distinct ID is the Orbit user
   UUID. Flag conditions target UUIDs (`distinct_id`), never emails;
   the event property allowlist is the taxonomy.

## Current flags

**None.** The registry (`src/lib/flags/registry.ts`) is deliberately
empty: playground access is environment-gated (ADR-17's amendment — the
preview deployment is already Cloudflare-Access-gated to the maintainer,
so `VITE_APP_ENV` decides and production always 404s; no PostHog flag is
involved). A flag registers only with the PR that consumes it — the
redesign's release flags arrive with the first redesigned surface.

## The first-party ingest proxy

The browser SDK points at **our own origin** (`api_host` =
`window.location.origin` + the `/ingest` path prefix), and the worker's
middleware forwards ONLY the SDK's known endpoint families to
`POSTHOG_HOST` — event ingest (`e`), `batch`, `decide`, client flag
evaluation (`flags`), session recording (`s`), the v1 ingest API
(`i/v0`), `surveys`, `trackers`, and the `/static/*` loader assets.
Why: most ad blockers match `*.posthog.com` by default, so direct
delivery silently loses data; a same-domain path beats those lists
(not every list — generic `/ingest` patterns exist — but the big win is
first-party delivery).

The leg is deliberately not a dumb pipe, for two session-safety and
hygiene reasons:

- **Nothing browser-sent reaches upstream except Content-Type.** The
  browser sends these requests with the app's own cookies (the Supabase
  session JWT among them) and auth headers; the proxy drops all of
  them, and strips any upstream `Set-Cookie` from the response —
  PostHog never reads our credentials nor writes cookies on our origin.
- **It is not a generic relay.** An unmatched `/ingest/*` path is a 404,
  and a best-effort per-isolate rate limit (120 req/min/IP) caps abusive
  clients; Cloudflare's edge remains the global backstop.

Cost: **$0 at our scale** — the Workers free tier allows 100k
requests/day, far above our traffic; even outgrowing it would mean the
$5/mo plan's 10M/mo. Cloudflare charges no egress bandwidth, so
forwarding is free. Server-side evaluation does NOT ride the proxy
(`POSTHOG_HOST` direct from the worker — servers have no blockers).

## Runtime wiring (where the values live)

The browser SDK runs **cookieless** (`cookieless_mode: 'always'` in
`src/lib/telemetry.ts`): no `ph_*` cookies, no localStorage identity —
the distinct ID is a per-session random UUID. Analytics can never
re-identify a person across sessions, which is what the privacy policy
claims; the config is the enforcement, not the prose. The project's
PostHog setting must match (Settings → Data management → cookieless
"always") so server-side ingestion agrees with the client.

| Variable                                 | Where                                                                                                                   | Visibility                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `VITE_POSTHOG_KEY`                       | GitHub environment variable (`preview` and `production` — same value, one project)                                      | public by design                    |
| `VITE_APP_ENV`                           | GitHub environment variable per deployment (`preview` / `production`) — the `app_environment` event property            | public                              |
| `POSTHOG_HOST`                           | `wrangler.jsonc` vars (both environments)                                                                               | public                              |
| `POSTHOG_KEY`                            | `wrangler secret put POSTHOG_KEY` (per env) — publishable value, kept out of the repo like the Supabase publishable key | public-by-design, repo-external     |
| `POSTHOG_HOST`, `POSTHOG_KEY`, `APP_ENV` | Supabase function secrets per project (the MCP edge function's server-side capture)                                     | key public-by-design, repo-external |

`VITE_POSTHOG_KEY` and `POSTHOG_KEY` hold the SAME project token and
MUST match — one is the build-baked copy for the browser SDK, the other
the worker secret for server-side evaluation. A mismatch shows up as
flags resolving to fallbacks on one side only.

Absent values are a supported state (local dev, PR builds): the client
SDK no-ops and flag evaluation resolves declared fallbacks — nothing
crashes, nothing calls PostHog. PR CI builds never need the values
(ADR-15 unchanged).

The MCP edge function captures `mcp_tool_call` server-side (the
taxonomy's agent row); its values live as Supabase function secrets per
project: `POSTHOG_HOST`, `POSTHOG_KEY`, and `APP_ENV` (`preview` /
`production` — the same split, server-side). Absent values skip the
capture; tool calls never fail or wait on telemetry beyond a 1s
timeout.

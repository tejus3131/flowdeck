# Feature flags and UI playground

The implementation contract for the redesign flags and the developer-only
variant gallery. This extends [the data playbook](./data-playbook.md)'s
rollout policy and [L5](./layers/l5-views.md)'s flag rule. The flag runtime
is integrated — the typed registry, request-scoped evaluation, and client
override lifecycle live in `src/lib/flags/` (one project, one
`app_environment` property: [posthog.md](./posthog.md)) — and the
playground is built: `/playground/*` (gallery, tokens, components) is
environment-gated (ADR-17's amendment: preview deployments and local
dev) and renders the production components and tokens from synthetic
fixtures.

## What the research says

The useful pattern across public design systems is a **catalogue**, not a
single showcase page:

| Reference                                                                               | Pattern worth borrowing                                                                                                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Storybook](https://storybook.js.org/docs/sharing/publish-storybook)                    | Stories can be built as a static site for design/development review. Hosting and access control are separate concerns; `noindex` only affects crawlers, not access. |
| [GitHub Primer](https://primer.style/)                                                  | Distinguish product UI, brand UI, and shared foundations; keep tokens/primitives reusable across surfaces.                                                          |
| [Material Web](https://material-web.dev/components/button/)                             | Give each component its own page, show variants together, and include usage and accessibility guidance.                                                             |
| [Atlassian Design System](https://atlassian.design/components/)                         | Make the component index navigable by category and communicate lifecycle status.                                                                                    |
| [Radix Themes](https://www.radix-ui.com/themes/docs/components/theme)                   | Treat appearance, gray, accent, radius, and scale as explicit axes that can be changed around a subtree.                                                            |
| [IBM Carbon](https://carbondesignsystem.com/building-blocks/foundations/color/overview) | Keep semantic token roles stable while themes supply different values.                                                                                              |

These are public design-system references, not evidence that Linear, Figma,
Notion, or other products use a particular internal gallery. We found no
publicly documented example establishing a standard "404 unless in a
feature-flag cohort" pattern. The route and access rules below are Flowdeck's
design, grounded in ordinary server-side authorization principles.

Feature-flag guidance converges on separating the **decision** from the
feature implementation, classifying toggles by purpose/lifetime, testing
both sides, and removing temporary toggles. See [Fowler's feature-toggle
article](https://martinfowler.com/articles/feature-toggles.html). PostHog's
current docs add constraints important to this deployment:

- The first **1,000,000 flag-evaluation requests per month** are currently
  included. Keep the project on PostHog's no-card Free tier: usage stops at
  free limits, so quota exhaustion must follow each flag's safe fallback.
  Monitor request volume against the allowance. See
  [flag cost guidance](https://posthog.com/docs/feature-flags/cutting-costs)
  and [pricing](https://posthog.com/pricing).
- Server-side remote evaluation is a request to PostHog each time flags are
  evaluated. PostHog specifically cautions against local-evaluation clients
  created for each edge/Lambda invocation: their in-memory definition cache
  is lost between invocations. See [local evaluation](https://posthog.com/docs/feature-flags/local-evaluation).
- Server-rendered values can be bootstrapped into the browser SDK to avoid
  a variant flash, but server and browser must use the same distinct ID and
  relevant properties. See [bootstrapping flags](https://posthog.com/docs/feature-flags/bootstrapping).
- For an actual PostHog experiment, accessing the assigned value through
  `getFeatureFlag()` (or server-side `evaluateFlags()` / `getFlag()`)
  records exposure; retrieving all flags alone does not. See [adding
  experiment code](https://posthog.com/docs/experiments/adding-experiment-code).

## Flag contract

### One decision boundary

All application code reads typed decisions through one Flowdeck-owned
interface. UI components do not import a PostHog SDK or name PostHog flag
keys directly. The provider adapter translates the remote configuration to
the app's typed registry; tests inject deterministic values without network
calls.

Each registered flag records:

| Field             | Required meaning                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Key and type      | Stable key plus boolean or finite variant union. Renaming a key is a migration.                           |
| Purpose           | Release, operational kill switch, permission/beta, or experiment. One purpose per flag.                   |
| Safe fallback     | Explicit behavior when evaluation is missing, times out, is quota-limited, or returns an unknown variant. |
| Scope             | User for personal UI; workspace for collaborative surfaces where teammates need a consistent experience.  |
| Owner and expiry  | A responsible maintainer and removal/review date. Permanent flags require an explicit reason.             |
| Rollback behavior | The exact route or behavior the fallback restores.                                                        |

The public application layer should expose a single typed accessor (conceptually
`flag("board-redesign")`), backed by a request-scoped snapshot on the server
and a matching client context. A component selects a variant; it does not
perform evaluation or decide how failures are handled.

### Targeting unit: person or workspace

Within PostHog's free monthly flag-request allowance, person-targeted
evaluation can receive context-specific person properties. Use that to
filter by the active workspace without turning on Group Analytics:

| Flowdeck need                      | Evaluation identity and context                                                            | Behavior                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Personal UI (a per-account switch) | `distinct_id = user UUID`; no workspace property                                           | Per-account access and rollout.                                                          |
| Workspace-specific UI switch       | `distinct_id = user UUID`; person property `flowdeck_workspace_id = active workspace UUID` | An exact workspace-ID condition applies to every member when the rule's rollout is 100%. |

(The playground is NOT in this table — its access is environment-gated,
not a flag; see the access policy below.)

A cohort is a set of people, not a workspace. For Flowdeck, send the
verified active workspace as a transient person-property override:

1. Server-side, keep Flowdeck's authenticated user UUID as the PostHog
   distinct ID and evaluate with
   `personProperties: { flowdeck_workspace_id: verifiedWorkspaceId }`.
   Derive the workspace from the verified board/workspace relationship,
   never directly from an untrusted URL parameter.
2. In the browser, call
   `posthog.setPersonPropertiesForFlags({ flowdeck_workspace_id: workspaceId })`
   for the active workspace. PostHog documents that this is sent with flag
   requests, is not persisted on the person or emitted as a `$set` event,
   and triggers flag reload by default. The override is stored in the
   browser SDK's local persistence, is additive, and remains until replaced
   or reset. Update it only when the active workspace changes, not from
   components, to avoid redundant `/flags` requests. When no workspace is
   active or the user signs out, call
   `posthog.resetPersonPropertiesForFlags()` and then
   `posthog.reloadFeatureFlags()`; web reset does not reload automatically.
3. On workspace switch, refresh the workspace property and wait for the
   corresponding flags to resolve before rendering the new workspace's
   variant. Bootstrap SSR decisions from the same user ID and verified
   workspace property to prevent a stale or mismatched first render.

**Important limit:** person-property filters are not group bucketing.
PostHog's user-targeted rollout percentage and multivariate assignment hash
the user's distinct ID. A percentage rollout can therefore split members
of one workspace even when all of them send the same workspace property.
For a manual workspace-specific switch or variant, add an exact
`flowdeck_workspace_id` condition and set its rollout to 100%. For a
multivariate flag, assign 100% of that condition's variant allocation to
the chosen variant. Do not use a percentage-based user rollout for
collaborative surfaces. Verify that two different users in the same
workspace receive the same exact-match rule, and that switching workspaces
causes a fresh evaluation. Do not add a broader user-targeted fallback to a
workspace-scoped flag; missing workspace context must return its declared
control fallback, not silently split teammates by user.

**Strict $0 boundary:** do not enable PostHog Group Analytics. It is a paid
add-on billed across all identified events, not just events carrying group
properties. The free person-property override approach above is the
supported workspace filter for explicitly targeted workspaces; it does not
provide native percentage rollout or randomization by workspace.

If workspace-randomized experiments become necessary under the $0 limit,
use a Flowdeck-owned deterministic assignment keyed by
`(experiment key, workspace UUID)` and emit exposure/outcome events with
both the person identity and workspace ID as ordinary event properties.
That is not a native PostHog group experiment: PostHog's experiment
assignment/analysis is not workspace-level without Group Analytics.
Keep this behind the typed flag boundary and make the assignment and
analysis method a separate implementation decision before launching.

### Defaults are explicit and fail safe

There is no universal safe value; each flag declares its fallback:

| Kind                         | Fallback when no valid value is available          |
| ---------------------------- | -------------------------------------------------- |
| Release / redesign           | Existing production UI (`control`).                |
| Optional operational feature | The documented safe/degraded path, often disabled. |
| Permission (beta/premium)    | Deny.                                              |
| Experiment                   | Control variant; no assignment means no exposure.  |

Validate returned multivariate values against the registry. Unknown values
use the declared fallback and emit a bounded diagnostic, never an arbitrary
variant. PostHog quota limiting can return empty flag values; the application
must remain usable under the fallbacks above. Keep the project on the
no-card Free tier and monitor usage before production rollout.

An application-level kill switch is only as fast and reliable as the
evaluation path. Remote flags cannot promise an immediate change for an
already-rendered page or when PostHog is unreachable. Keep a safe fallback
in code, and do not use a remote flag as the sole emergency control for
security, data integrity, or a time-critical operational incident.

### Evaluation, SSR, and exposure

1. Resolve the authenticated identity before evaluating person-targeted
   flags. Use Flowdeck's stable user UUID as the PostHog distinct ID; never
   use email, names, message content, or other PII as flag properties.
2. Resolve a request's needed flags once and keep the result in that request's
   context. Never put user-specific decisions in a module-global Worker
   cache. Do not initialize a polling PostHog client per component or per
   flag.
3. Render the selected route/surface on the server from the same decision
   snapshot the browser receives. Bootstrap only the values needed by the
   client SDK, using the same distinct ID. A client-only check is too late
   for route gating and can flash the wrong surface.
4. The foundation PR must measure flag request volume and latency on the
   actual Cloudflare Worker runtime. PostHog's docs caution against
   per-invocation local evaluation in edge environments; do not assume a
   Node process cache or introduce a cron/KV system without measured need.
   Verify SDK behavior and budget before choosing remote evaluation,
   shared-definition caching, or another strategy.
5. For workspace-scoped surfaces, evaluate with the user distinct ID plus
   the verified current workspace as a transient person-property override.
   Never reuse a result from a previous workspace. Exact workspace rules must use 100% rollout and, for
   multivariate flags, a single 100% variant; user-based percentages are
   not workspace-stable.
6. Normal release routing must not accidentally count as an experiment
   exposure. When an experiment is intentionally launched, its production
   code reads the assigned value through PostHog's exposure-recording API.
   Pre-register the primary metric and duration. Collaborative experiments
   need workspace-level assignment; under the $0 rule this requires a
   Flowdeck-owned assignment as described in [the playbook](./data-playbook.md).

For whole-page redesigns, branch at the route/surface boundary so the server
renders only the selected experience. For smaller component variants,
select at the narrowest stable boundary. Keep variants in separate modules
when they are large: Solid's [`lazy`](https://docs.solidjs.com/reference/solid-js/components-context/lazy)
loads a module on first render and supports preloading. The playground is
the exception: it intentionally renders multiple variants together, so its
route can load those modules as needed. Code splitting improves delivery;
it is not an access-control mechanism.

Flags may gate a user-visible journey or its entry point. They must not
replace authorization checks in server functions or database RLS, nor may
they change the meaning of persisted data. A journey flag needs a coherent
fallback for in-progress users and should be checked at the relevant server
boundary as well as in the UI when server behavior changes.

## Developer-only playground

### Access policy

The playground is a separate developer-preview surface at `/playground/*`.
Every route and data loader must pass a **server-side** access check before
rendering or returning data. Unauthorized requests receive the same normal
404 response as an unknown route; do not rely on hiding navigation, client
flags, or `noindex`.

Access is **environment-gated** (ADR-17's amendment — this replaced the
original server-evaluated permission flag, which carried setup cost and a
PostHog dependency for a one-person cohort):

- The preview deployment IS the developer cohort: it is already Cloudflare
  Access-gated to the maintainer, so the playground renders when
  `VITE_APP_ENV` is `preview` and local dev builds (`import.meta.env.DEV`)
  may show it for development.
- Production always returns the normal 404 — the environment value is
  baked at build time, so no runtime failure can open the gate on prod.
- The check runs in every route's preload (server-side) and the same baked
  value drives the hydrated render, so server and client agree by
  construction.
- A feature flag was never a security boundary for sensitive data or code
  either — if the gallery ever contains information that must be
  confidential, add a separate server permission or Cloudflare Access. The
  playground uses synthetic data and its built client chunks are not secret.
- Add `X-Robots-Tag: noindex` to the playground and its not-found response
  as crawler hygiene, not as security.

The gallery must use deterministic, synthetic fixtures by default. Never
render real workspace content in a developer gallery. Page access does not
make bundled client code secret; do not put credentials, private data, or
security-sensitive behavior in a gallery module.

### Information architecture

Use the same components that production imports; do not create a parallel
component implementation or a second design system.

```text
/playground
  /tokens              token sets and visual foundations
  /components           component index
  /components/:name     props, states, and variants for one component
  /surfaces             board, card, profile, landing-page explorations
  /surfaces/:name       comparable full-surface variants
  /journeys             optional multi-step flow previews
```

Each component/surface page should:

- Render comparable variants side by side using the same fixture, viewport,
  theme, and state. Label each variant and its lifecycle status
  (`exploration`, `candidate`, `shipping`, `retired`).
- Include relevant states, not just the happy path: empty, dense, loading,
  error, keyboard/focus, disabled, and dark theme where applicable.
- Show the token set and variant key being previewed. Use scoped token
  overrides (for example `data-token-set`) rather than hard-coded colors;
  token roles remain shared while candidate sets change their values.
- Keep interactions safe and local. No production mutations, real chat
  posts, or stateful actions against customer data.

The token decision playground in [design-playground.md](./design-playground.md)
resolves P1–P4 in real-density surfaces. It is a focused part of this
catalogue, not a substitute for the component and surface pages described
here.

### Keep previewing separate from rollout

The playground always allows an authorized developer to compare candidates,
independent of their production assignment. It must not be used to manually
override another user's production flag. Production rollout remains a
server-evaluated, typed flag decision. Local preview controls are explicit,
non-persistent, and cannot change another account's assignment.

This separation enables future experiments without implementing one now:
keep variant modules and flag values stable, add exposure recording only
when an experiment is registered, and preserve the playbook's workspace
randomization and sample-size/qualitative guardrails. A screenshot gallery
is evidence for design review, not evidence of user benefit.

## Test and lifecycle requirements

The flag foundation and every flagged UI PR should demonstrate:

1. Tests for each meaningful flag state and its failure fallback, with
   PostHog fetching disabled in tests.
2. SSR output and hydration agree on the selected variant; no initial
   default flash or different user identity between server and client.
3. The old production route remains reachable through the release flag's
   control value until rollout and rollback criteria are met.
4. Unauthorized playground requests return HTTP 404 before route data is
   returned; access-check errors also deny.
5. Release and experiment flags have expiry/removal work recorded when
   created. At 100%, remove the old branch after the agreed observation
   window and delete/archive the flag; permanent operational and permission
   flags get periodic review.

No experiment runs by default. The current policy remains
ship-and-observe, with the holdout and qualitative checks in the
[data playbook](./data-playbook.md).

## References

- [PostHog: pricing and free allowances](https://posthog.com/pricing)
- [PostHog: feature flag costs and quota limiting](https://posthog.com/docs/feature-flags/cutting-costs)
- [PostHog: person/group flag targeting and rollout identity](https://posthog.com/docs/feature-flags/user-and-group-targeting)
- [PostHog: property overrides for flag evaluation](https://posthog.com/docs/feature-flags/property-overrides)
- [PostHog: Group Analytics billing](https://posthog.com/docs/product-analytics/group-analytics)
- [PostHog: creating feature flags](https://posthog.com/docs/feature-flags/creating-feature-flags)
- [PostHog: server-side local evaluation](https://posthog.com/docs/feature-flags/local-evaluation)
- [PostHog: bootstrapping flags](https://posthog.com/docs/feature-flags/bootstrapping)
- [PostHog: recording experiment exposures](https://posthog.com/docs/experiments/adding-experiment-code)
- [PostHog: Cloudflare Workers](https://posthog.com/docs/libraries/cloudflare-workers)
- [Pete Hodgson: Feature Toggles](https://martinfowler.com/articles/feature-toggles.html)
- [Storybook: publishing Storybook](https://storybook.js.org/docs/sharing/publish-storybook)
- [Primer](https://primer.style/)
- [Shopify Polaris](https://shopify.dev/docs/api/polaris)
- [Atlassian Design System](https://atlassian.design/components/)
- [Material Web buttons](https://material-web.dev/components/button/)
- [Radix Themes](https://www.radix-ui.com/themes/docs/components/theme)
- [IBM Carbon color tokens](https://carbondesignsystem.com/building-blocks/foundations/color/overview)
- [Solid `lazy`](https://docs.solidjs.com/reference/solid-js/components-context/lazy)
- [Cloudflare Access account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/)
- [Cloudflare Access self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

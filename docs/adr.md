# Architecture decision records

Each ADR: context → decision → consequences. Decisions here are **locked**
— reopening one requires a new ADR that supersedes it, never an edit.

## ADR-1: Normalized entity store as client truth

**Context.** The unit of sync was the snapshot (`BoardSnapshot`), and the
cache held view blobs (`ws-detail:${id}`). A tag rename — one row — forced
a full re-snapshot per viewer per board, a 500ms-debounced window re-fetch
on the tag page, a 10s-poll on timelines, and a memo hack to force `<For>`
rebuilds. Surfaces updated on different clocks because each re-derived
"what changed" from raw table events and re-fetched its own copy.

**Decision.** One Solid store holds entities by `type:id` — `tags[id]`,
`cards[id]`, `members[id]`, join rows as their own entries. Views derive
from selectors (`tagById(id)`); a component reading a selector re-renders
the instant the store entry changes. The sync engine's `view()` becomes a
projection over the store.

**Consequences.** A rename is one store write; every chip, feed, and
timeline updates in the same frame with zero network. The merge paths in
`sync.ts`/`board-fold.ts` move from snapshot-shapes to entity keys — a
real rewrite of their internals (semantics unchanged). Selectors must stay
cheap (memoized); the store is written only from L3 merge paths and L1
event decode.

## ADR-2: Per-entity cache keys

**Context.** `cache.ts` stored whole snapshots under view-shaped keys;
the same card existed in the board snapshot, the chat cache, and the
comment cache — three copies to invalidate.

**Decision.** IndexedDB keys become `type:id` per entity (plus join rows
and bounded stream pages). The existing cache module survives — re-keyed,
same LRU/TTL posture, same "never blocks the open" rules.

**Consequences.** Entity survives navigation; one write updates every
consumer. Cache version bumps wipe per shape change (unchanged). Stream
pages (chat: 100, comments: 30) stay bounded per performance-rules 11.

## ADR-3: Typed row events on scoped topics; resync is a fallback

**Context.** `boardStream` subscribed to `tags` unfiltered; any rename
pushed `{kind:'resync'}` → 6-query re-snapshot × viewers × boards. Join-row
changes (`card_tags`, `card_assignees`) triggered `card-touch` — a fresh
`CardView` fetch per touched card per viewer.

**Decision.** Topics are scoped (board topic, workspace topic); events are
typed rows: `{entity:'tag', id, op:'update', patch}` and join rows ship in
the event, applied in O(1). `resync` remains only for
visibility-shaping changes and the periodic drift bound.

**Consequences.** Rename = one tiny broadcast. The fold grows event kinds
(it was built pure for exactly this). `card-touch` survives only for
genuine whole-row re-derivation (comment stats move to ADR-7 counters).

## ADR-4: One events table (Jira changegroup pattern)

**Context.** Three overlapping systems: `activity` (legacy since 0032 moved
the revision to `board_revisions`), `card_events` (card audit trail), and
read-time `position()` string scans over message bodies for the tag
capsule — unindexable, re-scanned per page.

**Decision.** One `events` table: actor, entity type/id, kind, `detail`
jsonb carrying `{id, name}` snapshots (the 0058 pattern, generalized),
scoped refs (workspace/board/card). `card_events` folds in via additive
migration; `activity` retires; backlinks and the tag capsule read from the
log; timelines subscribe live (the table is realtime-published).

**Consequences.** One event vocabulary; the 10s timeline poll dies; the
capsule becomes an indexed cursor read. Jira's lesson kept: store the id
_and_ the display snapshot at write time so history renders even when the
entity is gone.

## ADR-5: Single write path — decompose `mcp_exec`

**Context.** `mcp_exec` is ~2,000 lines of PL/pgSQL, redefined wholesale in
32 of 73 migrations; every mutation exists twice (web server fn + MCP
branch); every feature PR rewrote the monolith.

**Decision.** Each op becomes its own DB function (`mcp_create_card`,
`mcp_move_card`, …); `mcp_exec` becomes a ~50-line dispatcher. Web server
fns call the same per-op functions — web and MCP cannot drift.

**Consequences.** A new op = one small migration touching one function.
The MCP edge function's tool list maps 1:1 onto ops. Notification fan-out
and event logging live inside the per-op functions (one place).

## ADR-6: Outbox engine semantics unchanged

**Context.** The engine implements the Figma write model: instant local
apply, guards against unacked conflicts, ACK, echo retirement, provisional
remote ops with TTL revert. It is the asset, not the debt.

**Decision.** Semantics are locked. Only the payload shapes move (entity
keys instead of snapshot keys — ADR-1).

**Consequences.** No CRDTs (conflict surface is position/ordering, already
handled by outbox + last-write-wins). No bought sync engine (they'd discard
the write path and need a container host — see ADR-9).

## ADR-7: Materialized counters

**Context.** Every snapshot ran `board_card_comment_stats` — an aggregate
RPC — as one of its six queries.

**Decision.** Comment counts (and similar aggregates) become small
counter rows maintained by triggers in the same transaction as the change.

**Consequences.** Snapshot loses a query permanently; counters are
consistent (transactional) and ride row events like any entity.

## ADR-8: Observability = PostHog free + Workers Logs + perf counters

**Context.** Passion project, $0 budget. Needs: product analytics, feature
flags, experiments, session replay, error tracking, MCP usage profiling.

**Decision.** PostHog Cloud free tier (1M events/mo, 1M flag requests, 5K
replays, 100K exceptions — hard-capped, no surprise bills). Server logs:
Workers observability (already enabled). Perf marks (`perf.ts`) gain a
sink that batches p50/p95 into PostHog counters. Every MCP `tools/call`
emits an event (tool, op, workspace, latency, ok). Replays sampled at 10%.

**Consequences.** Experiments run on the redesign via flags. Keep events
lean (the 1M/mo evaporates on verbosity). Axiom Personal (500GB/mo) is the
escape hatch if log retention beyond Workers' 3 days is ever needed.

## ADR-9: Non-goals (explicit)

**Decision.** Not adopting: CRDTs (Yjs/Automerge) — the outbox covers the
conflict surface; client SQLite/WASM — the entity store + IDB covers the
read cache at this scale; multi-tab single-writer (Notion's SharedWorker
corruption trap) — noted, deferred until multi-tab matters; bought sync
engines (PowerSync/Zero/Electric/Triplit) — they discard the write path and
need container hosting the free stack doesn't have.

**Consequences.** Each non-goal has an escape hatch: the connection ceiling
(ADR-10), the cache ceiling (version bump + re-fetch), multi-tab (a future
ADR if tabs ever share writes).

## ADR-10: Escape hatch — Durable Objects hub at the connection ceiling

**Context.** Supabase free = 200 concurrent Realtime connections; each
`live()` producer holds its own server-side socket (~7 per viewer) ⇒ a
~25–30 concurrent-viewer ceiling today. Phase 4 (consolidation) lifts this
to ~100+.

**Decision.** When quotas bite: a Durable Object per workspace becomes the
fan-out hub (DOs with SQLite backends run on the free plan: 100K req/day,
13K GB-s/day). The DO subscribes to Postgres once and fans typed events to
connected browsers. This is an **L1-only swap** — the layering exists so
this is possible.

**Consequences.** Do not build it now. Build it when the preview
environment's connection counters say so.

## ADR-11: Branch model — `main` = prod, `preview` = integration

**Decision.** `main` deploys production (protected, PR-only, `production`
environment approval). `preview` is the integration branch (protected,
PR-only) that feature branches cut from. Merging to `preview` deploys the
preview environment; `preview` → `main` (a PR) is the release.

**Consequences.** Every change is seen on preview before prod. Prod
releases are batched, reviewed clicks. Rollback = revert the merge commit.

## ADR-12: Two Supabase projects; migrations are the only schema path

**Context.** Supabase free has no branching; free tier allows two active
projects.

**Decision.** Project 1 = prod, project 2 = preview. Local dev uses the
CLI stack (`supabase start`, `db reset`). Schema changes happen **only**
through migration files, applied by CI in order (preview on merge, prod on
release). No dashboard edits, no ad-hoc SQL on either project, ever.

**Consequences.** "Branching" is migration discipline, not infrastructure.
A weekly cron pings the preview project so free-tier pausing never bites.
The two-project limit is the free-tier ceiling — a third environment would
need a paid plan or the local stack.

## ADR-13: Preview is private — Cloudflare Access

**Decision.** The preview worker gets a custom domain on the Orbit
zone; Cloudflare Access (free ≤50 users) gates it with an email allowlist.
Preview Supabase: invite-only signups, redirect URLs pinned to the preview
domain. Preview MCP tokens live in the preview DB only.

**Consequences.** No auth code ships for preview gating (the middleware
stays clean). Prod keys never appear in preview env. The repo going
public leaks nothing — anon keys are public by design; RLS is the gate.

## ADR-14: Path-based deploys, ordered

**Decision.** CI inspects changed paths and deploys in order:
migrations → edge functions → worker. Schema lands before code; the app is
already deploy-order-tolerant (see the 0032 fallback in `snapshot()`).
The changed-paths window is "since the last successful deploy of the
environment" — a failed deploy self-heals on the next merge
(ci-cd.md W2/W3).

**Consequences.** Docs-only PRs deploy nothing. A migration-only PR doesn't
rebuild the worker. The order is a rule — code that requires a migration
ships in the same merge, never before it.

## ADR-15: CI credentials policy

**Context.** The threat: CI runs are a popular exfiltration target
(malicious PRs, compromised third-party actions, leaked logs). The ideal —
per-run, short-lived minted credentials via GitHub's OIDC federation —
exists for AWS/GCP/Azure/Vault. Neither Cloudflare nor Supabase supports
OIDC federation for their API tokens (verified against current docs:
wrangler in CI takes a static API token; Supabase CLI takes a static
access token). Minting per-run tokens via each provider's API would
require storing a _token-minting_ token (Cloudflare "API Tokens: Edit",
Supabase account-wide) — strictly more dangerous than the tokens being
minted. Rejected.

**Decision.** Layered mitigation instead:

1. **PR runs touch zero provider credentials.** The quality workflow runs
   against the local Supabase stack only — no `SUPABASE_ACCESS_TOKEN`, no
   Cloudflare token, no DB passwords reach pull_request workflows at all.
   Deploy credentials exist only in the `preview` and `production`
   environments, which only protected-branch merges can enter.
2. **Minimum scope.** Cloudflare token: "Edit Cloudflare Workers" on this
   account + zone only. Supabase: `db push` uses the per-project DB
   password (`--remote=<db url>`, CLI 3.x's replacement for the
   deprecated `--db-url` — same URL, same credential), not the
   account-wide access token; the access token is used only for
   `functions deploy`.
3. **TTL + rotation.** Cloudflare tokens get a TTL (90 days) — expiry
   forces rotation; the calendar reminder is the rotation runbook.
   Supabase access token rotated quarterly.
4. **IP restriction: evaluated, dropped.** GitHub-hosted runner ranges
   are huge, rotate weekly, and maintaining the allowlist is a chore
   with modest security return. TTL + scope + env-gating carry the
   policy. Cloudflare tokens get a TTL (90 days) — expiry forces
   rotation; the calendar reminder is the rotation runbook. Supabase
   access token rotated quarterly.
5. **GitHub hardening.** Default `GITHUB_TOKEN` read-only (set); fork PRs
   get no workflows (set); every workflow pins actions to full commit
   SHAs; per-workflow `permissions:` blocks; `persist-credentials:
false` on checkout; no `pull_request_target` + PR-head checkout
   patterns, ever.
6. **Environments as the gate.** `production` requires a reviewer;
   `preview` is merge-gated. Credentials live in environments, not
   repo-level, wherever possible.

**Consequences.** A compromised PR cannot reach any provider credential.
A leaked deploy token is IP-bound, time-bound, minimally scoped, and
rotates. The residual risk — a compromised runner during a deploy run —
is bounded by TTL + scope + rotation. When (if) Cloudflare or Supabase
ship OIDC federation, this ADR is superseded by a new one.

## ADR-16: Frozen design token layer

**Context.** The UI redesign (phase 6) needs its visual decisions made
_before_ component code moves, or every contributor re-derives taste per
PR. Two sourced research reports (`docs/research/`) were filtered into
adopt/adapt/skip findings (`docs/design-findings.md`), and the adopted
numbers were frozen as tokens (`docs/design-system.md`).

**Decision.** `docs/design-system.md` is the single source of truth for
visual values: color (OKLCH; warm/cool gray and indigo/violet accent as
named experiment axes until the playground picks), typography (Inter,
1.5 line-height, 708px measure, no 700 weight), spacing (8px grid),
radius (semantic aliases), motion (the 100/200/300ms budget; rbd +
Notion + Linear curves; spring easing reserved for completion moments;
`prefers-reduced-motion` globally), and elevation (two levels).
Components read tokens; they never hardcode. A value that doesn't exist
gets added to the token file first.

**Consequences.** Token changes reopen this decision and require a new
ADR (or an explicit amendment line here) in the same PR. The experiment
axes (gray, accent) resolve by feel in the playground, and their
resolution is recorded as an amendment to this ADR — not a silent edit.
The token layer is CSS-first (custom properties); Tailwind 4 reads the
same values via `@theme`, so there is exactly one place a color lives.

## ADR-17: Typed flag boundary and server-gated developer playground

**Context.** ADR-8 selected PostHog for flags, and the redesign docs require
flagged surfaces, but did not define flag ownership, defaults, SSR behavior,
or how developers compare variants. A client-only check can flash a surface
before hydration and cannot protect a route. PostHog's edge guidance also
means a process-local SDK cache cannot be assumed on Cloudflare Workers.

**Decision.** Define and consume flags through a Orbit-owned typed
registry and provider boundary. Every flag declares its purpose, finite
value set, safe fallback, evaluation scope, owner, expiry/review date, and
rollback behavior. Release flags fall back to the existing UI; playground
access falls back to deny; operational flags declare their safe/degraded
behavior individually. Evaluate the values needed for a request before SSR,
keep them request-scoped, and bootstrap only the matching client values with
the same distinct ID. Validate the PostHog evaluation and billing strategy
on the actual Worker before choosing remote evaluation or shared caching.
Never use a browser flag as authorization or as a replacement for RLS.
Keep PostHog on its no-card Free tier: usage stops at free limits. Measure
flag request volume and preserve safe fallbacks for quota exhaustion.
Person targeting is the default for developer access and personal UI. For
workspace-specific UI, evaluate as the authenticated person while passing
the verified active workspace UUID as a transient person-property override.
Exact workspace conditions use 100% rollout; PostHog percentage rollouts
remain person-bucketed and cannot ensure one variant per workspace. PostHog
Group Analytics is paid and excluded by ADR-8's strict $0 rule. If
workspace-randomized experiments become necessary, assignment and analysis
must use a separately designed Orbit-owned mechanism rather than a
PostHog group experiment.

The developer playground is a server-gated `/playground/*` route family.
It returns the normal 404 before rendering or loading data for unauthorized
accounts. Access comes from a server-verifiable developer permission;
an authenticated account's server-evaluated PostHog permission flag may
manage the preview cohort, but client-side flags are never trusted and flags
do not protect confidential data or bundled code. The gallery compares
production components and variants using synthetic fixtures. Gallery
selection is separate from production rollout and experiment assignment.

**Consequences.** SSR and browser render the same decision without a
variant flash. Flag evaluation failures remain on each flag's declared safe
path. Server functions and database policies continue enforcing access
independently. The component gallery can grow by component/surface page
without a parallel implementation or additional hosting product. Temporary
flags carry cleanup work; experiments remain off until separately justified
by the data-playbook criteria.

**Amendment (2026-11-27).** The playground's access mechanism changed:
instead of a server-evaluated PostHog permission flag, access is
**environment-gated** — the preview deployment is already Cloudflare
Access-gated to the maintainer, so it IS the developer cohort, and
production always returns the normal 404 (`VITE_APP_ENV` is baked at
build time; a runtime failure cannot open the gate). The check stays
server-side in every route's preload and fails closed. The typed flag
boundary itself is unchanged — permission flags remain a supported kind
for future per-account cohorts; the registry simply holds no flags until
the first redesign release flag registers with the PR that consumes it.
Net effect: one less PostHog dependency and no flag-metadata setup for a
one-person cohort, at zero security cost (the flag was never the security
boundary; Cloudflare Access and RLS are).

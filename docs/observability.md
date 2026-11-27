# Observability

What we measure, where it goes, and what it costs: **$0**. The stack is
locked in [ADR-8](./adr.md); this is the operating manual — the event
taxonomy, the instrumentation rules, and the dashboards that read them.
Companion: [`performance-rules.md`](./performance-rules.md) (the perf marks
feed the sink described here).

**This doc is the system-telemetry layer** — is the machine healthy. The
behavioral layer (what humans do, how it becomes a decision) lives in
[`data-playbook.md`](./data-playbook.md): the behavior event taxonomy,
journeys, feedback, experiments at our scale, and the weekly/monthly/
quarterly decision cadence. Read both before adding any event.

## The stack

| Tool            | What it gives us                                                                         | Free tier                                                                                                        | Cost control                                                            |
| --------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| PostHog Cloud   | product analytics, feature flags, experiments, session replay, exceptions                | Free monthly allowances; feature flags include 1M requests. Group Analytics is paid and excluded by the $0 rule. | Stay within free limits; lean taxonomy, sampled replays                 |
| Workers Logs    | server-side logs: `[perf]` slow reads, `[boardStream]` fold/resync lines, channel errors | 3-day retention                                                                                                  | the escape hatch is Axiom Personal (500GB/mo) if retention ever matters |
| `perf.ts` marks | client-side p50/p95 per open path (the `?perf=1` panel)                                  | free (ours)                                                                                                      | a batched sink → PostHog counters, not one event per mark               |

Local dev sends nothing (`import.meta.env.DEV` guard on the sink); the
PostHog key is `VITE_`-prefixed — public by design. The project's
configuration record — free-tier allowances, the one-project/one-property
environment split, and flag governance — is [`posthog.md`](./posthog.md).

## The event taxonomy

One rule first: **an event that answers no question is deleted.** Every
event below answers a question we have already needed to answer by reading
code. Names are `snake_case`, no PII — user/workspace identities are the
existing UUIDs, never emails or display names.

| Event                      | Properties                                                                                             | Answers                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `page_open`                | `route`, `authed`, `p50_ms`, `p95_ms`, `count` — one event per (open-mark label, minute bucket)        | is the redesign faster; where do users go                                                                                                                                                                    |
| `panel_open`               | `panel`, `authed`, `p50_ms`, `p95_ms`, `count` — same bucketing                                        | the budgets table's reality check (warm/cold reads from the cache counters, by entity type)                                                                                                                  |
| `mutation_echo`            | `op_kind`, `ms`, `ok`, `remote` (author's own op vs a received provisional)                            | is the outbox meeting its budgets — the author's echo retirement, and (with `remote: true`) the receiver's provisional→echo, which is the ≤500ms cross-viewer budget in [`performance.md`](./performance.md) |
| `sync_resync`              | `trigger` (`access` \| `board-delete` \| `vocabulary` \| `periodic`), `ms`                             | resyncs should be rare — a spike means a one-row change is falling off the fold (the canonical test, caught in prod)                                                                                         |
| `cache_hit` / `cache_miss` | `entity_type`, `count` — **aggregated**: one counter per (type, hit/miss, minute), never per read      | did the cache layer earn its complexity                                                                                                                                                                      |
| `mcp_tool_call`            | `tool`, `op`, `workspace_id`, `ms`, `ok`, `rows` — captured in the MCP edge function                   | what agents actually do; which ops earn their surface                                                                                                                                                        |
| `exception`                | PostHog exceptions (SDK autocapture)                                                                   | client errors the replays explain                                                                                                                                                                            |
| `fold_applied`             | batch size, card fetches, duration — _not yet instrumented; lands with the sync-health dashboard work_ | the fold's health as it grows event kinds                                                                                                                                                                    |

Every event also carries the `app_environment` super property
(`preview` \| `production` — the one-project split,
[`posthog.md`](./posthog.md)) and the SDK's automatic properties
(`$current_url`, `$device_id`, …). The behavior layer's stable core
(`card_created`, `card_completed`, `chat_message_sent`,
`teammate_invited`) landed with the sink; the rest of its taxonomy
follows the redesigned surfaces, one PR behind them.

The sink is `src/lib/telemetry.ts`: local dev sends nothing
(`import.meta.env.DEV`), high-frequency paths (marks, cache reads)
aggregate minute buckets, and behavior events fire at echo retirement —
a failed or provisional action never happened. Property schemas live in
the capture functions; a new property needs a line in this table (or the
behavior table in [`data-playbook.md`](./data-playbook.md)).

Per-phase additions land with the phase (the same PR that adds the path
adds its event — the observability mirror of performance-rules 12).

## Feature flags and experiments

- **Flags gate redesign surfaces** (L5 rule 5): new UI ships dark behind a
  typed Flowdeck flag; the existing surface is its release fallback. The
  runtime, SSR, kill-switch, and internal-playground contract is in
  [`feature-flags-and-ui-playground.md`](./feature-flags-and-ui-playground.md).
- **Experiments need one primary metric, declared up front** — a
  `panel_open` p95, a `mutation_echo` p95, or a `page_open` retention
  shape. An experiment with no metric is a flag, not an experiment.
- **At our traffic, ship-and-observe beats A/B** — the sample-size math
  makes a true test take years, and underpowered tests manufacture fake
  winners. The holdout pattern (5–10% kept on the old surface) is the
  only causal comparison we can afford. Full reasoning and the flag
  lifecycle rules: [`data-playbook.md`](./data-playbook.md).
- Experiments run on preview before prod (the same review the code gets).
- Flag requests are metered: client SDK reads are cached, but initialization,
  identity/property changes, explicit reloads, and server-side remote
  evaluations can call `/flags`. Do not poll in a loop or fork flags per
  entity. Keep the project on its no-card Free tier, measure request volume,
  and ensure quota exhaustion follows safe fallbacks; see
  [`feature-flags-and-ui-playground.md`](./feature-flags-and-ui-playground.md).

## Dashboards

Built in the PostHog project with the sink's events (tiles populate as
data flows; preview vs prod reads the `app_environment` filter):

1. **Pre-redesign baseline** — `page_open`/`panel_open` p50/p95 by route
   and panel vs. the budgets table in [`performance.md`](./performance.md):
   the frozen "before" every redesign result compares against.
2. **Sync health**: `mutation_echo` p95, `sync_resync` count by trigger —
   this is the "is the architecture holding" dashboard (fold stats join
   when `fold_applied` lands).
3. **Adoption**: the North Star inputs — `card_created`,
   `card_completed`, `chat_message_sent`, `teammate_invited`, plus
   `mcp_tool_call` by tool (what to build next).
4. **Errors**: `exception` trend, with the exception-triggered replays
   as the "why" layer.
5. **Cost**: flag-evaluation requests against the 1M allowance
   (PostHog's flag usage view), events/mo against the cap, replays
   against 5K.

The weekly decision ritual reads one dashboard (the adoption one) plus
sync health — the cadence and the questions each tile answers are in
[`data-playbook.md`](./data-playbook.md).

## Rules

1. **The 1M budget is a design constraint.** No high-frequency events: no
   per-row, per-keystroke, per-heartbeat telemetry. Batch, sample, or
   aggregate first; the sink emits at most one event per (path, minute)
   bucket for marks.
2. **Replays are 10% sampled** (project config: 10% baseline, 100% on
   signup/onboarding/invite URLs, 100% of exception sessions).
   Replay captures the DOM — board names, chat bodies, card text are
   content, not telemetry, and content appears on too many surfaces to
   sweep per-component. The sink's config is therefore stricter than a
   per-surface blocklist: **every** text node is masked
   (`maskTextSelector: '*'`), **every** element attribute is masked, and
   **every** input value is masked — a recording shows layout and
   interaction, never content. A surface that leaks content in a
   recording is a PII incident, not a bug.
3. **No PII ever** — emails, tokens, message bodies, board names. The
   event property allowlist is the taxonomy above; a new property needs a
   line in this table.
4. **Instrument in the same PR** as the feature (the phase walkthrough
   step 7). An unmeasured path is a bug the next phase can't see.
5. **Workers logs are the server mirror**: `[perf]` slow-read warnings and
   stream/fold lines already exist — keep them (L4 rule 6) and read them
   weekly; they are the first place a `sync_resync` spike gets explained.

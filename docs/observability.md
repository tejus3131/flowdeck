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

| Event                      | Properties                                                                                                  | Answers                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `page_open`                | route, auth state, p50/p95 of the route's open mark                                                         | is the redesign faster; where do users go                                                                                                                                                                    |
| `panel_open`               | panel (`card-drawer`, `board-chat`, `settings`), warm/cold, open mark                                       | the budgets table's reality check                                                                                                                                                                            |
| `mutation_echo`            | op kind, apply→echo ms, ok/fail, `remote` (author's own op vs a received provisional)                       | is the outbox meeting its budgets — the author's echo retirement, and (with `remote: true`) the receiver's provisional→echo, which is the ≤500ms cross-viewer budget in [`performance.md`](./performance.md) |
| `sync_resync`              | trigger (`visibility`, `periodic`, `board-delete`), snapshot ms                                             | resyncs should be rare — a spike means a one-row change is falling off the fold (the canonical test, caught in prod)                                                                                         |
| `cache_hit` / `cache_miss` | entity type, key kind — **aggregated**: the sink emits one counter per (type, kind, minute), never per read | did the cache layer earn its complexity                                                                                                                                                                      |
| `fold_applied`             | batch size, card fetches, duration                                                                          | the fold's health as it grows event kinds                                                                                                                                                                    |
| `mcp_tool_call`            | tool, op, workspace id, latency ms, ok, rows                                                                | what agents actually do; which ops earn their surface                                                                                                                                                        |
| `exception`                | PostHog exceptions (auto)                                                                                   | client errors the replays explain                                                                                                                                                                            |

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

## Dashboards (build these when the sink lands)

1. **Latency**: p50/p95 per open-path mark vs. the budgets table in
   [`performance.md`](./performance.md) — one tile per budget row.
2. **Sync health**: `mutation_echo` p95, `sync_resync` count by trigger,
   fold stats — this is the "is the architecture holding" dashboard.
3. **Adoption**: `page_open`/`panel_open` by route — what to build next.
4. **MCP**: `mcp_tool_call` by tool and op — which agent surfaces are used,
   and what they cost (row counts, latency).
5. **Cost**: PostHog events/mo against the 1M cap, replays against 5K.

The weekly decision ritual reads one dashboard (the adoption one) plus
sync health — the cadence and the questions each tile answers are in
[`data-playbook.md`](./data-playbook.md).

## Rules

1. **The 1M budget is a design constraint.** No high-frequency events: no
   per-row, per-keystroke, per-heartbeat telemetry. Batch, sample, or
   aggregate first; the sink emits at most one event per (path, minute)
   bucket for marks.
2. **Replays are 10% sampled** and excluded from signed-out visitors.
   Replay captures the DOM — board names, chat bodies, card text are
   content, not telemetry. Masking is the rule: the sink config sets
   `mask_all_text` on message/comment/description surfaces (composer
   bodies, rendered markdown, card titles) and `mask_all_inputs` on every
   form. If a surface can't be masked, it is excluded from replay capture
   via the sink's blocklist — a surface that leaks content in a recording
   is a PII incident, not a bug.
3. **No PII ever** — emails, tokens, message bodies, board names. The
   event property allowlist is the taxonomy above; a new property needs a
   line in this table.
4. **Instrument in the same PR** as the feature (the phase walkthrough
   step 7). An unmeasured path is a bug the next phase can't see.
5. **Workers logs are the server mirror**: `[perf]` slow-read warnings and
   stream/fold lines already exist — keep them (L4 rule 6) and read them
   weekly; they are the first place a `sync_resync` spike gets explained.

# Observability

What we measure, where it goes, and what it costs: **$0**. The stack is
locked in [ADR-8](./adr.md); this is the operating manual — the event
taxonomy, the instrumentation rules, and the dashboards that read them.
Companion: [`performance-rules.md`](./performance-rules.md) (the perf marks
feed the sink described here).

## The stack

| Tool | What it gives us | Free tier | Cost control |
| --- | --- | --- | --- |
| PostHog Cloud | product analytics, feature flags, experiments, session replay, exceptions | 1M events/mo, 1M flag requests/mo, 5K replays/mo, 100K exceptions/mo — **hard-capped, no surprise bills** | lean taxonomy (below), replays sampled 10% |
| Workers Logs | server-side logs: `[perf]` slow reads, `[boardStream]` fold/resync lines, channel errors | 3-day retention | the escape hatch is Axiom Personal (500GB/mo) if retention ever matters |
| `perf.ts` marks | client-side p50/p95 per open path (the `?perf=1` panel) | free (ours) | a batched sink → PostHog counters, not one event per mark |

Local dev sends nothing (`import.meta.env.DEV` guard on the sink); the
PostHog key is `VITE_`-prefixed — public by design.

## The event taxonomy

One rule first: **an event that answers no question is deleted.** Every
event below answers a question we have already needed to answer by reading
code. Names are `snake_case`, no PII — user/workspace identities are the
existing UUIDs, never emails or display names.

| Event | Properties | Answers |
| --- | --- | --- |
| `page_open` | route, auth state, p50/p95 of the route's open mark | is the redesign faster; where do users go |
| `panel_open` | panel (`card-drawer`, `board-chat`, `settings`), warm/cold, open mark | the budgets table's reality check |
| `mutation_echo` | op kind, apply→echo ms, ok/fail, `remote` (author's own op vs a received provisional) | is the outbox meeting its budgets — the author's echo retirement, and (with `remote: true`) the receiver's provisional→echo, which is the ≤500ms cross-viewer budget in [`performance.md`](./performance.md) |
| `sync_resync` | trigger (`visibility`, `periodic`, `board-delete`), snapshot ms | resyncs should be rare — a spike means a one-row change is falling off the fold (the canonical test, caught in prod) |
| `cache_hit` / `cache_miss` | entity type, key kind — **aggregated**: the sink emits one counter per (type, kind, minute), never per read | did the cache layer earn its complexity |
| `fold_applied` | batch size, card fetches, duration | the fold's health as it grows event kinds |
| `mcp_tool_call` | tool, op, workspace id, latency ms, ok, rows | what agents actually do; which ops earn their surface |
| `exception` | PostHog exceptions (auto) | client errors the replays explain |

Per-phase additions land with the phase (the same PR that adds the path
adds its event — the observability mirror of performance-rules 12).

## Feature flags and experiments

- **Flags gate redesign surfaces** (L5 rule 5): new UI ships dark behind a
  PostHog flag, flips per-user first (the maintainers), then per-percent.
  The old surface stays until the flag reads 100% — the old code is
  deleted one release after that.
- **Experiments need one primary metric, declared up front** — a
  `panel_open` p95, a `mutation_echo` p95, or a `page_open` retention
  shape. An experiment with no metric is a flag, not an experiment.
- Experiments run on preview before prod (the same review the code gets).
- Flag requests are metered (1M/mo) but cheap; do **not** poll flags in a
  loop or fork them per entity.

## Dashboards (build these when the sink lands)

1. **Latency**: p50/p95 per open-path mark vs. the budgets table in
   [`performance.md`](./performance.md) — one tile per budget row.
2. **Sync health**: `mutation_echo` p95, `sync_resync` count by trigger,
   fold stats — this is the "is the architecture holding" dashboard.
3. **Adoption**: `page_open`/`panel_open` by route — what to build next.
4. **MCP**: `mcp_tool_call` by tool and op — which agent surfaces are used,
   and what they cost (row counts, latency).
5. **Cost**: PostHog events/mo against the 1M cap, replays against 5K.

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

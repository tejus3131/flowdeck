# L4 — Domain

Server functions: the app's API surface. Thin, domain-split, calling L0's
domain functions.

## Owns

- Server functions (`'use server'`): reads through `query()`, live
  producers through `live()`
- Validation of caller input (ids, text bounds) before calling L0
- Friendly errors (`friendlyError`) — the user-facing message contract
- Notification fan-out orchestration (mentions parsing, access checks)
- Perf marks on read paths (`SLOW_READ_MS` server warnings)

## May not

- Know views: no assembling page-shaped payloads, no embedding display
  names where an id + store lookup suffices (the `CardView.tags`
  denormalization is the anti-example being retired).
- Contain mutation logic: validation + orchestration only; the write and
  its event logging live in L0's per-op functions (ADR-5).
- Grow unbounded files: `boards.ts` splits by domain (board-reads,
  board-stream, board-chat, card-comments, mutations). A 2,000-line module
  is a review blocker.

## Rules

1. **Reads run under the caller's JWT** — `createSupabaseRequestClient()`
   always; the service client is administrative-only (signed URLs), never
   for anything user-shaped (the existing rule, kept).
2. **One write path**: a mutation server fn calls the same per-op DB
   function the MCP op calls. Duplication between web and MCP is a bug.
3. **Producers are scoped and few** (L1's contract): a new `live()`
   producer needs an ADR. The target shape is one board + one workspace
   producer per viewer.
4. **Session before subscribe** in every producer (the boardStream
   lesson).
5. **Failures never break the write that caused them** (notify's rule) —
   but they log loudly.
6. **Every read path carries a perf mark** with a budget line
   (performance-rules 5).

## Worked example — `updateTag`, after

The server fn validates the id and text bounds, calls
`update_tag(...)` (L0), returns `{name, description}`. The L0 function
wrote the row, logged the event, bumped the revision. The realtime event
carries the change to every viewer. The server fn is ~15 lines.

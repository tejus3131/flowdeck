---
name: onboarding
description: Ground a fresh agent session in Flowdeck — what this repo is, the docs to read in order, the environment to verify, and the workflow rules that keep changes safe. Run it at the start of any new session on this repo.
---

# Flowdeck onboarding — grounding a new session

Run this when starting work on the repo (fresh session, new machine, or
after a long gap). The root `AGENTS.md` is the always-loaded summary; this
skill is the guided tour that gets you to "I know where everything lives
and why it is the way it is" in one pass.

## 1. What this project is

Flowdeck is a team workspace — boards, cards, chats, and an MCP server for
AI agents. Solo-maintained, free-tier resources, deliberate over clever.
The architecture doc's five principles and the canonical test are the
constitution; most review feedback traces back to them.

## 1b. The one bug class to internalize before UI work

**Symptom:** a change to one entity (a rename, a role change) shows up
instantly on some surfaces and seconds later — or only after a reload — on
others.

**Cause:** two surfaces hold two copies of the same entity. The instant one
reads the store; the slow one reads a snapshot slice (a detail payload
threaded as a prop, a list captured in a signal). Only the store copy got
the update.

**Why it's a layering violation, not a UI bug:** the architecture's
canonical test is "a one-row change updates every surface in one frame,
with zero refetches". A surface that updates late or never fails it by
definition — the fix is never a timer, a poll, or a rebuild hack; it is
rewiring the surface to read the store by id.

**The rule and the fix live in `docs/ui-data.md`.** If you see the symptom
in review or in the app, that doc is the checklist. This failure class is
the most common way new UI goes wrong in this repo, and the reason the
read-order below puts `ui-data.md` before any view work.

## 2. Read, in this order (don't skip ahead)

1. `AGENTS.md` (root) — stack, commands, hard rules, gotchas, and the
   Solid 2.0 primer at the bottom.
2. `docs/architecture.md` — the locked architecture: five principles, the
   layer model, the canonical test, the phase plan.
3. `docs/layers/l0-database.md` … `l5-views.md` — skim each layer's
   Owns / May-not / Rules. You don't need to memorize; you need to know
   they exist and where to look when a change crosses a boundary.
4. `docs/ui-data.md` — the UI data-wiring how-to (store selectors, not
   snapshot slices). Required before any view work — see "The one bug
   class to internalize" below.
5. `docs/design-system.md` — the frozen visual layer (ADR-16): UI changes
   read `--fd-*` tokens, never hardcode values. The filtering behind it
   (`docs/design-findings.md`) and the still-open axes
   (`docs/design-playground.md`) are one link away.
6. `docs/adr.md` — the decision records. Scan the numbers and titles;
   read fully any that touch your upcoming work. **Never re-propose
   something an ADR already decided against.**
7. `docs/ci-cd.md` — branch model (`feat/*` → PR → `preview` → release PR
   → `main`), the deploy legs, the release records, the secrets/vars split.
8. `docs/performance-rules.md` and `docs/observability.md` — the budgets
   and the event taxonomy.

## 3. Verify the environment actually works

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm lint
```

If this is a server-side session: `supabase start && supabase db reset`
(local Docker stack) — needs Docker running. The MCP edge function type
checks with Deno: `deno check supabase/functions/mcp/index.ts`.

Do not start a change until these pass; a broken baseline makes every
failure ambiguous.

## 4. How work flows

- Branches: `feat/*` or `fix/*` off `preview`, PR into `preview`.
  `preview` deploys automatically on merge (path-gated legs). Releases to
  `main` are PRs; every deploy gets a tagged Release record.
- Before any PR: run the `pr-prep` skill.
- Ruleset reality: `preview` and `main` are protected — everything goes
  through PRs; history-absorption merges must use "Create a merge commit".

## 5. Where things live

- `src/lib/sync.ts` — the outbox sync engine (read before touching any
  realtime/mutation code)
- `src/lib/entity-store.ts` — the L2 entity store: one reference per
  entity, selectors are the only way views see data (read before adding
  any surface that shows entities)
- `src/lib/board-fold.ts` — event-batch planning/folding
- `src/lib/boards.ts` — the board data layer
- `src/routes/` — file-system routed pages
- `src/server/mcp-proxy.ts` + `supabase/functions/mcp/` — the MCP server
  (Deno; proxy forwards to the edge function)
- `env.ts` — every environment variable, declared and validated here
- `docs/` — the constitution; `AGENTS.md` — the map to it

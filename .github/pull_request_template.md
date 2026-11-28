<!-- The structure every Orbit PR follows. The `pr-prep` skill
     (.agents/skills/pr-prep/SKILL.md) is the routine that fills this in. -->

## What & why

<!-- One paragraph: what changed, and the user-visible or system-visible
     reason. If this closes an issue, link it. If it follows a discussion
     or decision, link the ADR / issue / comment. -->

## Area(s) touched

<!-- Check what applies; delete what doesn't. Evidence is REQUIRED per
     area — an unchecked area means the reviewer has to ask for it. -->

- [ ] **UI** — screen recording or screenshots attached (before → after),
      light + dark mode both shown
- [ ] **Server / data** — explanation of the data path + tests added or
      updated; `supabase db reset` passes locally
- [ ] **MCP** — tools tested against the local stack; tool docs
      (`src/routes/docs/mcp.tsx`) updated for any schema/behavior change
- [ ] **Migrations** — guard note written (why the migration is safe,
      what it does to existing rows); `supabase/migrations/**` diff explained
- [ ] **Docs** — `docs/**` updated in the same PR if this change makes any
      doc untrue (`ci-cd.md` for workflow changes, ADR for new decisions)

## Self-review checklist

<!-- Run the pr-prep skill for the full routine; this is the summary. -->

- [ ] `pnpm typecheck && pnpm test && pnpm lint` green before committing
- [ ] Each commit is self-sufficient and does ONE thing
- [ ] No layer contract violated (`docs/layers/`) — if it touches a
      boundary, the contract doc is cited above
- [ ] The canonical test still holds (a one-row change updates every
      surface in one frame, zero resyncs)
- [ ] No secrets, no new provider credentials in PR-triggered CI (ADR-15)
- [ ] PR is reviewable in one sitting (< ~400 changed lines); if not,
      split it

## Risks & rollout

<!-- What could this break? How would we notice? Feature flag? Migration
     ordering? Deploys to preview first (automatic), so mention what to
     check on preview before this reaches main. -->

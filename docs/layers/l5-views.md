# L5 — Views

Components, panels, routes, design tokens. The layer the UI redesign
lives in — this contract is what makes the redesign safe.

## Owns

- Components and panels (each its own module; heavy ones lazy chunks)
- Routes as composition: a route wires panels together, nothing more
- Design tokens (`tokens.ts`, `theme.ts`) and Tailwind classes
- Local UI state only: which tab is open, panel width, hover, composer
  drafts
- Perf marks on open paths (`perfStart`/`perfEnd` with budgets)

## May not

- Fetch. A component that calls a server function for data is a bug —
  it reads selectors (L2). The only permitted direct calls are
  user-triggered mutations through the sync engine (L3).
- Hold server state. Duplicated entity copies in component signals are
  the bug class this layer exists to end.
- Append to routes. New UI becomes its own module (performance-rules 9).
  The 6,495-line board route is the debt Phase 6 pays down; nothing
  adds to it.
- Show a spinner on a warm open (performance-rules 6). Skeletons only on
  the genuine cold path.

## Rules

1. **Selectors in, events out.** A component reads the store through
   selectors and emits intents (ops); it never touches transport or
   domain layers directly.
2. **Markdown chips resolve names from the store** — `renderMarkdown`
   context comes from selectors, so a rename re-renders every chip with
   zero refetch. No memo hacks to force rebuilds.
3. **Unbounded lists virtualize** (performance-rules 10).
4. **Every panel gets a perf mark and a budget**; PRs that touch a view's
   loading include before/after numbers (performance-rules 7).
5. **Feature flags gate redesign surfaces** (ADR-8): new UI ships dark
   behind a PostHog flag, flips per-user or per-percent, and the old
   surface stays until the flag reaches 100%.
6. **A route is a wiring file.** If a route grows a component, the
   component moves out. Target: no route file over ~300 lines.

## Worked example — the tag chip, after

`TagChip(props)` reads `tagById(props.tagId)` — one line. The rename
lands in the store; the chip re-renders because its selector changed.
The chip has no idea how the name arrived. That is the whole point.

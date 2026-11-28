# Orbit

Orbit is a team workspace: kanban boards, cards, realtime chat, and an
MCP server that lets AI agents work _as team members_ — every agent action
runs under the acting user's permissions and lands in the same timelines
and notifications a human's would.

Built on **SolidStart 2 + Supabase** (Postgres, RLS, Realtime), deployed
to **Cloudflare Workers**.

## What's in the box

- **Boards → lists → cards** with drag-and-drop, tags, assignees,
  priorities, and per-card timelines
- **Realtime everything** — an outbox sync engine applies your edits
  instantly, relays them to peers as provisional predictions, and
  reconciles against the database echo. No spinners on mutations.
- **Board chat + card comments** with markdown, @mentions (people, teams,
  cards, boards, tags), and edit/delete with tombstones
- **The MCP server** — connect Claude, Cursor, or any MCP client with a
  personal access token; agents get a permission-scoped subset of the
  same operations the web app has
- **Offline-friendly reads** — an IndexedDB cache paints every surface
  instantly on re-open; the network only revalidates

## Project docs

- [`docs/architecture.md`](docs/architecture.md) — **the locked
  architecture**: layers, decisions, the canonical test, and the phases.
  Read this before contributing anything structural.
- [`docs/adr.md`](docs/adr.md) — the decision records (why each choice,
  what it costs, what it rules out).
- [`docs/layers/`](docs/layers/) — the per-layer contracts (L0 database →
  L5 views): what each layer owns and may not do.
- [`docs/design-system.md`](docs/design-system.md) — the frozen design
  tokens (ADR-16): color, type, spacing, motion. UI changes read these
  values, never hardcode them; the sourced research
  ([`docs/research/`](docs/research/)) and the adopt/adapt/skip filter
  ([`docs/design-findings.md`](docs/design-findings.md)) trace every
  number, and [`docs/design-playground.md`](docs/design-playground.md)
  defines how the still-open axes resolve.
- [`docs/ci-cd.md`](docs/ci-cd.md) — the branch model, environments,
  workflows, and deploy matrix.
- [`docs/observability.md`](docs/observability.md) — the event taxonomy,
  dashboards, and the free-tier budget for analytics, flags, and MCP
  profiling. The behavioral layer — what humans do with the product, and
  how a number becomes a decision — lives in
  [`docs/data-playbook.md`](docs/data-playbook.md).
- [`docs/dev-setup.md`](docs/dev-setup.md) — local development: the
  Supabase stack, preview MCP via environment-variable headers, local
  MCP serving.
- [`docs/performance.md`](docs/performance.md) — why the app was slow,
  the architecture that fixes it (client cache → delta sync → prefetch),
  and the phase roadmap with budgets.
- [`docs/performance-rules.md`](docs/performance-rules.md) — **read
  before adding any new data stream or touching UI**: the checklist that
  keeps the app fast.

## Developing

```bash
pnpm install
supabase start     # local Postgres + auth + realtime
pnpm dev:node      # the app on :3000 (Node SSR — see docs/dev-setup.md)
```

`pnpm preflight` runs what CI runs: lint, typecheck, tests. Pre-commit
hooks format and lint staged files automatically.

Branches: `main` = production, `preview` = integration. PRs target
`preview`; the release PR `preview` → `main` ships to production.
Pull requests are limited to the maintainer and invited collaborators —
outside contributions go through issues; see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Deployment

`vite build` emits the Cloudflare Worker + static assets; CI deploys on
merge (path-based: migrations → MCP function → worker). See
[`docs/ci-cd.md`](docs/ci-cd.md) for the full pipeline.

# Contributing to Orbit

Thanks for your interest in contributing. Orbit is a solo-maintained
project with a locked architecture — the fastest way to help is to read
the docs below before writing code, so your change fits the system
instead of fighting it.

## How contributing works

**Issues are the contribution path.** The branch ruleset locks `preview`
and `main`, so pull requests are limited to the maintainer and invited
collaborators — outside PRs cannot be merged. Open an issue instead; the
maintainer takes it from there.

Issues are not a formality: a well-researched issue — clear reproduction,
root-cause analysis, a proposed solution that fits the architecture — is
the way in. Someone who consistently shows up in issue discussions with
good analysis can be invited as a collaborator, at which point the PR
workflow below applies to them too.

## Project license

By contributing, you agree your contributions are licensed under the
[PolyForm Noncommercial License 1.0.0](LICENSE) that covers the
project. Note what that means in practice: the code is free for
personal, research, and noncommercial-organization use, but commercial
use requires a separate license from the maintainer.

## Setting up

Local setup lives in [`docs/dev-setup.md`](docs/dev-setup.md): Node 24 +
pnpm, Docker for the Supabase stack, and `supabase db reset` as the only
way local schema changes.

## Read the docs in this order

1. [`docs/architecture.md`](docs/architecture.md) — the locked
   architecture. Structural changes must not contradict it; if a change
   should change the doc, change the doc in the same PR.
2. [`docs/layers/`](docs/layers/) — per-layer contracts (L0 database →
   L5 views). Your change belongs to a layer; obey its contract.
3. [`docs/adr.md`](docs/adr.md) — decision records. Check before
   proposing anything already decided.
4. [`docs/ci-cd.md`](docs/ci-cd.md) — branch model and environments.
5. [`docs/performance-rules.md`](docs/performance-rules.md) — the 13
   rules; check your change against them.
6. [`docs/observability.md`](docs/observability.md) — event taxonomy.

## Branch flow

This section is for the maintainer and invited collaborators — the only
people who can push branches and open mergeable PRs.

- Branches are `feat/*` or `fix/*` → PR → `preview` (CI + preview
  deploy) → release PR `preview` → `main` (production deploy).
- Never push directly to `preview` or `main` — the ruleset blocks it.
- Squash merging is the only allowed merge method.

## What "ready to merge" means

Run the full gate before opening a PR:

```bash
pnpm preflight    # lint + typecheck + tests — the exact gate CI runs
```

Commits are self-sufficient (build, typecheck, and tests pass at that
commit) and do one thing. PRs should be reviewable in one sitting —
under roughly 400 changed lines of real code; split anything bigger.

The PR template (`.github/pull_request_template.md`) asks for evidence
per area touched: screen recordings for UI, tests for server/data, tool
tests plus a docs update for MCP. Fill in the areas that apply; an
unchecked area means the reviewer has to ask for it.

Things that will get a PR sent back:

- A merge commit with conflict markers — verify with
  `git grep -n '^<<<<<<<\|^>>>>>>>' HEAD` before pushing.
- An edited merged migration — never edit one; write a new migration.
- New realtime channels, denormalized copies, or refetch storms — this
  fails the canonical test: _a one-row change updates every surface in
  one frame, with zero refetches or resyncs._

## Reporting problems

- Security issues: follow [`SECURITY.md`](SECURITY.md) — do not open a
  public issue.
- Bugs and feature requests: use the issue templates.
- Usage questions: open a discussion or a question issue.

For everyone outside the collaborator team, this section is the whole
workflow — report through issues and discussions; the maintainer handles
the code change.

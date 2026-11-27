---
name: pr-prep
description: The pre-PR routine for Flowdeck — commit hygiene, self-review against the docs, evidence per area, and the checks that must be green before a PR is opened. Run it before opening or updating any pull request.
---

# PR prep — the routine before every pull request

Run this before opening a PR (and again before requesting re-review after
changes). It is the checklist the maintainer reviews against; a PR that
skips it comes back with questions instead of a merge.

## 1. Commit hygiene

- Each commit is **self-sufficient**: checkouts of every commit build,
  typecheck, and pass tests. `git rebase -i` to split "and also" commits.
- Each commit does **ONE thing**. A refactor and a feature are two commits,
  usually two PRs. Docs that the change makes untrue are updated **in the
  same commit**, not in a follow-up.
- No mixed concerns, no chore+feature bundles, no "minor fixes" smuggled
  into a feature commit.
- Commit messages say _why_, briefly. The diff says what.

## 2. Size

- Target < ~400 changed lines of real code, reviewable in one sitting.
- If it's bigger: split by layer or by concern (e.g. the data layer change
  lands before the UI that uses it). Sequential small PRs beat one big one.

## 3. Checks — all green before committing

```bash
pnpm typecheck && pnpm test && pnpm lint
```

- `lint` must report **0 errors** (warnings are pre-existing; never add one).
- If the change touches `supabase/migrations/**`: run `supabase db reset`
  locally and confirm the full stack comes up. Write the migration guard
  note for the PR (what the migration does to existing rows, why it's safe).
- If the change touches `.github/workflows/**`: `docs/ci-cd.md` is updated
  in the same commit, and every YAML is validated
  (`ruby -ryaml -e 'ARGV.each { |f| YAML.safe_load(File.read(f)) }' ...`).

## 4. Self-review against the docs (the mini review)

Read your own diff as if you were the maintainer, with these open:

- `docs/layers/` — does the change violate any layer's May-nots? Cite the
  contract in the PR if the change touches a boundary.
- `docs/adr.md` — is anything here already decided against (CRDTs, bought
  sync engines, RLS-only, outbox)? If a decision is genuinely changing, a
  new ADR number goes in the same PR.
- `docs/architecture.md` — the canonical test: would a one-row change still
  update every surface in one frame with zero resyncs? New denormalized
  copies, new `resync` triggers, or new realtime channels fail this.
- `docs/performance-rules.md` — budgets, unbounded stores, refetch storms.
- `docs/observability.md` — new events follow the taxonomy and budget.
- `docs/ui-data.md` — any UI change: run the two grep guards (snapshot-copy
  reads of `props.workspaceTags` / `props.members` / `props.teams` /
  `detail().tags…`) and review every hit; the only acceptable ones are
  event handlers and the rule-4 snapshot fallbacks. Then run the canonical
  test by hand: change one row, confirm every surface updates in one frame.

## 5. Evidence per area (goes in the PR description)

| Area           | Required evidence                                                                 |
| -------------- | --------------------------------------------------------------------------------- |
| UI             | Screen recording or before→after screenshots, **light + dark**                    |
| Server / data  | Data-path explanation + tests added/updated; `db reset` passes                    |
| MCP tools      | Tested against local stack; the MCP docs page updated for schema/behavior changes |
| Migrations     | Guard note in the PR                                                              |
| CI / workflows | `docs/ci-cd.md` diff in the same commit + validated YAML                          |
| Docs           | The doc diffs are part of the PR, not a follow-up                                 |

UI recording tip: a phone/screen recording of the two states is fine — it
doesn't need production polish, it needs to show the behavior.

## 6. Open the PR

- Fill `.github/pull_request_template.md` — delete the sections that don't
  apply, never the evidence you owe.
- Base branch is `preview` (never `main`).
- Re-check the diff once more with fresh eyes before pressing "Create".

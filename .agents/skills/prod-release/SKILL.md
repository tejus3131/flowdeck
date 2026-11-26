---
name: prod-release
description: The production release routine for Flowdeck — open the release PR (base main, head preview), enumerate every merged PR and what it ships, verify deploy legs and migrations, watch checks, and complete the production deployment approval. Run it when asked to cut a prod release.
---

# Prod release — the routine

Flowdeck deploys continuously from `preview` (auto) and from `main`
(release click). A prod release = one PR from `preview` into `main`
(merged with a **merge commit** — main's ruleset allows merge commits;
preview's stays squash-only), then the `production` environment
approval. This skill is the whole run; `docs/ci-cd.md` is the source
of truth it distills.

## 0. Preconditions

- `preview`'s tip deploy (`deploy-preview`) is **completed, success**
  and the smoke probe passed. Never release from a red preview.
- Every merged PR's required checks were green (they were, or the
  merge would have been blocked).
- You are `tejus3131` — the `production` environment's required
  approver.

## 1. Find the last release

```bash
gh pr list --base main --state merged --limit 1 \
  --json number,mergedAt,title
```

The newest PR merged into `main` is the previous release (e.g. #52).
Everything merged into `preview` **after its merge date** is this
release's cargo.

## 2. Open the release PR — base `main`, head `preview`

```bash
gh pr create --base main --head preview \
  --title "release: ship preview to production (YYYY-MM-DD)"
```

The PR points **directly at `preview`** — not a snapshot branch. That
is deliberate: anything merged into `preview` while the release PR is
open shows up in it automatically, so the release can never drift from
what preview has. The flip side: the PR is a moving target while open,
so write the description as a point-in-time list (step 3) and
**re-check the cargo list immediately before merging** (step 6).

## 3. Enumerate the cargo — every PR in this release

```bash
# PRs merged to preview since the last release's merge date
gh pr list --base preview --state merged \
  --search "merged:>YYYY-MM-DDTHH:MM:SSZ" --limit 100 \
  --json number,title,author,mergedAt,body
```

For **each** PR record in the release PR description:

- number, title, what it actually brings (one line from its `What &
why`, not its title alone)
- area: UI / server+data / MCP / migrations / docs-chore
- deploy legs it affects (path-based): `src/**` + `package.json` +
  `wrangler.jsonc` → worker; `supabase/migrations/**` +
  `supabase/config.toml` → migrations; `supabase/functions/**` → MCP
  function

Build the leg summary the deploy will run: the union across all PRs.
If in doubt, diff the trees:

```bash
git diff --stat origin/main...origin/preview -- supabase/migrations supabase/functions package.json
```

## 4. Migrations check (never skip)

- If `supabase/migrations` moved since the last release: every new
  migration needs its guard note (what it does to existing rows, why
  it's safe) — copied from the PR that added it. **Never edit a merged
  migration.**
- Note the migration leg ordering: migrations deploy before the worker
  (ADR-14's ordered matrix), so schema lands first.

## 5. Write the release PR description

Body structure (use `.github/pull_request_template.md`):

1. **What & why** — one paragraph: this is the batched release click;
   everything passed preview's gate and deployed there first.
2. **Cargo list** — the section-3 list: every PR with number, title,
   what it brings, area. This is the release's changelog; the
   auto-generated `release-rN` notes will mirror it.
3. **Deploy impact** — which legs run (worker / migrations / MCP), and
   explicitly "**no new migrations**" or the guard-note list.
4. **Evidence per area** — preview deploy run link (green), server +
   migration-guard green, docs updated.

## 6. Pre-merge sanity (re-run right before merging)

Because the PR tracks `preview` live, re-do these at merge time:

```bash
gh pr list --base preview --state merged \
  --search "merged:>YYYY-MM-DDTHH:MM:SSZ"   # any new PRs since step 3?
git grep -n '^<<<<<<<\|^>>>>>>>' HEAD       # must return nothing
gh pr checks <num>                          # wait until every required check passes
```

Required: `classify`, `lint`, `format`, `knip`, `client`, `server`,
`functions` (when functions moved), `migration-guard`, plus CodeQL
blockers — the ruleset blocks on high-or-higher alerts, so check there
are no open ones. If new PRs landed on preview, add them to the cargo
list in the description.

## 7. Merge and approve the deploy

```bash
gh pr merge <num> --merge   # release PRs merge with a MERGE COMMIT, not
                            # squash: squash diverges main from preview
                            # (the squash commit exists only on main) and
                            # forces "absorb main's history" merges later.
                            # Only main's ruleset allows merge commits.
```

Merging `main` triggers `deploy-prod` (path-based, ordered matrix). It
creates a pending **`production` environment deployment** — the release
click that only `tejus3131` can approve:

- Approve in the Actions run UI, or
- approve the pending deployment via the API from the run id

Never bypass; the approval IS the release decision.

## 8. Verify the release

- `deploy-prod` run: every leg succeeded, `release-rN` tag + GitHub
  Release created (auto-notes list the merged PRs — cross-check them
  against the cargo list in the PR description).
- A success **Deployment** record on the `production` environment.
- Smoke the prod URL by hand: sign in, open a board, move a card, see
  the change you released actually there.

## Rollback

Rollback = revert the merge commit on `main` (PR + squash or direct
revert PR), which re-triggers `deploy-prod` from the reverted tree.
Never force-push; never deploy a stale `dist/` by hand. If migrations
ran, a revert of app code is safe (schema is forward-only), but
rolling a migration back needs a new migration, not a delete.

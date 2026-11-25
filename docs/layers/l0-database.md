# L0 — Database

Postgres is the truth and the security layer. Everything downstream is a
projection of it.

## Owns

- Tables, indexes, constraints
- RLS policies (the only security gate — web, MCP, and direct SQL all pass
  through them)
- Triggers: `board_revisions` bumps, event logging, counter maintenance,
  backstop guards
- The `events` log (ADR-4) — one vocabulary, `{id, name}` snapshots in
  `detail`
- Per-op domain functions (ADR-5) — the single write path

## May not

- Know the app: no UI concepts, no view shapes, no "what the board page
  shows". A domain function validates and writes; it does not assemble
  views.
- Contain business logic duplicated elsewhere: if a mutation rule exists in
  TS and in SQL, the SQL one wins and the TS one is a thin caller.

## Rules

1. **Migrations are the only schema path** (ADR-12). Numbered, one concern
   each, design notes in the header. Never edit a merged migration.
2. **Every table gets RLS in the same migration that creates it.** A table
   without RLS is a deploy blocker.
3. **Cursors live here** (performance-rules 2): revisions and sequence
   numbers are bumped by triggers, in the same transaction as the change.
4. **Events are written by the mutation, not derived later.** A per-op
   function logs its event in the same transaction. Display snapshots
   (`{id, name}`) are captured at write time — history must render even if
   the entity is gone (the 0058 lesson, the Jira lesson).
5. **Counters are rows, not aggregates** (ADR-7): comment counts and similar
   stats are maintained by triggers, never computed per read.
6. **`security definer` needs a comment explaining why** it isn't
   `security invoker` — and a `set search_path`.
7. **Deploy order is schema-first** (ADR-14): code that needs a column
   ships with the migration, never before it. Code tolerates the
   pre-migration state only inside an explicitly commented window (the
   0032 fallback pattern).

## Worked example — adding a mutation

`update_tag` becomes a domain function: validate (name ≤ 24, lowercased),
update the row, log the `events` row with the old/new name snapshot, bump
the workspace revision. The web server fn and the MCP op both call it.
Neither contains validation logic.

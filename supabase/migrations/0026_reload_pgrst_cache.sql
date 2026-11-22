-- 0026: reload the PostgREST schema cache.
--
-- Migration 0024 added notifications.subject_team_id (FK to teams), but
-- PostgREST's cached schema never picked it up: every embedded read
-- `teams!notifications_subject_team_id_fkey(...)` fails with PGRST200
-- ("Could not find a relationship between 'notifications' and 'teams'
-- in the schema cache"). `db push` DDL doesn't always wake PostgREST;
-- the documented remedy is this notify. Harmless to re-run.
NOTIFY pgrst, 'reload schema';

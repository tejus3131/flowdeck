// DB-level tests for the capsule guards and backlink contracts — the
// destructive behavior no unit test can speak to. These run against the
// LOCAL supabase stack (127.0.0.1:54322) and skip cleanly when it isn't
// running, so `pnpm test` stays green on machines without it.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/** Run SQL statements in ONE psql session (set_config/role stick per
 *  session — exactly how the app paths authenticate). */
const sql = (...statements: string[]): string =>
  execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-qAt', ...statements.flatMap((s) => ['-c', s])], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const canConnect = (() => {
  try {
    sql('select 1');
    return true;
  } catch {
    return false;
  }
})();

const d = canConnect ? describe : describe.skip;

// The scratch world: one workspace, one board, one list — torn down with
// the purge flag at the end. The owner is the stack's existing first
// user; the second member is a throwaway account.
const SLUG = `db-guards-${randomUUID().slice(0, 8)}`;
const OWNER = '11be3592-fa7c-4756-ba18-01f21a84f44a';
let WS = '';
let BOARD = '';
let LIST = '';
let MEMBER = '';

/** psql that is EXPECTED to fail — returns the error text. */
const failSql = (...statements: string[]): string => {
  try {
    sql(...statements);
    return '';
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
};

d('DB guards (local stack)', () => {
  beforeAll(() => {
    WS = sql(
      `insert into public.workspaces (name, slug, owner_id) values ('DB guards ${SLUG}', '${SLUG}', '${OWNER}') returning id`,
    ).trim();
    sql(`insert into public.workspace_members (workspace_id, user_id, role) values ('${WS}', '${OWNER}', 'owner')`);
    BOARD = sql(
      `insert into public.boards (workspace_id, name, owner_id) select '${WS}', 'Guard board', '${OWNER}' returning id`,
    ).trim();
    LIST = sql(
      `insert into public.lists (board_id, name, position) values ('${BOARD}', 'L', 1) returning id`,
    ).trim();
    MEMBER = sql(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
       values (gen_random_uuid(), null, 'authenticated', 'authenticated', '${SLUG}@db-guards.test', 'x', now(), now(), now(), '{}', '{}') returning id`,
    ).trim();
    sql(`insert into public.workspace_members (workspace_id, user_id, role) values ('${WS}', '${MEMBER}', 'member')`);
  });

  afterAll(() => {
    if (!WS) return;
    // The scratch world goes via the sanctioned purge path.
    sql(
      'begin',
      "select set_config('flowdeck.purge', 'on', true)",
      `delete from public.workspaces where id = '${WS}'`,
      'commit',
    );
    if (MEMBER) sql(`delete from auth.users where id = '${MEMBER}'`);
  });

  it('cards refuse bare deletes; the purge flag stands the guard down', () => {
    const card = sql(
      `insert into public.cards (board_id, list_id, title, number, created_by) select '${BOARD}', '${LIST}', 'Guarded', 1, '${OWNER}' returning id`,
    ).trim();
    const bare = failSql(`delete from public.cards where id = '${card}'`);
    expect(bare).toContain('cards cannot be deleted');
    sql(
      'begin',
      "select set_config('flowdeck.purge', 'on', true)",
      `delete from public.cards where id = '${card}'`,
      'commit',
    );
  });

  it('tags refuse deletes — the dangling-links rule', () => {
    const tag = sql(
      `insert into public.tags (workspace_id, name) values ('${WS}', 'guarded') returning id`,
    ).trim();
    const bare = failSql(`delete from public.tags where id = '${tag}'`);
    expect(bare).toContain('tags cannot be deleted');
    // Still there — the guard refused, the row survives.
    expect(sql(`select count(*) from public.tags where id = '${tag}'`).trim()).toBe('1');
  });

  it('teams refuse deletes while holding members', () => {
    const team = sql(
      `insert into public.teams (workspace_id, name) values ('${WS}', 'guard-team') returning id`,
    ).trim();
    sql(`insert into public.team_members (team_id, user_id, role) values ('${team}', '${MEMBER}', 'member')`);
    const refused = failSql(`delete from public.teams where id = '${team}'`);
    expect(refused).toContain('still has 1 member');
    sql(`delete from public.team_members where team_id = '${team}'`);
    sql(`delete from public.teams where id = '${team}'`);
  });

  it('workspaces refuse deletes while other members or cards exist', () => {
    // Other member: the member seeded in beforeAll blocks.
    const memberRefusal = failSql(`delete from public.workspaces where id = '${WS}'`);
    expect(memberRefusal).toContain('other member');
    // Cards: move the member out of the way, then a card blocks.
    sql(`delete from public.workspace_members where workspace_id = '${WS}' and user_id = '${MEMBER}'`);
    sql(
      `insert into public.cards (board_id, list_id, title, number, created_by) select '${BOARD}', '${LIST}', 'Blocker', 2, '${OWNER}'`,
    );
    const cardRefusal = failSql(`delete from public.workspaces where id = '${WS}'`);
    expect(cardRefusal).toContain('still hold');
    sql('begin', "select set_config('flowdeck.purge', 'on', true)", `delete from public.cards where board_id = '${BOARD}'`, 'commit');
    // The empty workspace now deletes cleanly through the guard (it arms
    // the flag for its own cascade) — verified on the real WS in the
    // afterAll teardown; here just confirm the guard's own checks pass
    // by NOT raising for a dry check: re-add the member for later tests
    // is unnecessary — nothing else needs the member.
  });

  it('log_card_mentions rejects a forged source anchor', () => {
    const card = sql(
      `insert into public.cards (board_id, list_id, title, number, created_by) select '${BOARD}', '${LIST}', 'Anchored', 3, '${OWNER}' returning id`,
    ).trim();
    const forged = sql(
      "select set_config('role', 'authenticated', false)",
      `select set_config('request.jwt.claims', json_build_object('sub', '${OWNER}', 'role', 'authenticated')::text, false)`,
      `select public.log_card_mentions('see [Anchored](card:${card})', 'chat', '${BOARD}', null, '99999999-9999-9999-9999-999999999999'::uuid)`,
    );
    // The last statement's output is the return value: 0 — the invented
    // message id never existed.
    expect(forged.trim().split('\n').pop()).toBe('0');
  });

  it('log_board_mentions posts once per (source, target) — concurrent calls dedupe', () => {
    const targetBoard = sql(
      `insert into public.boards (workspace_id, name, owner_id) select '${WS}', 'Backlink target', '${OWNER}' returning id`,
    ).trim();
    sql(`insert into public.lists (board_id, name, position) values ('${targetBoard}', 'L', 1)`);
    // A REAL source message — the anchor validation (0071) rejects
    // invented ids.
    const sourceId = '88888888-8888-8888-8888-888888888888';
    sql(
      `insert into public.board_messages (id, board_id, user_id, body, seq) select '${sourceId}'::uuid, '${BOARD}', '${OWNER}', 'see [target](board:${targetBoard})', public.allocate_chat_seq('board_message', '${BOARD}')`,
    );
    const run = () =>
      sql(
        "select set_config('role', 'authenticated', false)",
        `select set_config('request.jwt.claims', json_build_object('sub', '${OWNER}', 'role', 'authenticated')::text, false)`,
        `select public.log_board_mentions('see [target](board:${targetBoard})', 'chat', '${BOARD}', null, '${sourceId}'::uuid)`,
      ).trim().split('\n').pop();
    const first = run();
    const retry = run();
    expect(Number(first)).toBe(1);
    expect(Number(retry)).toBe(0); // the deterministic client_op dedupes
    const rows = sql(
      `select count(*) from public.board_messages where board_id = '${targetBoard}' and client_op is not null`,
    ).trim();
    expect(rows).toBe('1');
  });

  it('purge_workspace_boards notifies the members it reaches', () => {
    // Re-add the throwaway member, purge, expect their notification row.
    sql(`insert into public.workspace_members (workspace_id, user_id, role) values ('${WS}', '${MEMBER}', 'member')`);
    sql(
      "select set_config('role', 'authenticated', false)",
      `select set_config('request.jwt.claims', json_build_object('sub', '${OWNER}', 'role', 'authenticated')::text, false)`,
      `select public.purge_workspace_boards('${WS}')`,
    );
    const notified = sql(
      `select count(*) from public.notifications where kind = 'workspace_purged' and user_id = '${MEMBER}'`,
    ).trim();
    expect(notified).toBe('1');
    // The actor does not notify themselves.
    const selfNotified = sql(
      `select count(*) from public.notifications where kind = 'workspace_purged' and user_id = '${OWNER}'`,
    ).trim();
    expect(selfNotified).toBe('0');
  });
});

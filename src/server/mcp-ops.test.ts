// DB-level tests for the phase-5 per-op contract (ADR-5): mcp_exec is the
// thin dispatcher, every op is its own function, and the WEB path calls the
// same functions directly under the caller's JWT. These run against the
// LOCAL supabase stack (127.0.0.1:54322) and skip cleanly when it isn't
// running, so `pnpm test` stays green on machines without it.
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/** Run SQL statements in ONE psql session (set_config/role stick per
 *  session — exactly how the app paths authenticate). */
const sql = (...statements: string[]): string =>
  execFileSync(
    'psql',
    [DB_URL, '-v', 'ON_ERROR_STOP=1', '-qAt', ...statements.flatMap((s) => ['-c', s])],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

/** psql that is EXPECTED to fail — returns the error text. */
const failSql = (...statements: string[]): string => {
  try {
    sql(...statements);
    return '';
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
};

const canConnect = (() => {
  // The skip must be VISIBLE, not silent: without host psql the whole
  // contract suite is invisible, and a green run here is not a green run.
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
  } catch {
    // vitest drops console output from fully-skipped files — a plain
    // console.warn is INVISIBLE. stderr is not intercepted.
    process.stderr.write('[mcp-ops] host psql not found — contract tests SKIP (invisible)\n');
    return false;
  }
  try {
    sql('select 1');
    return true;
  } catch {
    console.warn('[mcp-ops] local stack unreachable at 127.0.0.1:54322 — contract tests SKIP');
    return false;
  }
})();

const d = canConnect ? describe : describe.skip;

// The scratch world: one workspace + board, torn down with the purge flag
// at the end. The owner is the probe fixture user, SELF-SEEDED in
// beforeAll (a fresh `supabase db reset` has no profiles); the member is
// the mention target for the dispatcher test.
const OWNER = '3fb0c1d2-6a44-4f3e-9c31-b04a2d5e7f01';
const MEMBER = '4cc1d2e3-7b55-4a4f-8d42-c15b3e6f8a12';
let WS = '';
let BOARD = '';

/** Impersonate a user the way the web server fns (via PostgREST) do. */
const asUser = (id: string) => [
  "select set_config('role', 'authenticated', false)",
  `select set_config('request.jwt.claims', json_build_object('sub', '${id}', 'role', 'authenticated')::text, false)`,
];

d('mcp per-op functions (local stack)', () => {
  beforeAll(() => {
    // Self-seed the fixture users exactly like db-guards: a fresh reset
    // leaves NO profiles, and this suite must not assume state beyond the
    // migrations. Idempotent on a stack that already has the fixture.
    sql(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token, email_change, email_change_token_new)
       select '${OWNER}',
              coalesce((select instance_id from auth.users limit 1), '00000000-0000-0000-0000-000000000000'),
              'authenticated', 'authenticated', 'mcp-ops@orbit.local', 'x', now(), now(), now(),
              '{"provider":"email","providers":["email"]}', '{"display_name":"MCP Ops Probe"}',
              '', '', '', ''
       on conflict do nothing`,
      `insert into public.profiles (id, email, display_name) values ('${OWNER}', 'mcp-ops@orbit.local', 'MCP Ops Probe') on conflict do nothing`,
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token, email_change, email_change_token_new)
       select '${MEMBER}',
              coalesce((select instance_id from auth.users limit 1), '00000000-0000-0000-0000-000000000000'),
              'authenticated', 'authenticated', 'mcp-member@orbit.local', 'x', now(), now(), now(),
              '{"provider":"email","providers":["email"]}', '{}', '', '', '', ''
       on conflict do nothing`,
      `insert into public.profiles (id, email, display_name) values ('${MEMBER}', 'mcp-member@orbit.local', 'MCP Member Probe') on conflict do nothing`,
      `insert into public.workspaces (name, slug, owner_id) values ('MCP ops world', 'mcp-ops-world', '${OWNER}') on conflict do nothing`,
      `select id from public.workspaces where slug = 'mcp-ops-world'`,
    );
    WS = sql(`select id from public.workspaces where slug = 'mcp-ops-world'`).trim();
    sql(
      `insert into public.workspace_members (workspace_id, user_id, role) values ('${WS}', '${OWNER}', 'owner') on conflict do nothing`,
      `insert into public.workspace_members (workspace_id, user_id, role) values ('${WS}', '${MEMBER}', 'member') on conflict do nothing`,
    );
  });

  afterAll(() => {
    if (!WS) return;
    // The scratch world goes via the sanctioned purge path — and the
    // fixture users go with it: both probe rows, or a long-lived stack
    // accumulates them.
    sql(
      'begin',
      "select set_config('orbit.purge', 'on', true)",
      `delete from public.workspaces where id = '${WS}'`,
      'commit',
    );
    sql(
      `delete from auth.users where id = '${MEMBER}'`,
      `delete from auth.users where id = '${OWNER}'`,
    );
  });

  it('the dispatcher runs the full write path and stamps agent provenance', () => {
    // create_board with an EXPLICIT workspace (the earliest-workspace
    // default is a different contract, tested by the exercise scripts).
    const boardOut = sql(
      `select public.mcp_exec('${OWNER}', 'create_board', jsonb_build_object('name', 'Ops board', 'workspace_id', '${WS}')) -> 'data' ->> 'board_id'`,
    ).trim();
    BOARD = boardOut;
    expect(BOARD).toMatch(/^[0-9a-f-]{36}$/);

    const listOut = sql(
      `select public.mcp_exec('${OWNER}', 'create_list', jsonb_build_object('board_id', '${BOARD}', 'name', 'Ops list')) -> 'data' ->> 'list_id'`,
    ).trim();
    const cardOut = sql(
      `select public.mcp_exec('${OWNER}', 'create_card', jsonb_build_object('list_id', '${listOut}', 'title', 'Dispatched card', 'priority', 'high')) -> 'data' ->> 'card_id'`,
    ).trim();
    expect(cardOut).toMatch(/^[0-9a-f-]{36}$/);

    // The comment mentions the member: the dispatcher's per-op fan-out
    // delivers the notification. The member can SEE the board (an edit
    // grant) — a mention on someone who cannot see the board is
    // deliberately withheld (check_mention_access's contract).
    sql(
      `insert into public.board_access (board_id, user_id, access) values ('${BOARD}', '${MEMBER}', 'edit') on conflict do nothing`,
    );
    sql(
      `select public.mcp_exec('${OWNER}', 'add_comment', jsonb_build_object('card_id', '${cardOut}', 'body', 'hello [member](user:${MEMBER})'))`,
    );
    const commentCount = sql(
      `select count(*) from public.card_comments where card_id = '${cardOut}'`,
    ).trim();
    expect(commentCount).toBe('1');
    const mentionCount = sql(
      `select count(*) from public.notifications where user_id = '${MEMBER}' and kind = 'mention' and card_id = '${cardOut}'`,
    ).trim();
    expect(mentionCount).toBe('1');

    // Agent provenance: everything the MCP path writes is stamped.
    const agentFlags = sql(
      `select distinct agent from public.events where card_id = '${cardOut}'`,
    ).trim();
    expect(agentFlags).toBe('t');
    const commentAgent = sql(
      `select agent from public.card_comments where card_id = '${cardOut}'`,
    ).trim();
    expect(commentAgent).toBe('t');
  });

  it('the WEB path: a direct per-op call runs under the caller JWT and is NOT agent-stamped', () => {
    const listOut = sql(
      `select id from public.lists where board_id = '${BOARD}' order by position limit 1`,
    ).trim();
    // Exactly what a 'use server' fn does: the request client's JWT rides
    // along; the per-op function runs under the caller's own RLS context.
    const cardOut = sql(
      ...asUser(OWNER),
      `select public.mcp_create_card('${OWNER}', jsonb_build_object('list_id', '${listOut}', 'title', 'Web path card')) -> 'data' ->> 'card_id'`,
    )
      .trim()
      .split('\n')
      .pop()!;
    expect(cardOut).toMatch(/^[0-9a-f-]{36}$/);

    const title = sql(`select title from public.cards where id = '${cardOut}'`).trim();
    expect(title).toBe('Web path card');
    const agentFlag = sql(
      `select agent from public.events where card_id = '${cardOut}' and kind = 'created'`,
    ).trim();
    expect(agentFlag).toBe('f');
  });

  it('the caller guard: a direct call with someone else’s id is rejected before any read', () => {
    const err = failSql(
      ...asUser(MEMBER),
      `select public.mcp_create_card('${OWNER}', jsonb_build_object('list_id', (select id from public.lists where board_id = '${BOARD}' order by position limit 1), 'title', 'Spoofed'))`,
    );
    expect(err).toContain('unknown user');
  });

  it('anon cannot execute the per-op functions (0084 revoked the surface)', () => {
    const listOut = sql(
      `select id from public.lists where board_id = '${BOARD}' order by position limit 1`,
    ).trim();
    const err = failSql(
      "select set_config('role', 'anon', false)",
      `select public.mcp_create_card('${OWNER}', jsonb_build_object('list_id', '${listOut}', 'title', 'Nope'))`,
    );
    expect(err).toContain('permission denied for function mcp_create_card');
  });

  it('authenticated cannot execute the dispatcher itself (it trusts p_user_id)', () => {
    const err = failSql(
      ...asUser(OWNER),
      `select public.mcp_exec('${OWNER}', 'get_me', '{}'::jsonb)`,
    );
    expect(err).toContain('permission denied for function mcp_exec');
  });
});

// The export route's completeness contract (GDPR Art. 15/20): a signed-in
// caller gets every section the account owns; a signed-out caller gets
// 401. The Supabase client is stubbed at the module boundary — the test
// pins the SHAPE and the RLS discipline (request-scoped client only),
// not the database.
import { describe, expect, it, vi, beforeEach } from 'vitest';

// The route imports the request-scoped client factory; tests swap it.
const getUser = vi.fn();
const from = vi.fn();

vi.mock('../../../server/supabase', () => ({
  createSupabaseRequestClient: () => ({
    auth: { getUser },
    from,
  }),
}));

import { GET } from './export';

/** Chainable query builder: every terminal method resolves to `result`. */
function table(result: unknown) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    maybeSingle: () => Promise.resolve({ data: result }),
    // The list reads await the builder directly (Supabase's thenable).
    then: (resolve: (value: { data: unknown }) => void) =>
      Promise.resolve({ data: result }).then(resolve),
  };
  return builder;
}

beforeEach(() => {
  getUser.mockReset();
  from.mockReset();
});

describe('GET /api/account/export', () => {
  it('401s a signed-out caller', async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const response = (await GET({
      request: new Request('https://x.test/api/account/export'),
    } as never)) as Response;
    expect(response.status).toBe(401);
  });

  it('returns every owned section for a signed-in caller', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: 'u-1', email: 'a@b.c', created_at: '2026-01-01' } },
    });
    from.mockImplementation((name: string) => {
      const rows: Record<string, unknown> = {
        profiles: { id: 'u-1', display_name: 'A' },
        workspace_members: [{ workspace_id: 'w-1', role: 'owner', created_at: '2026-01-01' }],
        workspaces: [{ id: 'w-1', name: 'WS' }],
        boards: [{ id: 'b-1', workspace_id: 'w-1' }],
        lists: [{ id: 'l-1', board_id: 'b-1' }],
        cards: [{ id: 'c-1', board_id: 'b-1' }],
      };
      return table(rows[name] ?? []);
    });
    const response = (await GET({
      request: new Request('https://x.test/api/account/export'),
    } as never)) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = JSON.parse(await response.text());
    expect(body.format).toBe('orbit-export/1');
    expect(body.account.id).toBe('u-1');
    expect(body.workspaces).toHaveLength(1);
    expect(body.memberships).toHaveLength(1);
    expect(body.boards).toHaveLength(1);
    expect(body.lists).toHaveLength(1);
    expect(body.cards).toHaveLength(1);
  });

  it('skips the workspace-scoped queries when the account has no memberships', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: 'u-2', email: 'x@y.z', created_at: '2026-01-01' } },
    });
    from.mockImplementation((name: string) =>
      name === 'profiles' ? table({ id: 'u-2' }) : table([]),
    );
    const response = (await GET({
      request: new Request('https://x.test/api/account/export'),
    } as never)) as Response;
    const body = JSON.parse(await response.text());
    expect(body.workspaces).toEqual([]);
    expect(body.boards).toEqual([]);
    // The .in() filter never ran with an empty list — the guard held.
    expect(from).not.toHaveBeenCalledWith('boards', expect.anything());
  });
});

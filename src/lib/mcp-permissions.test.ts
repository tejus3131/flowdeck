// The permission taxonomy's dependency machinery — the core of the
// consent/connections UX. These tests pin the reactive behavior:
// writes pull reads on, reads off cascade writes off, tri-state cycles,
// caps strip what a role can't grant, and the stored op map round-trips.
import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_ENTITIES,
  WORKSPACE_ENTITIES,
  capSelection,
  emptySelection,
  normalizeSelection,
  selectionToWorkspaceOps,
  toggleActionInSelection,
  toggleEntityInSelection,
  toggleWorkspaceInSelection,
  workspaceOps,
  workspaceOpsToSelection,
  type PermissionSelection,
} from './mcp-permissions';

const WS = '11111111-1111-1111-1111-111111111111';
const WS2 = '22222222-2222-2222-2222-222222222222';

const memberCap = { role: 'member' as const, canCreateBoards: false };
const adminCap = { role: 'admin' as const, canCreateBoards: true };
const ownerCap = { role: 'owner' as const, canCreateBoards: true };

const sel = (workspaces: Record<string, Record<string, string[]>> = {}, account: Record<string, string[]> = {}): PermissionSelection => ({
  workspaces,
  account,
});

describe('dependency resolution — writes imply reads', () => {
  it('enabling a write switches its read on', () => {
    const next = toggleActionInSelection(sel({ [WS]: {} }), 'workspaces', WS, 'cards', 'create', true);
    expect(next.workspaces[WS].cards).toContain('read');
  });

  it('disabling the read switches every dependent write off', () => {
    let s = sel({ [WS]: {} });
    s = toggleActionInSelection(s, 'workspaces', WS, 'cards', 'create', true);
    s = toggleActionInSelection(s, 'workspaces', WS, 'cards', 'update', true);
    expect([...s.workspaces[WS].cards].sort()).toEqual(['create', 'read', 'update']);
    const off = toggleActionInSelection(s, 'workspaces', WS, 'cards', 'read', false);
    expect(off.workspaces[WS].cards).toBeUndefined();
  });

  it('cross-entity requirements pull in (cards.create requires boards.read)', () => {
    const next = toggleActionInSelection(sel({ [WS]: {} }), 'workspaces', WS, 'cards', 'create', true);
    expect(next.workspaces[WS].boards).toContain('read');
  });

  it('disabling boards.read cascades into cards writes', () => {
    let s = sel({ [WS]: {} });
    s = toggleActionInSelection(s, 'workspaces', WS, 'cards', 'create', true);
    const off = toggleActionInSelection(s, 'workspaces', WS, 'boards', 'read', false);
    expect(off.workspaces[WS].cards).toBeUndefined();
    expect(off.workspaces[WS].boards).toBeUndefined();
  });

  it('normalizeSelection enforces requirements server-side too', () => {
    // a crafted payload: cards.create without boards.read
    const crafted = sel({ [WS]: { cards: ['create'] } });
    const normalized = normalizeSelection(crafted);
    expect(normalized.workspaces[WS].boards).toContain('read');
  });
});

describe('tri-state entity toggle', () => {
  it('off → defaults (reads), defaults → everything, everything → off', () => {
    let s = sel({ [WS]: {} }, {});
    // off → reads
    s = toggleEntityInSelection(s, 'workspaces', WS, 'cards', memberCap);
    expect(s.workspaces[WS].cards).toEqual(['read']);
    // reads → everything offered
    s = toggleEntityInSelection(s, 'workspaces', WS, 'cards', memberCap);
    expect(s.workspaces[WS].cards).toEqual(['read', 'create', 'update', 'delete']);
    // everything → off
    s = toggleEntityInSelection(s, 'workspaces', WS, 'cards', memberCap);
    expect(s.workspaces[WS].cards).toBeUndefined();
  });

  it('a member is never offered admin actions', () => {
    let s = sel({ [WS]: {} });
    s = toggleEntityInSelection(s, 'workspaces', WS, 'tags', memberCap);
    // member only gets read on tags
    expect(s.workspaces[WS].tags).toEqual(['read']);
    s = toggleEntityInSelection(s, 'workspaces', WS, 'tags', adminCap);
    // admin gets everything
    expect(s.workspaces[WS].tags?.sort()).toEqual(['create', 'delete', 'read', 'rename']);
  });

  it('board creation is only offered to those the workspace allows', () => {
    let s = sel({ [WS]: {} });
    // member without board-create rights: entity toggle never grants create
    s = toggleEntityInSelection(s, 'workspaces', WS, 'boards', memberCap);
    expect(s.workspaces[WS].boards).not.toContain('create');
    s = toggleEntityInSelection(s, 'workspaces', WS, 'boards', { ...memberCap, canCreateBoards: true });
    expect(s.workspaces[WS].boards).toContain('create');
  });
});

describe('entity off cascades dependents (review fix 1)', () => {
  it('cycling the Boards entity to off empties fully-granted Cards', () => {
    let s = sel({ [WS]: {} });
    s = toggleEntityInSelection(s, 'workspaces', WS, 'cards', memberCap); // reads
    s = toggleEntityInSelection(s, 'workspaces', WS, 'cards', memberCap); // everything
    expect(s.workspaces[WS].cards).toContain('update');
    // Boards cycle: [read] → everything → off.
    s = toggleEntityInSelection(s, 'workspaces', WS, 'boards', memberCap);
    expect(s.workspaces[WS].boards).toContain('edit'); // everything
    s = toggleEntityInSelection(s, 'workspaces', WS, 'boards', memberCap); // off
    expect(s.workspaces[WS].boards).toBeUndefined();
    expect(s.workspaces[WS].cards).toBeUndefined(); // cascaded, not re-added
  });

  it('Boards off then reads leaves Cards empty (no silent re-grant)', () => {
    let s = sel({ [WS]: {} });
    s = toggleEntityInSelection(s, 'workspaces', WS, 'cards', memberCap);
    s = toggleEntityInSelection(s, 'workspaces', WS, 'cards', memberCap);
    s = toggleEntityInSelection(s, 'workspaces', WS, 'boards', memberCap); // everything
    s = toggleEntityInSelection(s, 'workspaces', WS, 'boards', memberCap); // off
    s = toggleEntityInSelection(s, 'workspaces', WS, 'boards', memberCap); // reads
    expect(s.workspaces[WS].cards).toBeUndefined();
  });
});

describe('tri-state workspace toggle', () => {
  it('off → every entity\u2019s reads, then everything, then off', () => {
    let s = emptySelection();
    s = toggleWorkspaceInSelection(s, WS, memberCap);
    expect(s.workspaces[WS].cards).toEqual(['read']);
    expect(s.workspaces[WS].chat).toEqual(['read']);
    expect(s.workspaces[WS].tags).toEqual(['read']);
    s = toggleWorkspaceInSelection(s, WS, memberCap);
    expect(s.workspaces[WS].boards).toContain('edit');
    expect(s.workspaces[WS].cards).toContain('delete');
    s = toggleWorkspaceInSelection(s, WS, memberCap);
    expect(s.workspaces[WS]).toBeUndefined(); // org off = key gone
  });
});

describe('caps — a grant can never exceed the user\u2019s own reach', () => {
  it('strips admin/owner actions from a member', () => {
    const crafted = normalizeSelection(
      sel({
        [WS]: {
          cards: ['read', 'create', 'update', 'delete'],
          tags: ['read', 'create', 'rename', 'delete'],
          teams: ['read', 'manage'],
          boards: ['read', 'create', 'delete'],
        },
      }),
    );
    const capped = capSelection(crafted, { [WS]: memberCap });
    expect(capped.workspaces[WS].cards).toContain('delete'); // member can delete cards
    expect(capped.workspaces[WS].tags).toEqual(['read']); // tag writes are admin
    expect(capped.workspaces[WS].teams).toEqual(['read']); // team manage is admin
    expect(capped.workspaces[WS].boards).not.toContain('delete');
    expect(capped.workspaces[WS].boards).not.toContain('create'); // gate blocks it
  });

  it('keeps everything for an owner', () => {
    const crafted = normalizeSelection(sel({ [WS]: { boards: ['read', 'create', 'edit', 'delete'] } }));
    const capped = capSelection(crafted, { [WS]: ownerCap });
    expect(capped.workspaces[WS].boards?.sort()).toEqual(['create', 'delete', 'edit', 'read']);
  });

  it('drops workspaces the user is not in', () => {
    const crafted = normalizeSelection(sel({ [WS2]: { cards: ['read'] } }));
    const capped = capSelection(crafted, { [WS]: memberCap });
    expect(capped.workspaces[WS2]).toBeUndefined();
  });
});

describe('round-trip — stored ops ↔ picker selection', () => {
  it('selection → ops → selection keeps every action intact', () => {
    let s = sel({ [WS]: {} }, {});
    s = toggleActionInSelection(s, 'workspaces', WS, 'cards', 'update', true);
    s = toggleActionInSelection(s, 'workspaces', WS, 'chat', 'post', true);
    s = toggleActionInSelection(s, 'account', null, 'notifications', 'mark', true);
    const ops = selectionToWorkspaceOps(s)!;
    expect(ops[WS]).toContain('update_card');
    expect(ops[WS]).toContain('move_card');
    expect(ops[WS]).toContain('get_cards'); // pulled in
    expect(ops['*']).toContain('mark_notification_read');
    const back = workspaceOpsToSelection(ops);
    expect(back.workspaces[WS].cards).toContain('update');
    expect(back.account.notifications).toContain('mark');
  });
});

describe('taxonomy sanity', () => {
  it('every workspace entity has at least one member-visible action', () => {
    for (const entity of WORKSPACE_ENTITIES) {
      expect(entity.actions.some((a) => !a.role || a.role === 'member')).toBe(true);
    }
  });

  it('account entities have no roles or gates', () => {
    for (const entity of ACCOUNT_ENTITIES) {
      for (const action of entity.actions) {
        expect(action.role).toBeUndefined();
        expect(action.gate).toBeUndefined();
      }
    }
  });
});

// ── the grant/request split ────────────────────────────────────────────────
// 'Grant & request access' used to be one member-offered action — members
// saw grant_board_access (an admin-tier power) next to their own. Now
// request is member-level, grant is admin-tier, and the cap enforces it.

describe('access entity: grant vs request', () => {
  it('members keep request but lose grant', () => {
    const capped = capSelection(
      sel({ [WS]: { access: ['check', 'request', 'grant'] } }),
      { [WS]: memberCap },
    );
    expect(capped.workspaces[WS].access).toEqual(['check', 'request']);
  });

  it('admins keep both', () => {
    const capped = capSelection(
      sel({ [WS]: { access: ['check', 'request', 'grant'] } }),
      { [WS]: adminCap },
    );
    expect(capped.workspaces[WS].access).toEqual(['check', 'request', 'grant']);
  });

  it('the ops round-trip: request maps to request_board_access only', () => {
    const ops = workspaceOps({ access: ['check', 'request'] });
    expect(ops).toContain('request_board_access');
    expect(ops).not.toContain('grant_board_access');
    const back = workspaceOpsToSelection({ [WS]: ops }).workspaces[WS];
    expect(back.access).toEqual(['check', 'request']);
  });

  it('grant_board_access is still grantable for admins (ALL_OPS intact)', () => {
    expect(WORKSPACE_ENTITIES.flatMap((e) => e.actions).flatMap((a) => a.ops))
      .toContain('grant_board_access');
  });
});

// Entity store tests — Phase 1's L2 core (ADR-1). The behaviors the
// canonical test depends on: one write updates every selector in the
// same pass, partial rows never clobber richer ones, and re-ingesting
// unchanged snapshots churns nothing.
//
// Solid 2 discipline: the store is created inside a root (its selectors
// need an owner), but WRITES happen from the test body — reactive
// writes inside an owned scope throw in dev, exactly like the app rule.
import { afterEach, describe, expect, it } from 'vitest';
import { createEffect, createRoot, flush } from 'solid-js';

import { createEntityStore, type EntityStore, type TagEntity } from './entity-store';
import { __testAge, cacheClear, cacheGet, cacheSetUser } from './cache';
import type { BoardSnapshot, CardView, ListRow } from './boards';
import type { WorkspaceDetail } from './workspaces';

/** cachePut is fire-and-forget; tests wait a macrotask for the write. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A store under a root that outlives the test (disposed by the caller). */
function makeStore(): { store: EntityStore; dispose: () => void } {
  let store!: EntityStore;
  const dispose = createRoot((d) => {
    store = createEntityStore();
    return d;
  });
  return { store, dispose };
}

// ── fixtures ─────────────────────────────────────────────────────────────

const lists = (): ListRow[] => [
  {
    id: 'l1',
    board_id: 'b1',
    name: 'To do',
    position: 1,
    created_at: '',
    client_op: null,
    description: '',
  },
];

const card = (id: string, tags: Array<{ id: string; name: string }>): CardView => ({
  id,
  board_id: 'b1',
  list_id: 'l1',
  title: id,
  description: '',
  position: 1,
  created_by: 'u1',
  created_at: '',
  updated_at: '',
  client_op: null,
  number: null,
  resolved_at: null,
  resolved_by: null,
  comment_count: 0,
  last_comment_at: null,
  priority: null,
  tags,
  assignees: [],
});

const boardSnapshot = (cards: CardView[]): BoardSnapshot => ({
  board: {
    id: 'b1',
    name: 'Board',
    owner_id: 'u1',
    workspace_id: 'ws1',
    created_at: '',
    updated_at: '',
    client_op: null,
    description: '',
    access_delegation: false,
  },
  lists: lists(),
  cards,
  revision: 1,
  myAccess: 'edit',
  denied: false,
});

const wsDetail = (
  tags: Array<{ id: string; name: string; description: string }>,
): WorkspaceDetail => ({
  workspace: { id: 'ws1', name: 'WS', invite_domains: [], board_creation: 'team_admins' },
  myRole: 'admin',
  members: [],
  invites: [],
  boards: [],
  access: {},
  tags,
  teams: [],
  deactivatedTeams: [],
  teamAccess: {},
});

// ── the store ─────────────────────────────────────────────────────────────

describe('entity store', () => {
  afterEach(async () => {
    cacheClear();
    cacheSetUser('');
    await settle();
  });

  it('upserts tags; tagById resolves them', () => {
    const { store, dispose } = makeStore();
    store.writeTags('ws1', [{ id: 't1', name: 'urgent', description: 'asap' }]);
    flush();
    expect(store.tagById('t1')).toEqual({
      id: 't1',
      workspace_id: 'ws1',
      name: 'urgent',
      description: 'asap',
    });
    expect(store.tagById('missing')).toBeUndefined();
    dispose();
  });

  it('a rename is one write — every selector re-evaluates in the same pass', () => {
    const { store, dispose } = makeStore();
    store.writeTags('ws1', [{ id: 't1', name: 'old' }]);

    // A selector watching the tag — the chip's read, in miniature.
    const seen: Array<string | undefined> = [];
    const watch = createRoot((d) => {
      createEffect(
        () => store.tagById('t1')?.name,
        (name) => {
          seen.push(name);
        },
      );
      return d;
    });
    flush();

    // The canonical test's core: ONE write lands, the selector moves.
    store.writeTags('ws1', [{ id: 't1', name: 'new' }]);
    flush();
    expect(seen).toEqual(['old', 'new']);

    watch();
    dispose();
  });

  it('unchanged re-ingests keep row identity — no selector churn', () => {
    const { store, dispose } = makeStore();
    store.writeTags('ws1', [{ id: 't1', name: 'urgent' }]);
    flush();
    const before = store.tagById('t1');
    store.writeTags('ws1', [{ id: 't1', name: 'urgent' }]);
    flush();
    expect(store.tagById('t1')).toBe(before);
    dispose();
  });

  it('partial rows (id + name) fill gaps but never clobber richer rows', () => {
    const { store, dispose } = makeStore();
    store.writeTags('ws1', [{ id: 't1', name: 'urgent', description: 'asap' }]);
    flush();
    // A card's chips carry id + name only — the description survives.
    store.writeTags('ws1', [{ id: 't1', name: 'urgent' }]);
    flush();
    expect(store.tagById('t1')?.description).toBe('asap');
    // The name (the mutable part) still updates from the partial row.
    store.writeTags('ws1', [{ id: 't1', name: 'renamed' }]);
    flush();
    expect(store.tagById('t1')).toMatchObject({ name: 'renamed', description: 'asap' });
    dispose();
  });

  it('tagsOfWorkspace lists the vocabulary, name-sorted, and rebuild prunes', () => {
    const { store, dispose } = makeStore();
    store.writeTags('ws1', [
      { id: 't2', name: 'beta' },
      { id: 't1', name: 'alpha' },
    ]);
    flush();
    expect(store.tagsOfWorkspace('ws1').map((t) => t.name)).toEqual(['alpha', 'beta']);

    // A later partial ingest (a board's chips) ADDS to the index…
    store.writeTags('ws1', [{ id: 't3', name: 'gamma' }]);
    flush();
    expect(store.tagsOfWorkspace('ws1').map((t) => t.name)).toEqual(['alpha', 'beta', 'gamma']);
    // …a full vocabulary snapshot REPLACES it (t2 fell out).
    store.writeTags('ws1', [{ id: 't1', name: 'alpha' }], { rebuild: true });
    flush();
    expect(store.tagsOfWorkspace('ws1').map((t) => t.name)).toEqual(['alpha']);
    // The pruned row itself survives — another board may still link it.
    expect(store.tagById('t2')?.name).toBe('beta');
    // A rename re-sorts the read without touching the index.
    store.writeTags('ws1', [{ id: 't1', name: 'zeta' }]);
    flush();
    expect(store.tagsOfWorkspace('ws1').map((t) => t.name)).toEqual(['zeta']);
    dispose();
  });

  it('join rows: links derive tagsOfCard; a rename flows through them', () => {
    const { store, dispose } = makeStore();
    store.writeTags('ws1', [
      { id: 't1', name: 'alpha' },
      { id: 't2', name: 'beta' },
    ]);
    store.writeCardTagLinks('c1', ['t1', 't2']);
    flush();
    expect(store.tagsOfCard('c1').map((t) => t.name)).toEqual(['alpha', 'beta']);
    expect(store.tagsOfCard('unknown')).toEqual([]);

    // Replacing the link set (a snapshot is authoritative per card).
    store.writeCardTagLinks('c1', ['t2']);
    flush();
    expect(store.tagsOfCard('c1').map((t) => t.name)).toEqual(['beta']);

    // The rename: one tag write, the derived card view moves with it.
    store.writeTags('ws1', [{ id: 't2', name: 'renamed' }]);
    flush();
    expect(store.tagsOfCard('c1').map((t) => t.name)).toEqual(['renamed']);
    dispose();
  });

  it('ingestBoardSnapshot extracts tag entities and join rows from chips', () => {
    const { store, dispose } = makeStore();
    store.ingestBoardSnapshot(
      boardSnapshot([
        card('c1', [
          { id: 't1', name: 'alpha' },
          { id: 't2', name: 'beta' },
        ]),
        card('c2', [{ id: 't1', name: 'alpha' }]),
      ]),
    );
    flush();
    expect(store.tagById('t1')?.name).toBe('alpha');
    expect(store.tagsOfCard('c1').map((t) => t.id)).toEqual(['t1', 't2']);
    expect(store.tagsOfCard('c2').map((t) => t.id)).toEqual(['t1']);
    expect(store.tagsOfWorkspace('ws1').map((t) => t.name)).toEqual(['alpha', 'beta']);
    dispose();
  });

  it('ingestWorkspaceDetail rebuilds the vocabulary index', () => {
    const { store, dispose } = makeStore();
    store.writeTags('ws1', [{ id: 't-old', name: 'stale' }]);
    store.ingestWorkspaceDetail(wsDetail([{ id: 't1', name: 'alpha', description: 'a' }]));
    flush();
    expect(store.tagsOfWorkspace('ws1').map((t) => t.name)).toEqual(['alpha']);
    expect(store.tagById('t1')?.description).toBe('a');
    dispose();
  });

  it('clear drops everything (the account-switch path)', () => {
    const { store, dispose } = makeStore();
    store.writeTags('ws1', [{ id: 't1', name: 'alpha' }]);
    store.writeCardTagLinks('c1', ['t1']);
    store.clear();
    flush();
    expect(store.tagById('t1')).toBeUndefined();
    expect(store.tagsOfCard('c1')).toEqual([]);
    expect(store.tagsOfWorkspace('ws1')).toEqual([]);
    dispose();
  });

  it('write-through caches tag rows under their type:id key', async () => {
    const { store, dispose } = makeStore();
    store.writeTags('ws1', [{ id: 't1', name: 'urgent', description: 'asap' }]);
    await settle();
    expect(await cacheGet<TagEntity>('tag:t1')).toEqual({
      id: 't1',
      workspace_id: 'ws1',
      name: 'urgent',
      description: 'asap',
    });
    dispose();
  });

  it('unchanged re-ingests skip the cache write — changed rows still land', async () => {
    const { store, dispose } = makeStore();
    store.writeTags('ws1', [{ id: 't1', name: 'urgent' }]);
    await settle();
    // Age the cached entry past the TTL. If the unchanged re-ingest below
    // rewrote it, the read would be fresh again — that's the
    // discriminator: a skipped write leaves the aged entry to expire.
    await __testAge('tag:t1', 8 * 24 * 60 * 60 * 1000);
    store.writeTags('ws1', [{ id: 't1', name: 'urgent' }]);
    await settle();
    expect(await cacheGet<TagEntity>('tag:t1')).toBeNull();

    // A CHANGED row still write-throughs.
    store.writeTags('ws1', [{ id: 't1', name: 'renamed' }]);
    await settle();
    expect((await cacheGet<TagEntity>('tag:t1'))?.name).toBe('renamed');
    dispose();
  });
});

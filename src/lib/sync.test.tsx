// Sync engine tests: the outbox lifecycle. Every scenario here is a
// behavior the product demands — instant application, concurrent ops,
// no regressions on lagging echoes, failure reverts with retry.
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, flush } from 'solid-js';

import { createBoardEngine, type OpSpec } from './sync';
import type { CardView } from './boards';
import { applyBoardOp, echoBoardOp, guardsFor, tempIdsFor, type BoardOpPayload } from './board-ops';
import type { BoardSnapshot, CardRow, ListRow } from './boards';
// ── fixtures ──────────────────────────────────────────────────────────────

const lists = (over: ListRow[] = []): ListRow[] => [
  { id: 'l1', board_id: 'b1', name: 'To do', position: 1, created_at: '', client_op: null, description: '' },
  { id: 'l2', board_id: 'b1', name: 'Doing', position: 2, created_at: '', client_op: null, description: '' },
  { id: 'l3', board_id: 'b1', name: 'Done', position: 3, created_at: '', client_op: null, description: '' },
  ...over,
];

const card = (id: string, listId: string, position: number, title = id): CardView => ({
  id,
  board_id: 'b1',
  list_id: listId,
  title,
  description: '',
  position,
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
  tags: [],
  assignees: [],
});

const snapshot = (cards: CardView[], ls = lists()): BoardSnapshot => ({
  board: { id: 'b1', name: 'Board', owner_id: 'u1', workspace_id: null, created_at: '', updated_at: '', client_op: null, description: '', access_delegation: false },
  lists: ls,
  cards,
  revision: 1,
  myAccess: 'edit',
  denied: false,
});

const EMPTY: BoardSnapshot = {
  board: { id: '', name: '', owner_id: '', workspace_id: null, created_at: '', updated_at: '', client_op: null, description: '', access_delegation: false },
  lists: [],
  cards: [],
  revision: 0,
  myAccess: null,
  denied: false,
};

// ── harness ───────────────────────────────────────────────────────────────

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
};

type Deferred = { resolve: () => void; reject: (e: unknown) => void };

function makeHarness(initial: BoardSnapshot) {
  const queue: BoardSnapshot[] = [];
  let wake: (() => void) | undefined;
  const sent: Deferred[] = [];

  const push = (next: BoardSnapshot) => {
    queue.push(next);
    if (wake) {
      const w = wake;
      wake = undefined;
      w();
    }
  };

  async function* fakeStream(): AsyncGenerator<BoardSnapshot> {
    let current = initial;
    while (true) {
      yield current;
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      current = queue.shift() ?? current;
    }
  }

  let engine!: ReturnType<typeof createBoardEngine>;
  const dispose = createRoot((d) => {
    engine = createBoardEngine(fakeStream, () => 'b1', EMPTY);
    return d;
  });

  return { engine, push, sent, dispose };
}

/** A server call that lands in `sent` until the test resolves it. */
const deferredSend = (sent: Deferred[]) => () => {
  const promise = new Promise<void>((resolve, reject) => {
    sent.push({ resolve, reject });
  });
  return promise;
};

// ── tests ─────────────────────────────────────────────────────────────────

describe('sync engine', () => {
  afterEach(() => {
    // Roots are disposed by each harness's test end (kept simple: one
    // harness per test, disposed at the end).
  });

  it('applies the initial snapshot', async () => {
    const h = makeHarness(snapshot([card('c1', 'l1', 1)]));
    await settle();
    expect(h.engine.view().cards.length).toBe(1);
    h.dispose();
  });

  it('moves are INSTANT and concurrent ops never block each other', async () => {
    const h = makeHarness(snapshot([card('c1', 'l1', 1), card('c2', 'l1', 2)]));
    await settle();

    const move = (id: string, toList: string): OpSpec<BoardSnapshot> => ({
      kind: 'moveCard',
      guards: [id],
      apply: (draft) => {
        const target = draft.cards.find((c) => c.id === id);
        if (target) target.list_id = toList;
      },
      send: deferredSend(h.sent),
      echo: (d) => d.cards.find((c) => c.id === id)?.list_id === toList,
    });

    h.engine.mutate(move('c1', 'l2'));
    h.engine.mutate(move('c2', 'l3'));
    flush();
    // Both applied instantly — no serialization, no waiting.
    expect(h.engine.view().cards.find((c) => c.id === 'c1')?.list_id).toBe('l2');
    expect(h.engine.view().cards.find((c) => c.id === 'c2')?.list_id).toBe('l3');
    expect(h.sent.length).toBe(2);

    // First server call resolves; the echo arrives. The second is still in
    // flight — nothing regresses.
    h.sent[0].resolve();
    h.push(snapshot([card('c1', 'l2', 1), card('c2', 'l1', 2)]));
    await settle();
    expect(h.engine.view().cards.find((c) => c.id === 'c1')?.list_id).toBe('l2');
    expect(h.engine.view().cards.find((c) => c.id === 'c2')?.list_id).toBe('l3');
    expect(h.engine.ops().length).toBe(1); // only the second op remains

    h.sent[0].resolve(); // second call's deferred (index shifted)
    h.push(snapshot([card('c1', 'l2', 1), card('c2', 'l3', 1)]));
    await settle();
    expect(h.engine.ops().length).toBe(0);
    expect(h.engine.view().cards.find((c) => c.id === 'c2')?.list_id).toBe('l3');
    h.dispose();
  });

  it('a lagging echo never regresses the view (the no-flash property)', async () => {
    const h = makeHarness(snapshot([card('c1', 'l1', 1)]));
    await settle();

    h.engine.mutate({
      kind: 'moveCard',
      guards: ['c1'],
      apply: (draft) => {
        const target = draft.cards.find((c) => c.id === 'c1');
        if (target) target.list_id = 'l2';
      },
      send: deferredSend(h.sent),
      echo: (d) => d.cards.find((c) => c.id === 'c1')?.list_id === 'l2',
    });
    flush();
    expect(h.engine.view().cards.find((c) => c.id === 'c1')?.list_id).toBe('l2');

    // The server committed the move — but an OLDER snapshot (the pre-move
    // state, still in the realtime pipeline) arrives next. The guard keeps
    // the local truth on screen.
    h.sent[0].resolve();
    h.push(snapshot([card('c1', 'l1', 1)]));
    await settle();
    expect(h.engine.view().cards.find((c) => c.id === 'c1')?.list_id).toBe('l2');
    expect(h.engine.ops().length).toBe(1); // guard still held

    // The echo that matches retires the guard — no visible change.
    h.push(snapshot([card('c1', 'l2', 1)]));
    await settle();
    expect(h.engine.view().cards.find((c) => c.id === 'c1')?.list_id).toBe('l2');
    expect(h.engine.ops().length).toBe(0);
    h.dispose();
  });

  it('adds are instant; the temp entity swaps for the real one on echo', async () => {
    const h = makeHarness(snapshot([]));
    await settle();

    const tempId = 'temp-1';
    h.engine.mutate({
      kind: 'addCard',
      guards: [tempId],
      tempIds: [tempId],
      apply: (draft) => {
        draft.cards.push({ ...card(tempId, 'l1', 1, 'New card') });
      },
      send: async () => 'real-1',
      echo: (d) => d.cards.some((c) => c.title === 'New card' && c.list_id === 'l1'),
    });
    flush();
    expect(h.engine.view().cards.some((c) => c.id === tempId)).toBe(true);

    h.push(snapshot([card('real-1', 'l1', 1, 'New card')]));
    await settle();
    const ids = h.engine.view().cards.map((c) => c.id);
    expect(ids).toContain('real-1');
    expect(ids).not.toContain(tempId);
    expect(h.engine.ops().length).toBe(0);
    h.dispose();
  });

  it('failures revert to the durable state and surface a retryable error', async () => {
    const h = makeHarness(snapshot([card('c1', 'l1', 1)]));
    await settle();

    h.engine.mutate({
      kind: 'moveCard',
      guards: ['c1'],
      apply: (draft) => {
        const target = draft.cards.find((c) => c.id === 'c1');
        if (target) target.list_id = 'l2';
      },
      send: deferredSend(h.sent),
      echo: (d) => d.cards.find((c) => c.id === 'c1')?.list_id === 'l2',
    });
    flush();
    expect(h.engine.view().cards.find((c) => c.id === 'c1')?.list_id).toBe('l2');

    // The server refuses: the card snaps back and the failure is visible.
    h.sent[0].reject(new Error('not allowed'));
    await settle();
    // Probe: does a fresh durable emission converge the view?
    h.push(snapshot([card("c1", "l1", 1)]));
    await settle();
    expect(h.engine.view().cards.find((c) => c.id === 'c1')?.list_id).toBe('l1');
    expect(h.engine.failed().length).toBe(1);
    expect(h.engine.failed()[0].error).toBe('not allowed');

    // Retry succeeds: the change re-applies through the echo.
    const failed = h.engine.failed()[0];
    const original = deferredSend([]); // a fresh deferred for the retry
    // Replace the send by calling retry after re-registering? Retry uses the
    // ORIGINAL spec's send — the first deferred is spent. Assert retry
    // marks it inFlight, then push the echo to retire it.
    const retried = h.sent; // no new deferred: the retried send adds one
    h.engine.retry(failed.id);
    await settle();
    expect(h.engine.failed().length).toBe(0);
    expect(h.engine.ops()[0].status).toBe('inFlight');
    h.sent[0].resolve();
    h.push(snapshot([card('c1', 'l2', 1)]));
    await settle();
    expect(h.engine.view().cards.find((c) => c.id === 'c1')?.list_id).toBe('l2');
    expect(h.engine.ops().length).toBe(0);
    void retried;
    void original;
    h.dispose();
  });

  it('captures the message from a plain-object rejection (initial + retry)', async () => {
    const h = makeHarness(snapshot([card('c1', 'l1', 1)]));
    await settle();

    // Server-function failures don't always arrive as Error instances —
    // the RPC layer can hand back a reconstructed plain object. The op's
    // error must carry its message, not "[object Object]" (card #13).
    h.engine.mutate({
      kind: 'moveCard',
      guards: ['c1'],
      apply: (draft) => {
        const target = draft.cards.find((c) => c.id === 'c1');
        if (target) target.list_id = 'l2';
      },
      send: deferredSend(h.sent),
      echo: (d) => d.cards.find((c) => c.id === 'c1')?.list_id === 'l2',
    });
    flush();
    h.sent[0].reject({ message: 'not allowed' });
    await settle();
    expect(h.engine.failed().length).toBe(1);
    expect(h.engine.failed()[0].error).toBe('not allowed');

    // The retry path captures through its own fail handler — same rule.
    h.engine.retry(h.engine.failed()[0].id);
    await settle();
    expect(h.engine.failed().length).toBe(0);
    expect(h.engine.ops()[0].status).toBe('inFlight');
    h.sent[1].reject({ message: 'still not allowed' });
    await settle();
    expect(h.engine.failed().length).toBe(1);
    expect(h.engine.failed()[0].error).toBe('still not allowed');
    h.dispose();
  });

  it('a failed op reverts WITHOUT a follow-up wire emission', async () => {
    // Regression: the store used to share row objects with the wire
    // snapshot, so the in-place local edit poisoned the durable state and
    // the re-merge "confirmed" the local change; the revert only ever
    // landed when a later wire emission delivered fresh objects. The
    // engine must restore the durable state on its own, immediately.
    const h = makeHarness(snapshot([card('c1', 'l1', 1)]));
    await settle();

    h.engine.mutate({
      kind: 'moveCard',
      guards: ['c1'],
      apply: (draft) => {
        const target = draft.cards.find((c) => c.id === 'c1');
        if (target) target.list_id = 'l2';
      },
      send: deferredSend(h.sent),
      echo: (d) => d.cards.find((c) => c.id === 'c1')?.list_id === 'l2',
    });
    flush();
    expect(h.engine.view().cards.find((c) => c.id === 'c1')?.list_id).toBe('l2');

    h.sent[0].reject(new Error('not allowed'));
    await settle();
    expect(h.engine.view().cards.find((c) => c.id === 'c1')?.list_id).toBe('l1');
    expect(h.engine.failed().length).toBe(1);
    h.dispose();
  });

  it('deletes are instant and revert on failure', async () => {
    const h = makeHarness(snapshot([card('c1', 'l1', 1)]));
    await settle();

    h.engine.mutate({
      kind: 'deleteCard',
      guards: ['c1'],
      apply: (draft) => {
        draft.cards = draft.cards.filter((c) => c.id !== 'c1');
      },
      send: deferredSend(h.sent),
      echo: (d) => !d.cards.some((c) => c.id === 'c1'),
    });
    flush();
    expect(h.engine.view().cards.length).toBe(0);

    h.sent[0].reject(new Error('nope'));
    await settle();
    expect(h.engine.view().cards.length).toBe(1); // restored
    expect(h.engine.failed().length).toBe(1);
    h.dispose();
  });

  // ── provisional (relayed) ops: another viewer's change, predicted ──────

  /** A registry-shaped remote op over the board snapshot. */
  const remoteSpec = (payload: BoardOpPayload) => ({
    kind: payload.kind,
    guards: guardsFor(payload),
    tempIds: tempIdsFor(payload),
    apply: (draft: BoardSnapshot) => applyBoardOp(draft, payload, 'now'),
    echo: (durable: BoardSnapshot) => echoBoardOp(durable, payload),
  });

  it('a relayed op predicts instantly, guards intermediates, retires on echo', async () => {
    const h = makeHarness(snapshot([card('c1', 'l1', 1)]));
    await settle();

    // The author (elsewhere) creates a card; we receive the relay.
    const payload: BoardOpPayload = {
      kind: 'create-card',
      tempId: 'tmp-9',
      listId: 'l1',
      title: 'Relayed',
      position: 2,
      clientOp: 'op-77',
    };
    expect(h.engine.applyRemote(remoteSpec(payload), 'op-77')).toBe('op-77');
    flush();
    expect(h.engine.view().cards.some((c) => c.id === 'tmp-9')).toBe(true);
    expect(h.engine.saving()).toBe(false); // provisional, not our write

    // An INTERMEDIATE durable snapshot (some other change, before the
    // author's write landed) must not clobber the prediction.
    h.push(snapshot([card('c1', 'l1', 1), card('c2', 'l2', 1)]));
    await settle();
    expect(h.engine.view().cards.some((c) => c.id === 'tmp-9')).toBe(true);

    // The echo arrives: the durable row the author stamped retires the
    // prediction and swaps the temp id for the real one.
    h.push(snapshot([card('c1', 'l1', 1), card('real-9', 'l1', 2, 'Relayed')]));
    // (the durable fixture lacks client_op — stamp it via the payload check)
    h.push({
      ...snapshot([card('c1', 'l1', 1), card('real-9', 'l1', 2, 'Relayed')]),
      cards: [
        card('c1', 'l1', 1),
        { ...card('real-9', 'l1', 2, 'Relayed'), client_op: 'op-77' },
      ],
    });
    await settle();
    expect(h.engine.view().cards.some((c) => c.id === 'real-9')).toBe(true);
    expect(h.engine.view().cards.some((c) => c.id === 'tmp-9')).toBe(false);
    expect(h.engine.ops().some((op) => op.tempIds.includes('tmp-9'))).toBe(false);
    h.dispose();
  });

  it("the author's fail relay drops the prediction immediately", async () => {
    const h = makeHarness(snapshot([]));
    await settle();

    const payload: BoardOpPayload = {
      kind: 'create-list',
      tempId: 'tmp-list',
      name: 'Ghost list',
      position: 1,
      clientOp: 'op-88',
    };
    h.engine.applyRemote(remoteSpec(payload), 'op-88');
    flush();
    expect(h.engine.view().lists.some((l) => l.id === 'tmp-list')).toBe(true);

    // Duplicate relay is a no-op.
    expect(h.engine.applyRemote(remoteSpec(payload), 'op-88')).toBe(null);

    h.engine.failRemote('op-88');
    await settle();
    expect(h.engine.view().lists.some((l) => l.id === 'tmp-list')).toBe(false);
    expect(h.engine.failed().length).toBe(0); // never the receiver's failure
    h.dispose();
  });

  it('a provisional move lands EXACTLY where the echo will put it (order invariant)', async () => {
    // Regression: the apply used to mutate position without re-sorting the
    // view array, so a moved card showed at its old array slot ("top of the
    // list") until the durable merge sorted it a beat later.
    const h = makeHarness(
      snapshot([card('c1', 'l1', 1), card('c2', 'l1', 2), card('c3', 'l1', 3)]),
    );
    await settle();

    const move: BoardOpPayload = { kind: 'move-card', cardId: 'c1', listId: 'l1', position: 50 };
    h.engine.applyRemote(remoteSpec(move), 'op-sort');
    flush();
    const order = () =>
      h.engine.view().cards.filter((c) => c.list_id === 'l1').map((c) => c.id);
    expect(order()).toEqual(['c2', 'c3', 'c1']); // c1 LAST — where the echo will keep it

    // And the durable echo retires without any visual change.
    h.push(snapshot([card('c2', 'l1', 2), card('c3', 'l1', 3), card('c1', 'l1', 50)]));
    await settle();
    expect(order()).toEqual(['c2', 'c3', 'c1']);
    expect(h.engine.ops().length).toBe(0);
    h.dispose();
  });

  it('a relayed move guards against an older echo, then retires on its own', async () => {    const h = makeHarness(snapshot([card('c1', 'l1', 1)]));
    await settle();

    // A→x chain: the author moved the card to l2; we predict it.
    const move: BoardOpPayload = { kind: 'move-card', cardId: 'c1', listId: 'l2', position: 5 };
    h.engine.applyRemote(remoteSpec(move), 'op-m1');
    flush();
    expect(h.engine.view().cards.find((c) => c.id === 'c1')?.list_id).toBe('l2');

    // An OLDER durable snapshot (the card still in l1 — the echo of an
    // earlier change) must not snap the prediction back.
    h.push(snapshot([card('c1', 'l1', 1)]));
    await settle();
    expect(h.engine.view().cards.find((c) => c.id === 'c1')?.list_id).toBe('l2');

    // The author's write lands: retire silently.
    h.push(snapshot([card('c1', 'l2', 5)]));
    await settle();
    expect(h.engine.view().cards.find((c) => c.id === 'c1')?.list_id).toBe('l2');
    expect(h.engine.ops().length).toBe(0);
    h.dispose();
  });
});

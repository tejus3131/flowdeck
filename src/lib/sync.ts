// The Flowdeck sync engine — the outbox pattern the realtime-collaboration
// products use (Figma's local-first write path; the classic pending-queue
// reconciliation lifecycle), adapted to Solid 2's live sources.
//
// Rules of the engine:
//   1. A user action applies to the local view IMMEDIATELY. Nothing — not
//      the server, not a pending echo, not another action — blocks it.
//   2. Every applied op guards the entities it touched: while an op is in
//      flight, incoming server snapshots do not overwrite those entities
//      (local-wins-until-echo), so echoes that lag a commit never flash.
//   3. The server call's resolution is the ACK. On ACK the guard holds
//      until the live stream ECHOES the change (the echo retires it,
//      swapping temp entities for real ids). On failure — or timeout — the
//      op is marked failed and the view is re-merged without its guard,
//      which restores the durable state; a retryable error is surfaced.
//   4. Ops are independent: different entities mutate concurrently; the
//      same entity is last-write-wins locally, server-wins on echo.
//
// Solid 2 discipline this file follows (learned the hard way):
//   * Reads lag writes — the engine never reads a store right after
//     writing it; retirement decisions are made from data read BEFORE any
//     write, and re-merges use explicit guard-release sets.
//   * The view store is written ONLY from reactive effect contexts (the
//     merge paths below); async continuations (server ACK/NACK) touch the
//     ops store and signals, then request a merge through a signal.
//   * Store setters take draft functions (no path setters).
import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  type Accessor,
} from 'solid-js';

import type { BoardSnapshot, CardRow, ListRow } from './boards';

export type SyncStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface PendingOp {
  id: string;
  kind: string;
  /** Entities this op guards: snapshots won't overwrite them while in flight. */
  guards: string[];
  /** Entities created locally, replaced by real ids when the echo lands. */
  tempIds: string[];
  status: 'inFlight' | 'failed';
  error?: string;
  at: number;
}

export interface OpSpec {
  kind: string;
  guards?: string[];
  tempIds?: string[];
  /** Apply the op to the local view draft. Runs synchronously on mutate. */
  apply: (draft: BoardSnapshot) => void;
  /** The server call — its resolution is the ACK. */
  send: () => Promise<unknown>;
  /** True when the durable snapshot contains this op's change. */
  echo: (durable: BoardSnapshot) => boolean;
}

/** Guard id for the board's own row (name etc.). */
export const BOARD_ENTITY = 'board';

const ACK_TIMEOUT_MS = 10_000;

export function createBoardEngine(
  streamSource: (boardId: string) => AsyncIterable<BoardSnapshot>,
  boardId: Accessor<string>,
  empty: BoardSnapshot,
) {
  // ── durable source + transport status ─────────────────────────────────
  const [status, setStatus] = createSignal<SyncStatus>('connecting');

  // View writes land only inside a durable-emission pass (Solid 2's async
  // write scoping), so the engine wraps the source in a replayable
  // generator: releasing guards (failures, dismissals, sweeps) requests a
  // re-emission of the CURRENT snapshot, and the merge that follows runs
  // in the proven in-flight context.
  let replayQueued = false;
  let replayResolve: (() => void) | undefined;
  const requestReplay = () => {
    replayQueued = true;
    replayResolve?.();
  };

  async function* replayable(): AsyncGenerator<BoardSnapshot> {
    const source = streamSource(boardId());
    (source as { onstatus?: (next: string) => void }).onstatus = (next: string) => {
      if (next === 'connected') setStatus('live');
      else if (next === 'reconnecting') setStatus('reconnecting');
      else if (next === 'closed') setStatus('offline');
    };
    const iterator = source[Symbol.asyncIterator]();
    let current: BoardSnapshot | undefined;
    let pendingNext: Promise<IteratorResult<BoardSnapshot>> | undefined;
    const nextValue = () => (pendingNext ??= iterator.next());
    while (true) {
      const gate = new Promise<void>((resolve) => {
        replayResolve = resolve;
      });
      const winner = await Promise.race([
        nextValue().then((result) => ({ result })),
        gate.then(() => undefined),
      ]);
      replayResolve = undefined;
      if (winner === undefined) {
        // A replay request: re-emit the current snapshot (fresh identity)
        // so the merge pass runs.
        replayQueued = false;
        if (current) {
          yield {
            ...current,
            lists: current.lists.slice(),
            cards: current.cards.slice(),
          };
        }
        continue;
      }
      pendingNext = undefined;
      if (winner.result.done) return;
      current = winner.result.value;
      yield current;
      if (replayQueued) {
        replayQueued = false;
        yield {
          ...current,
          lists: current.lists.slice(),
          cards: current.cards.slice(),
        };
      }
    }
  }

  const stream = createMemo(() => replayable(), { loadingValue: empty });
  const durable = createMemo<BoardSnapshot>(() => stream());

  // ── state ────────────────────────────────────────────────────────────
  const [view, setView] = createStore<BoardSnapshot>(empty);
  const [ops, setOps] = createStore<{ list: PendingOp[] }>({ list: [] });
  // Async continuations request a re-merge through this signal, carrying
  // the guard set to release (reads lag writes, so a re-merge can never
  // re-read the ops store to learn which guards just dropped); the merge
  // itself always runs in the effect below — the context where view writes
  // reliably land.

  let lastDurable: BoardSnapshot = empty;
  const specs = new Map<string, OpSpec>();

  /** Entities protected right now (read before any write in the same pass). */
  const keepSet = () => {
    const keep = new Set<string>();
    for (const op of ops.list) {
      if (op.status !== 'inFlight') continue;
      for (const id of op.guards) keep.add(id);
      for (const id of op.tempIds) keep.add(id);
    }
    return keep;
  };

  /** Merge the durable snapshot into the view. `release` un-guards entities
   *  (retired or failed ops) so the server's state wins for them again. */
  function merge(snapshot: BoardSnapshot, release?: ReadonlySet<string>) {
    lastDurable = snapshot;
    const keep = keepSet();
    if (release) for (const id of release) keep.delete(id);
    setView((draft) => {
      const lists = mergeRows(draft.lists, snapshot.lists, keep).sort(
        (a, b) => a.position - b.position,
      );
      const listIndex = new Map(lists.map((list, index) => [list.id, index]));
      const cards = mergeRows(draft.cards, snapshot.cards, keep).sort(
        (a, b) =>
          (listIndex.get(a.list_id) ?? 0) - (listIndex.get(b.list_id) ?? 0) ||
          a.position - b.position,
      );
      draft.board = keep.has(BOARD_ENTITY) ? draft.board : snapshot.board;
      draft.lists = lists;
      draft.cards = cards;
      draft.revision = snapshot.revision;
    });
  }

  function mergeRows<T extends { id: string }>(local: T[], server: T[], keep: Set<string>): T[] {
    const kept = local.filter((row) => keep.has(row.id));
    const keptIds = new Set(kept.map((row) => row.id));
    return [...server.filter((row) => !keptIds.has(row.id)), ...kept];
  }

  // THE merge driver: every view write happens here, inside a durable
  // emission pass. Retirements are decided from data read BEFORE any
  // write (reads lag writes), then applied with the merge in one pass.
  createEffect(() => durable(), (snapshot) => {
    const retiring = new Set<string>();
    for (const op of [...ops.list]) {
      const spec = specs.get(op.id);
      if (op.status === 'inFlight' && spec?.echo(snapshot)) {
        for (const id of [...op.guards, ...op.tempIds]) retiring.add(id);
      }
    }
    applyWithRetire(snapshot, retiring);
  });

  /** Shared retire + merge pass (writes ops first, then merges once). */
  function applyWithRetire(snapshot: BoardSnapshot, retiring: ReadonlySet<string>) {
    if (retiring.size > 0) {
      setOps((draft) => {
        for (const op of [...draft.list]) {
          const spec = specs.get(op.id);
          const done = op.status === 'inFlight' && (spec?.echo(snapshot) ?? false);
          if (done) {
            const index = draft.list.indexOf(op);
            if (index >= 0) draft.list.splice(index, 1);
          }
        }
      });
    }
    merge(snapshot, retiring);
  }

  // ── mutation entry point ──────────────────────────────────────────────
  function mutate(spec: OpSpec): string {
    const id = crypto.randomUUID();
    specs.set(id, spec);
    // 1. Instant local apply — nothing waits on this.
    setView((draft) => {
      spec.apply(draft);
    });
    // 2. Queue with guards.
    setOps((draft) => {
      draft.list.push({
        id,
        kind: spec.kind,
        guards: spec.guards ?? [],
        tempIds: spec.tempIds ?? [],
        status: 'inFlight',
        at: Date.now(),
      });
    });

    // 3. Fire — ACK/timeout handling, never blocking the caller.
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      const message = error instanceof Error ? error.message : String(error);
      // Mark failed (guards drop via status) and re-merge: the durable
      // state wins again for this op's entities — that IS the revert.
      setOps((draft) => {
        const op = draft.list.find((entry) => entry.id === id);
        if (op && op.status === 'inFlight') {
          op.status = 'failed';
          op.error = message;
        }
      });
      requestReplay();
    };

    const timeout = setTimeout(() => fail(new Error('Timed out')), ACK_TIMEOUT_MS);
    spec.send().then(
      () => {
        settled = true;
        clearTimeout(timeout);
        // ACK: the guard holds only until the echo retires it; the sweep
        // makes sure a lost echo can't wedge the view behind a stale guard.
        setTimeout(() => sweep(), ACK_TIMEOUT_MS);
      },
      (error: unknown) => fail(error),
    );
    return id;
  }

  /** Retire in-flight ops whose echo landed outside a snapshot pass, and
   *  flag guards that have been stuck far too long. */
  function sweep() {
    const current = [...ops.list];
    const retiring: string[] = [];
    const stale: string[] = [];
    for (const op of current) {
      if (op.status !== 'inFlight') continue;
      const spec = specs.get(op.id);
      if (spec?.echo(lastDurable)) {
        retiring.push(...op.guards, ...op.tempIds);
      } else if (Date.now() - op.at > ACK_TIMEOUT_MS * 4) {
        stale.push(op.id);
      }
    }
    if (retiring.length > 0 || stale.length > 0) {
      if (retiring.length > 0) {
        setOps((draft) => {
          for (const op of [...draft.list]) {
            const spec = specs.get(op.id);
            if (op.status === 'inFlight' && spec?.echo(lastDurable)) {
              const index = draft.list.indexOf(op);
              if (index >= 0) draft.list.splice(index, 1);
            }
          }
        });
      }
      if (stale.length > 0) {
        setOps((draft) => {
          for (const entry of draft.list) {
            if (stale.includes(entry.id) && entry.status === 'inFlight') {
              entry.status = 'failed';
            }
          }
        });
      }
      // The view converges on the next emission pass (guards are gone).
      requestReplay();
    }
  }

  /** Retry a failed op's server call (the local change is still applied —
   *  a successful echo retires it through the normal merge path). */
  function retry(opId: string) {
    const spec = specs.get(opId);
    if (!spec) return;
    const full = specs.get(opId) as OpSpec | undefined;
    setOps((draft) => {
      const op = draft.list.find((entry) => entry.id === opId);
      if (op) {
        op.status = 'inFlight';
        op.error = undefined;
        op.at = Date.now();
      }
    });
    if (full) {
      // The revert undid the local change on failure — re-apply it.
      setView((draft) => {
        full.apply(draft);
      });
    }
    spec.send().then(
      () => setTimeout(() => sweep(), 200),
      (error: unknown) => {
        setOps((draft) => {
          const op = draft.list.find((entry) => entry.id === opId);
          if (op) {
            op.status = 'failed';
            op.error = error instanceof Error ? error.message : String(error);
          }
        });
        // The failed retry reverts on the next emission pass: the op is
        // failed again, so its guards no longer shadow the server.
        requestReplay();
      },
    );
  }

  /** Dismiss a failed op (its revert already ran). */
  function dismiss(opId: string) {
    const spec = specs.get(opId);
    setOps((draft) => {
      const index = draft.list.findIndex((entry) => entry.id === opId);
      if (index >= 0) draft.list.splice(index, 1);
    });
    specs.delete(opId);
    requestReplay();
  }

  return {
    view: () => view,
    status,
    ops: () => ops.list,
    failed: () => ops.list.filter((op) => op.status === 'failed'),
    mutate,
    retry,
    dismiss,
    isSaving: (entityId: string) =>
      ops.list.some((op) => op.status === 'inFlight' && op.guards.includes(entityId)),
  };
}

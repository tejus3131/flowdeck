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
  onSettled,
  type Accessor,
} from 'solid-js';
import { getRequestEvent, isServer } from '@solidjs/web';

import type { BoardSnapshot } from './boards';
import { errorMessage } from './error-message';

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
  /**
   * A PROVISIONAL op relayed from another viewer (never sent by this
   * client): its write lives on the author's machine. Guards and echo
   * retirement run identically to local ops; there is no ACK path, no
   * retry, and no failure toast — a dropped provisional silently reverts
   * to the durable state (TTL sweep, or the author's fail relay).
   */
  remote?: boolean;
}

export interface OpSpec<S = unknown> {
  kind: string;
  guards?: string[];
  tempIds?: string[];
  /** Apply the op to the local view draft. Runs synchronously on mutate. */
  apply: (draft: S) => void;
  /** The server call — its resolution is the ACK. Absent for a
   *  provisional (relayed) op: the write lives on the author's machine. */
  send?: () => Promise<unknown>;
  /** True when the durable snapshot contains this op's change. */
  echo: (durable: S) => boolean;
}

/** Guard id for the board's own row (name etc.). */
export const BOARD_ENTITY = 'board';
/** Guard id for this viewer's effective access on the open board — an
 *  access-change op holds it provisionally until the durable echo flips
 *  the snapshot's value (the viewer↔editor switch). */
export const ACCESS_ENTITY = 'my-access';

/**
 * True during a DOCUMENT render on the server (SSR). The live-wire
 * producers also run server-side — for them this is false, so they keep
 * streaming; only the document render needs "first value, then finish".
 */
export function isDocumentRender(): boolean {
  if (!isServer) return false;
  const url = getRequestEvent()?.request.url ?? '';
  return !url.includes('/_server/');
}

const ACK_TIMEOUT_MS = 10_000;
/** How long after an ACK to wait for the live echo before refreshing. */
const ECHO_GRACE_MS = 2_500;
/** Client-side durable poll interval — realtime's silent-death fallback. */
const POLL_MS = 20_000;
/** Sweep cadence — retire missed echoes, expire provisional TTLs. */
const SWEEP_MS = 5_000; /**
 * A provisional (relayed) op whose echo never lands — the author's write
 * failed silently or their client vanished. The prediction reverts to the
 * durable state after this long; the author's own outbox surfaces the
 * failure to THEM immediately.
 */
const REMOTE_TTL_MS = 15_000;

export type Engine<S> = {
  view: () => S;
  status: () => SyncStatus;
  ops: () => PendingOp[];
  /** LOCAL failures only — remote provisionals never surface. */
  failed: () => PendingOp[];
  /** Local in-flight ops only (the "Syncing" pill ignores provisionals). */
  saving: () => boolean;
  mutate: (spec: OpSpec<S>) => string;
  /**
   * Apply another viewer's op as a PROVISIONAL prediction: same instant
   * apply and guards as a local op, retirement when the durable echo
   * contains its effect, silent revert when the author reports failure
   * (failRemote) or the prediction goes stale (no write ever lands).
   * Returns the op id, or null when an op id is already applied.
   */
  applyRemote: (spec: OpSpec<S>, opId: string) => string | null;
  /** The author's write failed: drop that provisional and revert. */
  failRemote: (opId: string) => void;
  retry: (opId: string) => void;
  dismiss: (opId: string) => void;
  isSaving: (entityId: string) => boolean;
  /** A locally created entity whose real id hasn't been echoed yet. */
  isTemp: (entityId: string) => boolean;
  /** Best-effort durable re-fetch, fed through the same merge path as
   *  the live stream — a no-op when the engine has no refresh source.
   *  Lets a page heal a stale cached snapshot on demand instead of
   *  waiting for the poll (or the next realtime emission). */
  refresh: () => Promise<void>;
};

/**
 * The generic outbox engine over any snapshot shape: instant local apply,
 * guard-based local-wins-until-echo, replay-based guard release. The board
 * page and the dashboard's board list run this same machinery.
 */
export function createEngine<S extends object>(options: {
  streamSource: (key: string) => AsyncIterable<S>;
  key: Accessor<string>;
  empty: S;
  /** Fold the durable snapshot into the view. `keep` = entities to protect. */
  merge: (draft: S, snapshot: S, keep: ReadonlySet<string>) => void;
  /** Fresh-identity copy of a snapshot (replay passes need one). */
  clone: (snapshot: S) => S;
  /** Optional reactive wire state (a liveQuery's `status()`), mapped onto
   *  the engine's status words. Absent → the source's onstatus hook. */
  status?: () => string;
  /**
   * Best-effort durable re-fetch. Feeds a fresh snapshot through the same
   * merge path as the live stream: retires ACK'd ops whose echo was lost,
   * and keeps the view converging even when realtime is silently dead
   * (the poll below) — realtime outages degrade to polling, never to
   * "stuck on Syncing".
   */
  refresh?: () => Promise<S>;
}): Engine<S> {
  return createEngineBody(
    options.streamSource,
    options.key,
    options.empty,
    options.merge,
    options.clone,
    options.status,
    options.refresh,
  );
}

/** True when both arrays hold the same item identities, same order. */
function sameItems<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Merge two keyed row lists: server rows first, guarded locals appended.
 * Identity-stable: a server row whose content matches the row already in
 * the view keeps the EXISTING object, so `<For>` (keyed by reference)
 * reuses its DOM instead of recreating every row on each emission — the
 * wire delivers fresh objects for unchanged rows too.
 *
 * Snapshot-isolated: a row ENTERING the view is a shallow copy, never the
 * wire's own object. The store would otherwise share row references with
 * the wire snapshot, and an in-place local edit (a card move during its
 * op's flight) would mutate the durable snapshot itself — poisoning every
 * later re-merge into "confirming" the local edit instead of reverting
 * it. Rows are flat DB rows; a spread copies them whole.
 */
function mergeRows<T extends { id: string }>(
  local: T[],
  server: T[],
  keep: ReadonlySet<string>,
): T[] {
  const kept = local.filter((row) => keep.has(row.id));
  const keptIds = new Set(kept.map((row) => row.id));
  const prev = new Map(local.map((row) => [row.id, row]));
  return [
    ...server
      .filter((row) => !keptIds.has(row.id))
      .map((row) => {
        const old = prev.get(row.id);
        return old && JSON.stringify(old) === JSON.stringify(row) ? old : { ...row };
      }),
    ...kept,
  ];
}

/** The board engine: the original snapshot shape + its merge. */
export function createBoardEngine(
  streamSource: (boardId: string) => AsyncIterable<BoardSnapshot>,
  boardId: Accessor<string>,
  empty: BoardSnapshot,
  status?: () => string,
  refresh?: () => Promise<BoardSnapshot>,
): Engine<BoardSnapshot> {
  return createEngine<BoardSnapshot>({
    streamSource,
    key: boardId,
    empty,
    clone: (snapshot) => ({
      ...snapshot,
      lists: snapshot.lists.slice(),
      cards: snapshot.cards.slice(),
    }),
    merge: mergeBoardSnapshot,
    ...(status ? { status } : {}),
    ...(refresh ? { refresh } : {}),
  });
}

/** Fold a durable board snapshot into the view (server state minus guards). */
function mergeBoardSnapshot(
  draft: BoardSnapshot,
  snapshot: BoardSnapshot,
  keep: ReadonlySet<string>,
) {
  const lists = mergeRows(draft.lists, snapshot.lists, keep).sort(
    (a, b) => a.position - b.position,
  );
  const listIndex = new Map(lists.map((list, index) => [list.id, index]));
  const cards = mergeRows(draft.cards, snapshot.cards, keep).sort(
    (a, b) =>
      (listIndex.get(a.list_id) ?? 0) - (listIndex.get(b.list_id) ?? 0) || a.position - b.position,
  );
  draft.board = keep.has(BOARD_ENTITY)
    ? draft.board
    : // Snapshot-isolated AND identity-stable: swap the board row only
      // when its content changed, and always as a copy — an in-place
      // rename during an op's flight must not poison the wire snapshot.
      JSON.stringify(draft.board) === JSON.stringify(snapshot.board)
      ? draft.board
      : { ...snapshot.board };
  if (!sameItems(draft.lists, lists)) draft.lists = lists;
  if (!sameItems(draft.cards, cards)) draft.cards = cards;
  draft.revision = snapshot.revision;
  draft.myAccess = keep.has(ACCESS_ENTITY) ? draft.myAccess : snapshot.myAccess;
  // "No access" is durable truth (RLS hides the row) — but hold it while a
  // provisional access change is pending, exactly like myAccess, so a
  // stale pre-grant snapshot can't bounce a just-granted viewer back.
  draft.denied = keep.has(ACCESS_ENTITY) ? draft.denied : snapshot.denied;
}

function createEngineBody<S extends object>(
  streamSource: (key: string) => AsyncIterable<S>,
  boardId: Accessor<string>,
  empty: S,
  merge: (draft: S, snapshot: S, keep: ReadonlySet<string>) => void,
  clone: (snapshot: S) => S,
  wireStatus?: () => string,
  refresh?: () => Promise<S>,
): Engine<S> {
  // ── durable source + transport status ─────────────────────────────────
  const [statusSignal, setStatus] = createSignal<SyncStatus>('connecting');
  const status = (): SyncStatus => {
    if (wireStatus) {
      const wire = wireStatus();
      if (wire === 'connected') return 'live';
      if (wire === 'reconnecting') return 'reconnecting';
      if (wire === 'closed') return 'offline';
      return 'connecting';
    }
    return statusSignal();
  };

  // View writes land only inside a durable-emission pass (Solid 2's async
  // write scoping), so the engine wraps the source in a replayable
  // generator: releasing guards (failures, dismissals, sweeps) requests a
  // re-emission of the CURRENT snapshot, and the merge that follows runs
  // in the proven in-flight context.
  let replayQueued = false;
  let replayResolve: (() => void) | undefined;

  /** An externally supplied snapshot, waiting to be emitted like a
   *  durable value (refresh feeds, re-merge requests replay it). */
  let external: S | undefined;
  const feed = (snapshot: S) => {
    external = snapshot;
    replayQueued = true;
    replayResolve?.();
  };

  /** Best-effort durable re-fetch → feed. The ACK path uses this to
   *  retire ops whose echo was lost; the poll keeps remote changes
   *  flowing when realtime dies silently. */
  const refreshNow = async () => {
    if (!refresh) return;
    try {
      const snapshot = await refresh();
      feed(snapshot);
    } catch {
      // Best effort — the live stream (or the next poll) will converge.
    }
  };

  async function* replayable(): AsyncGenerator<S> {
    // live() sources arrive through an async wrapper (in-process or over
    // the wire) — the source itself resolves from a promise.
    const source = await streamSource(boardId());
    if (!wireStatus) {
      (source as { onstatus?: (next: string) => void }).onstatus = (next: string) => {
        if (next === 'connected') setStatus('live');
        else if (next === 'reconnecting') setStatus('reconnecting');
        else if (next === 'closed') setStatus('offline');
      };
    }
    const iterator = source[Symbol.asyncIterator]();
    let current: S | undefined;
    let pendingNext: Promise<IteratorResult<S>> | undefined;
    const nextValue = () => (pendingNext ??= iterator.next());
    if (isServer && isDocumentRender()) {
      // The DOCUMENT render only needs the first value: SSR renders it,
      // hydration adopts it, and the client re-connects the channel over
      // its own wire. Pulling further here would hold the response open
      // forever. (Only for document renders — the live-wire producers
      // below also run on the server, and they must keep streaming.)
      const first = await nextValue();
      if (!first.done) yield first.value;
      return;
    }
    while (true) {
      // A fed snapshot (refresh safety net) is emitted exactly like a
      // durable landing — same merge path, same retirement rules.
      if (external !== undefined) {
        const fed = external;
        external = undefined;
        current = fed;
        replayQueued = false;
        yield clone(fed);
        continue;
      }
      const gate = new Promise<void>((resolve) => {
        replayResolve = resolve;
      });
      const winner = await Promise.race([
        nextValue().then((result) => ({ result })),
        gate.then(() => undefined),
      ]);
      replayResolve = undefined;
      if (winner === undefined) {
        // A feed woke the loop: back to the external check above, which
        // emits it. (The replay branch that used to live here — yielding
        // clone(current) directly — silently failed to commit view writes
        // when the gate resolved from an async continuation, e.g. a
        // failed op's revert; the feed branch commits from every
        // context, proven by the refresh poll.)
        continue;
      }
      pendingNext = undefined;
      if (winner.result.done) return;
      current = winner.result.value;
      yield current;
      if (replayQueued) {
        replayQueued = false;
      }
    }
  }

  // Lazy: the source's pull starts on the first read — and that first read
  // is deferred to the settle below. An eager pull races the hydration
  // adoption: the $R write lands while the generator's first value is in
  // flight, the dirty-skip drops that landing (and with it the callback
  // that continues the pull), and the stream silently stops. Starting
  // post-settle means landings hit a clean node — deterministic.
  const stream = createMemo(() => replayable(), { loadingValue: empty, lazy: true });
  const durable = createMemo<S>(() => stream(), { lazy: true });

  // ── state ────────────────────────────────────────────────────────────
  // `as never` — Solid's overload excludes function values (NoFn<T>), and TS
  // can't prove a naked generic `S extends object` is never callable. The
  // public createEngine boundary already constrains S to object. The
  // initial state is cloned: the store shares (and mutates) the object it
  // wraps, so a shared module-level `empty` would leak one engine's rows
  // into the next (stale board flash before the first merge).
  const [view, setView] = createStore<S>(clone(empty) as never);
  const [ops, setOps] = createStore<{ list: PendingOp[] }>({ list: [] });
  // Async continuations request a re-merge through this signal, carrying
  // the guard set to release (reads lag writes, so a re-merge can never
  // re-read the ops store to learn which guards just dropped); the merge
  // itself always runs in the effect below — the context where view writes
  // reliably land.

  let lastDurable: S = empty;
  const specs = new Map<string, OpSpec<S>>();

  /**
   * Re-merge the last durable snapshot under the CURRENT guard set —
   * what failures (revert), dismissals and sweeps need. It feeds the
   * snapshot through the external slot rather than replaying it inline:
   * merges delivered by the feed branch commit from every resumption
   * context (the inline replay branch did not).
   */
  const requestReplay = () => {
    feed(lastDurable);
  };

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

  // THE merge driver: every view write happens here, inside a durable
  // emission pass. Retirements are decided from data read BEFORE any
  // write (reads lag writes), then applied with the merge in one pass.
  //
  // The first pull is gated until the initial settle: an eager pull races
  // the hydration adoption ($R's write lands while the generator's first
  // value is in flight, the dirty-skip drops the landing along with the
  // callback that continues the pull, and the stream silently stops).
  // Reading `durable()` for the first time AFTER the settle means the
  // landings hit a clean node — deterministic on reload and first load.
  const [started, setStarted] = createSignal(false);
  onSettled(() => {
    setStarted(true);
    // Client-only refresh poll: realtime can die silently (a rejected
    // binding, a dropped socket that still reports live) — a slow durable
    // re-fetch keeps remote changes and echo retirements flowing anyway,
    // so the worst case degrades to polling, never to a stuck view.
    if (isServer) return;
    const timers: ReturnType<typeof setInterval>[] = [];
    if (refresh) timers.push(setInterval(() => void refreshNow(), POLL_MS));
    // The sweep also retires/stales ops whose echoes missed the stream —
    // provisional TTLs and stuck local guards need it to ever fire.
    timers.push(setInterval(() => sweep(), SWEEP_MS));
    return () => {
      for (const timer of timers) clearInterval(timer);
    };
  });
  createEffect(
    () => (started() ? durable() : undefined),
    (snapshot) => {
      if (snapshot === undefined) return; // pre-settle: nothing to merge yet
      lastDurable = snapshot; // the sweep retires against the freshest state
      const retiring = new Set<string>();
      for (const op of [...ops.list]) {
        const spec = specs.get(op.id);
        if (op.status === 'inFlight' && spec?.echo(snapshot)) {
          for (const id of [...op.guards, ...op.tempIds]) retiring.add(id);
        }
      }
      applyWithRetire(snapshot, retiring);
    },
  );

  /** Shared retire + merge pass (writes ops first, then merges once). */
  function applyWithRetire(snapshot: S, retiring: ReadonlySet<string>) {
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
    // The guard set is read before any write (reads lag writes); released
    // guards let the durable state win again for those entities.
    const keep = keepSet();
    for (const id of retiring) keep.delete(id);
    setView((draft) => {
      merge(draft, snapshot, keep);
    });
  }

  // ── mutation entry point ──────────────────────────────────────────────
  /** The apply+guards half of mutate, shared with provisional remote ops. */
  function enter(spec: OpSpec<S>, id: string, remote: boolean): void {
    specs.set(id, spec);
    // 1. Instant local apply — nothing waits on this.
    setView((draft) => {
      spec.apply(draft);
    });
    // 2. Queue with guards. An in-flight op on the same entity is
    //    SUPERSEDED: its server call still lands, but the newest intent
    //    owns the guard — sequential drags never wedge on the first one.
    setOps((draft) => {
      const shared = new Set([...(spec.guards ?? []), ...(spec.tempIds ?? [])]);
      const survivors = draft.list.filter(
        (entry) =>
          !(
            entry.status === 'inFlight' &&
            [...entry.guards, ...entry.tempIds].some((id) => shared.has(id))
          ),
      );
      draft.list = survivors;
      survivors.push({
        id,
        kind: spec.kind,
        guards: spec.guards ?? [],
        tempIds: spec.tempIds ?? [],
        status: 'inFlight',
        at: Date.now(),
        ...(remote ? { remote: true } : {}),
      });
    });
  }

  function mutate(spec: OpSpec<S>): string {
    const id = crypto.randomUUID();
    enter(spec, id, false);

    // 3. Fire — ACK/timeout handling, never blocking the caller.
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      const message = errorMessage(error);
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
    const send = spec.send;
    if (!send) return id; // defensive: local ops always carry a send
    send().then(
      () => {
        settled = true;
        clearTimeout(timeout);
        // ACK: the guard holds only until the echo retires it; the sweep
        // makes sure a lost echo can't wedge the view behind a stale guard.
        setTimeout(() => sweep(), ACK_TIMEOUT_MS);
        // Echo safety net: if the live stream doesn't deliver the echo
        // within the grace window (realtime can die silently), fetch the
        // durable snapshot directly and feed it — a landed write retires
        // immediately instead of surfacing a false failure.
        setTimeout(() => void refreshNow(), ECHO_GRACE_MS);
      },
      (error: unknown) => fail(error),
    );
    return id;
  }

  // ── provisional (relayed) ops ─────────────────────────────────────────
  /** Relay ids seen recently — a broadcast can be re-delivered. */
  const seenRemote: string[] = [];
  const seenRemoteSet = new Set<string>();
  const rememberRemote = (id: string) => {
    seenRemote.push(id);
    seenRemoteSet.add(id);
    if (seenRemote.length > 512) seenRemoteSet.delete(seenRemote.shift() as string);
  };

  function applyRemote(spec: OpSpec<S>, opId: string): string | null {
    if (seenRemoteSet.has(opId)) return null; // duplicate relay
    rememberRemote(opId);
    enter(spec, opId, true);
    // No send, no ACK, no timeout: the AUTHOR owns the write and its
    // failure handling. Retirement is the echo; the TTL sweep below is
    // the safety net for an author that vanished mid-write.
    return opId;
  }

  function failRemote(opId: string): void {
    setOps((draft) => {
      const index = draft.list.findIndex((entry) => entry.id === opId);
      if (index >= 0 && draft.list[index].remote && draft.list[index].status === 'inFlight') {
        draft.list.splice(index, 1);
      }
    });
    specs.delete(opId);
    // The prediction reverts on the next emission pass (guards released).
    requestReplay();
  }

  /** Retire in-flight ops whose echo landed outside a snapshot pass, and
   *  flag guards that have been stuck far too long. Provisional (relayed)
   *  ops that never echo are dropped SILENTLY at their TTL — the author
   *  owns the failure; receivers just fall back to the durable state. */
  function sweep() {
    const current = [...ops.list];
    const retiring: string[] = [];
    const stale: string[] = [];
    const expiredRemote: string[] = [];
    for (const op of current) {
      if (op.status !== 'inFlight') continue;
      const spec = specs.get(op.id);
      if (spec?.echo(lastDurable)) {
        retiring.push(...op.guards, ...op.tempIds);
      } else if (op.remote) {
        if (Date.now() - op.at > REMOTE_TTL_MS) expiredRemote.push(op.id);
      } else if (Date.now() - op.at > ACK_TIMEOUT_MS * 4) {
        stale.push(op.id);
      }
    }
    if (retiring.length > 0 || stale.length > 0 || expiredRemote.length > 0) {
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
      if (expiredRemote.length > 0) {
        setOps((draft) => {
          draft.list = draft.list.filter(
            (entry) =>
              !(entry.remote && expiredRemote.includes(entry.id) && entry.status === 'inFlight'),
          );
        });
        for (const id of expiredRemote) specs.delete(id);
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
    if (!spec.send) return; // provisional relay — nothing to re-send here
    setOps((draft) => {
      const op = draft.list.find((entry) => entry.id === opId);
      if (op) {
        op.status = 'inFlight';
        op.error = undefined;
        op.at = Date.now();
      }
    });
    if (spec) {
      // The revert undid the local change on failure — re-apply it.
      setView((draft) => {
        spec.apply(draft);
      });
    }
    spec.send().then(
      () => setTimeout(() => sweep(), 200),
      (error: unknown) => {
        setOps((draft) => {
          const op = draft.list.find((entry) => entry.id === opId);
          if (op) {
            op.status = 'failed';
            op.error = errorMessage(error);
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
    failed: () => ops.list.filter((op) => op.status === 'failed' && !op.remote),
    saving: () => ops.list.some((op) => op.status === 'inFlight' && !op.remote),
    mutate,
    applyRemote,
    failRemote,
    retry,
    dismiss,
    refresh: refreshNow,
    isSaving: (entityId: string) =>
      ops.list.some((op) => op.status === 'inFlight' && !op.remote && op.guards.includes(entityId)),
    /** A locally created entity whose real id hasn't been echoed yet —
     *  local or provisional (the shimmer marks not-yet-durable rows). */
    isTemp: (entityId: string) =>
      ops.list.some((op) => op.status === 'inFlight' && op.tempIds.includes(entityId)),
  };
}

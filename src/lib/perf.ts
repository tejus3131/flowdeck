// Perf marks — the "profile it" half of board card #45.
//
// What a user feels as "slow" is the time from OPENING something (a board,
// a chat panel, a card drawer, the timeline) to SEEING its data. These
// marks wrap exactly those paths: a start mark at the open, an end mark at
// the first value (or the fetch's return). The result is a per-label
// p50/p95 the debug panel (?perf=1) tables up.
//
// Design points:
//   * Always on. Recording is a couple of array writes — the panel is just
//     a window onto the buffer, so a user who hits slowness and THEN turns
//     on ?perf=1 still sees history from this page load.
//   * Capped per label (100 samples) — the buffer can never grow without
//     bound.
//   * Server-side renders skip recording (isServer guard): the marks are
//     about what the BROWSER waits for.
//
// Adding a new open path? It gets a mark here with a budget in
// docs/performance.md — rule 5 of docs/performance-rules.md.
import { createSignal, type Accessor } from 'solid-js';
import { isServer } from '@solidjs/web';

/** Samples kept per label — a sliding window, oldest evicted. */
const MAX_PER_LABEL = 100;

const samples = new Map<string, number[]>();
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** The telemetry sink's mark tap: one call per recorded sample. Set by
 *  lib/telemetry.ts on the client (minute buckets → page_open/panel_open
 *  counters); null in dev, SSR, and tests. */
export type PerfSink = (label: string, duration: number, at: number) => void;
let sink: PerfSink | null = null;
export function setPerfSink(next: PerfSink | null): void {
  sink = next;
}

function record(label: string, duration: number): void {
  let list = samples.get(label);
  if (!list) {
    list = [];
    samples.set(label, list);
  }
  list.push(duration);
  if (list.length > MAX_PER_LABEL) list.shift();
  if (sink) {
    try {
      sink(label, duration, Date.now());
    } catch {
      // Telemetry must never take an open path down with it.
    }
  }
}

/** Ownership token for an open mark — only its holder's end records. */
export type MarkToken = number;

let nextToken = 1;
const open = new Map<string, { token: MarkToken; startedAt: number }>();

/** Mark the start of an open path. A second start for the same label
 *  REPLACES the live mark (the newest open is the one being measured);
 *  the displaced start can no longer record — a slow request that
 *  outlives a close/reopen must not consume the newer mark. */
export function perfStart(label: string): MarkToken {
  if (isServer) return 0;
  const token = nextToken++;
  open.set(label, { token, startedAt: now() });
  return token;
}

/** Close the mark, recording the duration in ms. Null (and no record)
 *  when there is no live mark for the label — or, when a token is given,
 *  when the live mark is NOT this one's: a newer open replaced it, or
 *  this mark already closed. */
export function perfEnd(label: string, token?: MarkToken): number | null {
  if (isServer) return null;
  const entry = open.get(label);
  if (!entry) return null;
  if (token !== undefined && entry.token !== token) return null;
  open.delete(label);
  const duration = now() - entry.startedAt;
  record(label, duration);
  return duration;
}

/** Abandon an open mark without recording: a drawer closed before its
 *  data arrived is not an open-latency sample, but it must not linger in
 *  perfInFlight either. Idempotent; token-checked like perfEnd. */
export function perfCancel(label: string, token?: MarkToken): void {
  if (isServer) return;
  const entry = open.get(label);
  if (!entry) return;
  if (token !== undefined && entry.token !== token) return;
  open.delete(label);
}

/** Measure a whole promise: start → resolution (success or failure — a
 *  slow failure is still a slow open). The error rethrows unchanged.
 *  The mark is owned: a stale resolution outlived by a reopen records
 *  nothing. */
export async function perfTrack<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const token = perfStart(label);
  try {
    return await fn();
  } finally {
    perfEnd(label, token);
  }
}

/**
 * Measure a live stream's open: the mark starts when the stream source is
 * called (the open) and ends at the FIRST yielded value — that is the
 * "chat loading" the user feels. Late yields don't re-mark, and a late
 * finalizer (an old stream's cleanup after a reconnect) can only end its
 * OWN mark — never a newer open's. The iterable passes through untouched.
 */
export function perfFirstValue<T>(
  source: AsyncIterable<T> | Promise<AsyncIterable<T>>,
  label: string,
): AsyncIterable<T> {
  const token = perfStart(label);
  return {
    async *[Symbol.asyncIterator]() {
      let first = true;
      try {
        const iterable = await source;
        for await (const value of iterable) {
          if (first) {
            first = false;
            perfEnd(label, token);
          }
          yield value;
        }
      } finally {
        // Ownership: a no-op when the first value already closed this
        // mark, or when a newer open replaced it.
        perfEnd(label, token);
      }
    },
  };
}

// ── the stats the panel tables ───────────────────────────────────────────

export type PerfStat = {
  label: string;
  count: number;
  last: number;
  p50: number;
  p95: number;
  max: number;
};

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[index]!;
}

/** One row per label: the latest duration and the distribution. */
export function perfStats(): PerfStat[] {
  const rows: PerfStat[] = [];
  for (const [label, list] of samples) {
    const sorted = [...list].sort((a, b) => a - b);
    rows.push({
      label,
      count: list.length,
      last: list[list.length - 1] ?? 0,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      max: sorted[sorted.length - 1] ?? 0,
    });
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

/** Labels with a start but no end yet — opens still waiting on data. */
export function perfInFlight(): string[] {
  return [...open.keys()].sort();
}

/** Drop everything (the panel's Clear button). */
export function perfClear(): void {
  samples.clear();
  open.clear();
}

// ── the ?perf=1 switch ──────────────────────────────────────────────────

const STORAGE_KEY = 'fd-perf';

let active: Accessor<boolean> | null = null;
let writeActive: ((on: boolean) => void) | null = null;

function persist(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // Private modes can refuse; the flag simply won't survive a reload.
  }
}

function readUrl(): boolean | null {
  const raw = new URLSearchParams(location.search).get('perf');
  return raw === '1' ? true : raw === '0' ? false : null;
}

function ensureFlag(): (on: boolean) => void {
  if (active) return writeActive!;
  let initial = false;
  if (!isServer) {
    // The storage read can throw when browser policy blocks localStorage
    // (some private modes / privacy settings) — an optional debug
    // preference must never take the app down with it. Default off; the
    // URL override below still works for this load.
    try {
      initial = localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      // blocked: default off
    }
    const fromUrl = readUrl();
    if (fromUrl !== null) {
      initial = fromUrl;
      persist(fromUrl);
    }
  }
  const [read, write] = createSignal(initial);
  active = read;
  writeActive = write;
  return write;
}

/** The debug panel's reactive on/off state. ?perf=1 in the URL turns it on
 *  (and persists), ?perf=0 turns it off — so it can be shared as a link. */
export function perfActive(): Accessor<boolean> {
  ensureFlag();
  return active!;
}

/** Flip the panel (its Close button, or a toggle elsewhere). Persists. */
export function setPerfActive(on: boolean): void {
  ensureFlag()(on);
  if (!isServer) persist(on);
}

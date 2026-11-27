// The telemetry sink — the observability contract's client half
// (docs/observability.md, the event taxonomy; behavior events per
// docs/data-playbook.md's stable core). One posthog-js instance, shared
// with the flag runtime, initialized ONCE with the privacy posture:
//
//   * local dev sends nothing (import.meta.env.DEV guard — no SDK at all);
//   * every event carries app_environment (preview | production) as a
//     super property — the one-project environment split (docs/posthog.md);
//   * autocapture is ON for the friction signals (dead clicks read as
//     rates per element) but text-free and attribute-free: the element
//     chain says WHERE, never WHAT was on it (mask_all_text,
//     mask_all_element_attributes);
//   * replays mask every text node and every attribute — a recording
//     shows structure and interaction, never content. Sampling (10%)
//     and the URL/exception triggers are the project's remote config.
//
// High-frequency paths (perf marks, cache reads) never send per-sample:
// the sink aggregates minute buckets and flushes one counter per
// (label, minute) — the 1M event budget is a design constraint.
import posthog from 'posthog-js';
import { isServer } from '@solidjs/web';
import { env } from 'virtual:solid-env/client';

import type { FlagClient } from './flags/client';
import { setPerfSink } from './perf';

/** The posthog-js surface this app uses (flags lifecycle + capture). */
export type TelemetryRuntime = FlagClient & {
  capture(event: string, properties?: Record<string, unknown>): void;
  /** Super properties: attached to every subsequent event. */
  register(properties: Record<string, unknown>): void;
};

let instance: TelemetryRuntime | null = null;
let testRuntime: TelemetryRuntime | null = null;

/** The single posthog-js instance, or null where telemetry has no client
 *  runtime: SSR, local dev, or a build without the public env values. */
export function telemetryRuntime(): TelemetryRuntime | null {
  if (testRuntime) return testRuntime;
  if (isServer || import.meta.env.DEV) return null;
  if (!env.VITE_POSTHOG_KEY) return null;
  if (!instance) {
    posthog.init(env.VITE_POSTHOG_KEY, {
      // Our own origin under /ingest — the worker's allowlisted proxy
      // forwards to PostHog (docs/posthog.md), past the ad-blocker
      // lists that match *.posthog.com. posthog-js appends its
      // endpoint paths directly to api_host, so the /ingest prefix
      // must be part of the host itself.
      api_host: `${window.location.origin}/ingest`,
      // A SPA: pageviews ride the history API.
      capture_pageview: 'history_change',
      capture_pageleave: true,
      // $exception events — the taxonomy's error row (replays of
      // exception sessions are an event trigger in the project config).
      capture_exceptions: true,
      // Dead clicks are a friction signal; rage clicks ride the same
      // autocapture. Element text and attributes are masked everywhere:
      // the signals are read as RATES per element, never as content.
      capture_dead_clicks: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      session_recording: {
        // Replays show layout and interaction, never content — masking
        // everything is the only config that is provably complete
        // (names and titles appear on too many surfaces to sweep).
        maskTextSelector: '*',
        maskAllElementAttributes: true,
        maskAllInputs: true,
      },
    });
    posthog.register({
      app_environment: env.VITE_APP_ENV ?? 'local',
    });
    instance = posthog as unknown as TelemetryRuntime;
  }
  return instance;
}

// ── typed capture: the taxonomy is the ONLY set of event names ────────
// Each function owns its property schema; a new property needs a line in
// docs/observability.md (or data-playbook.md for behavior events).

/** A message/comment length bucket — bounded, never a raw length. */
export function messageLengthBucket(length: number): string {
  if (length <= 40) return 'short';
  if (length <= 280) return 'medium';
  if (length <= 2000) return 'long';
  return 'huge';
}

export function captureCardCreated(input: {
  boardId: string;
  hasDescription: boolean;
  hasDueDate: boolean;
}): void {
  telemetryRuntime()?.capture('card_created', {
    board_id: input.boardId,
    has_description: input.hasDescription,
    has_due_date: input.hasDueDate,
  });
}

export function captureCardCompleted(input: { boardId: string }): void {
  telemetryRuntime()?.capture('card_completed', {
    board_id: input.boardId,
    // The pre-redesign surface does not track list-entry times; the
    // redesign's list work fills this in (the schema ships now).
    time_in_list_hours: null,
  });
}

export function captureChatMessageSent(input: { boardId: string; length: number }): void {
  telemetryRuntime()?.capture('chat_message_sent', {
    board_id: input.boardId,
    message_length_bucket: messageLengthBucket(input.length),
  });
}

export function captureTeammateInvited(input: { channel: 'email' | 'link' }): void {
  telemetryRuntime()?.capture('teammate_invited', {
    board_id: null,
    channel: input.channel,
  });
}

/** mutation_echo — the outbox budget's reality check. Emitted by the sync
 *  engine at echo retirement (ok) and failure/stale (ok: false). */
export function captureMutationEcho(input: {
  kind: string;
  ms: number;
  ok: boolean;
  remote: boolean;
}): void {
  telemetryRuntime()?.capture('mutation_echo', {
    op_kind: input.kind,
    ms: Math.round(input.ms),
    ok: input.ok,
    remote: input.remote,
  });
}

/** sync_resync — rare by definition; a spike means a one-row change is
 *  falling off the fold (the canonical test, caught in prod). */
export function captureSyncResync(input: { trigger: string; ms: number }): void {
  telemetryRuntime()?.capture('sync_resync', {
    trigger: input.trigger,
    ms: Math.round(input.ms),
  });
}

// ── the auth state (a page_open property) ──────────────────────────────

let authState: (() => boolean) | null = null;

/** FlagSync registers the app's identity accessor — page_open/panel_open
 *  buckets stamp the auth state at flush time. */
export function setAuthStateForTelemetry(state: () => boolean): void {
  authState = state;
}

// ── minute buckets: perf marks + cache counters ────────────────────────

/** The open-path marks that flow to PostHog (the revalidate marks stay
 *  local — the perf panel is their surface). */
const MARK_EVENTS: Record<string, { event: 'page_open' | 'panel_open'; name: string }> = {
  'board-open': { event: 'page_open', name: 'board' },
  'ws-detail-open': { event: 'page_open', name: 'ws-detail' },
  'board-chat-open': { event: 'panel_open', name: 'board-chat' },
  'card-timeline-open': { event: 'panel_open', name: 'card-timeline' },
  'card-comments-open': { event: 'panel_open', name: 'card-comments' },
};

type MarkBucket = { minute: number; samples: number[] };
const markBuckets = new Map<string, MarkBucket>();
const cacheBuckets = new Map<string, { minute: number; hits: number; misses: number }>();

function minuteOf(at: number): number {
  return Math.floor(at / 60_000);
}

function onPerfSample(label: string, duration: number, at: number): void {
  const mapped = MARK_EVENTS[label];
  if (!mapped) return; // revalidate marks and friends stay local
  const minute = minuteOf(at);
  const bucket = markBuckets.get(label);
  if (bucket && bucket.minute === minute) {
    bucket.samples.push(duration);
  } else {
    markBuckets.set(label, { minute, samples: [duration] });
  }
}

/** cache_hit/cache_miss — one counter per (entity type, minute), never
 *  per read (taxonomy rule). Called from cache.ts on every get. The
 *  buckets are client-only shared state: cacheGet also runs server-side
 *  (the cached streams' SSR pass), and a server-side Map that never
 *  flushes would leak — so the server is a no-op here. */
export function telemetryCacheAccess(key: string, hit: boolean, at: number): void {
  if (isServer) return;
  const type = key.split(':')[0] ?? 'unknown';
  const minute = minuteOf(at);
  const bucket = cacheBuckets.get(type);
  if (bucket && bucket.minute === minute) {
    if (hit) bucket.hits += 1;
    else bucket.misses += 1;
  } else {
    cacheBuckets.set(type, { minute, hits: hit ? 1 : 0, misses: hit ? 0 : 1 });
  }
}

function quantile(sorted: number[], q: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return Math.round(sorted[index] ?? 0);
}

/** Flush every completed minute bucket as one event each. */
function flushBuckets(): void {
  const runtime = telemetryRuntime();
  if (!runtime) return;
  const authed = authState?.() ?? false;
  const now = minuteOf(Date.now());
  for (const [label, bucket] of markBuckets) {
    if (bucket.minute >= now) continue; // still filling
    const mapped = MARK_EVENTS[label]!;
    const sorted = [...bucket.samples].sort((a, b) => a - b);
    runtime.capture(mapped.event, {
      [mapped.event === 'page_open' ? 'route' : 'panel']: mapped.name,
      authed,
      p50_ms: quantile(sorted, 0.5),
      p95_ms: quantile(sorted, 0.95),
      count: sorted.length,
    });
    markBuckets.delete(label);
  }
  for (const [type, bucket] of cacheBuckets) {
    if (bucket.minute >= now) continue;
    if (bucket.hits > 0) runtime.capture('cache_hit', { entity_type: type, count: bucket.hits });
    if (bucket.misses > 0) {
      runtime.capture('cache_miss', { entity_type: type, count: bucket.misses });
    }
    cacheBuckets.delete(type);
  }
}

// ── wiring ──────────────────────────────────────────────────────────────

/**
 * Wire the client sinks — called once per app load (FlagSync's settle):
 * perf samples flow into minute buckets, and the flusher runs on a
 * quiet interval. Returns the teardown for its caller (FlagSync) to own.
 * No-op without a telemetry runtime (dev, SSR).
 */
export function startTelemetry(): (() => void) | null {
  if (isServer) return null;
  if (!telemetryRuntime()) return null;
  setPerfSink((label, duration, at) => onPerfSample(label, duration, at));
  const timer = setInterval(() => flushBuckets(), 60_000);
  // A pageleave never guarantees the interval fires; flush completed
  // buckets opportunistically (pagehide keeps it cheap).
  addEventListener('pagehide', flushBuckets);
  return () => {
    clearInterval(timer);
    removeEventListener('pagehide', flushBuckets);
    setPerfSink(null);
  };
}

// ── test seams ───────────────────────────────────────────────────────────

/** Drive the sink deterministically: a fake runtime + manual flush. */
export function setTelemetryRuntimeForTests(runtime: TelemetryRuntime | null): void {
  testRuntime = runtime;
}

/** Test-only: flush buckets now (ignores the minute boundary). */
export function __flushTelemetryForTests(): void {
  flushBuckets();
}

/** Test-only: observe perf samples as the real sink would. */
export function __onPerfSampleForTests(label: string, duration: number, at: number): void {
  onPerfSample(label, duration, at);
}

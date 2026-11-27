// Telemetry sink tests — the taxonomy's property schemas and the
// minute-bucket discipline: high-frequency paths (perf marks, cache
// reads) aggregate, flush once per (label/type, minute), and never send
// per-sample. Behavior events fire once per durable action (the engine
// contract) with bounded, no-PII properties.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __flushTelemetryForTests,
  __onPerfSampleForTests,
  captureCardCompleted,
  captureCardCreated,
  captureChatMessageSent,
  captureMutationEcho,
  captureSyncResync,
  captureTeammateInvited,
  messageLengthBucket,
  setAuthStateForTelemetry,
  setTelemetryRuntimeForTests,
  startTelemetry,
  telemetryCacheAccess,
  type TelemetryRuntime,
} from './telemetry';
import { createRoot, flush } from 'solid-js';
import { createEngine, type OpSpec } from './sync';

// ── the fake runtime: capture is the observable ───────────────────────

type Captured = { event: string; properties: Record<string, unknown> };

function fakeRuntime(): { runtime: TelemetryRuntime; captured: Captured[] } {
  const captured: Captured[] = [];
  return {
    captured,
    runtime: {
      identify: () => {},
      reset: () => {},
      setPersonPropertiesForFlags: () => {},
      resetPersonPropertiesForFlags: () => {},
      reloadFeatureFlags: () => {},
      capture: (event, properties) => captured.push({ event, properties: properties ?? {} }),
      register: () => {},
    },
  };
}

beforeEach(() => {
  setTelemetryRuntimeForTests(null);
});

afterEach(() => {
  setTelemetryRuntimeForTests(null);
  setAuthStateForTelemetry(() => false);
});

// ── behavior events: exact property schemas ────────────────────────────

describe('behavior events', () => {
  it('card_created carries the creation shape (no PII)', () => {
    const { runtime, captured } = fakeRuntime();
    setTelemetryRuntimeForTests(runtime);
    captureCardCreated({ boardId: 'b1', hasDescription: false, hasDueDate: false });
    expect(captured).toEqual([
      {
        event: 'card_created',
        properties: { board_id: 'b1', has_description: false, has_due_date: false },
      },
    ]);
  });

  it('card_completed ships the schema with time_in_list pending the redesign', () => {
    const { runtime, captured } = fakeRuntime();
    setTelemetryRuntimeForTests(runtime);
    captureCardCompleted({ boardId: 'b1' });
    expect(captured[0]).toEqual({
      event: 'card_completed',
      properties: { board_id: 'b1', time_in_list_hours: null },
    });
  });

  it('chat_message_sent buckets lengths — never a raw length', () => {
    const { runtime, captured } = fakeRuntime();
    setTelemetryRuntimeForTests(runtime);
    captureChatMessageSent({ boardId: 'b1', length: 10 });
    captureChatMessageSent({ boardId: 'b1', length: 500 });
    captureChatMessageSent({ boardId: 'b1', length: 5000 });
    expect(captured.map((c) => c.properties.message_length_bucket)).toEqual([
      'short',
      'long',
      'huge',
    ]);
    expect(captured[0].properties.board_id).toBe('b1');
  });

  it('teammate_invited records the delivering channel', () => {
    const { runtime, captured } = fakeRuntime();
    setTelemetryRuntimeForTests(runtime);
    captureTeammateInvited({ channel: 'link' });
    expect(captured[0]).toEqual({
      event: 'teammate_invited',
      properties: { board_id: null, channel: 'link' },
    });
  });

  it('captures nothing without a runtime (local dev / SSR)', () => {
    expect(() =>
      captureCardCreated({ boardId: 'b1', hasDescription: false, hasDueDate: false }),
    ).not.toThrow();
  });
});

describe('messageLengthBucket', () => {
  it('has stable, ordered boundaries', () => {
    expect(messageLengthBucket(0)).toBe('short');
    expect(messageLengthBucket(40)).toBe('short');
    expect(messageLengthBucket(41)).toBe('medium');
    expect(messageLengthBucket(280)).toBe('medium');
    expect(messageLengthBucket(281)).toBe('long');
    expect(messageLengthBucket(2000)).toBe('long');
    expect(messageLengthBucket(2001)).toBe('huge');
  });
});

// ── system events ───────────────────────────────────────────────────────

describe('mutation_echo and sync_resync', () => {
  it('mutation_echo carries the outbox budget shape', () => {
    const { runtime, captured } = fakeRuntime();
    setTelemetryRuntimeForTests(runtime);
    captureMutationEcho({ kind: 'move-card', ms: 123.4, ok: true, remote: false });
    expect(captured[0]).toEqual({
      event: 'mutation_echo',
      properties: { op_kind: 'move-card', ms: 123, ok: true, remote: false },
    });
  });

  it('sync_resync carries the trigger and duration', () => {
    const { runtime, captured } = fakeRuntime();
    setTelemetryRuntimeForTests(runtime);
    captureSyncResync({ trigger: 'periodic', ms: 640 });
    expect(captured[0]).toEqual({
      event: 'sync_resync',
      properties: { trigger: 'periodic', ms: 640 },
    });
  });
});

// ── the minute buckets ─────────────────────────────────────────────────

describe('mark buckets (page_open / panel_open)', () => {
  it('flushes ONE event per mapped label with p50/p95 and the auth state', () => {
    const { runtime, captured } = fakeRuntime();
    setTelemetryRuntimeForTests(runtime);
    setAuthStateForTelemetry(() => true);
    const minute = Math.floor(Date.now() / 60_000) - 1; // a completed bucket
    for (let i = 1; i <= 10; i++) __onPerfSampleForTests('board-open', i * 10, minute * 60_000);
    __flushTelemetryForTests();
    expect(captured).toHaveLength(1);
    const event = captured[0]!;
    expect(event.event).toBe('page_open');
    expect(event.properties).toEqual({
      route: 'board',
      authed: true,
      p50_ms: 50,
      p95_ms: 100,
      count: 10,
    });
  });

  it('aggregates each mapped label separately and ignores revalidate marks', () => {
    const { runtime, captured } = fakeRuntime();
    setTelemetryRuntimeForTests(runtime);
    const at = (Math.floor(Date.now() / 60_000) - 1) * 60_000;
    __onPerfSampleForTests('board-chat-open', 30, at);
    __onPerfSampleForTests('card-comments-open', 40, at);
    __onPerfSampleForTests('board-revalidate', 999, at); // stays local
    __flushTelemetryForTests();
    expect(captured.map((c) => c.event)).toEqual(['panel_open', 'panel_open']);
    expect(new Set(captured.map((c) => c.properties.panel))).toEqual(
      new Set(['board-chat', 'card-comments']),
    );
  });
});

describe('cache counters (cache_hit / cache_miss)', () => {
  it('counts per (type, minute) — never per read', () => {
    const { runtime, captured } = fakeRuntime();
    setTelemetryRuntimeForTests(runtime);
    const at = (Math.floor(Date.now() / 60_000) - 1) * 60_000;
    telemetryCacheAccess('board-chat:c1', true, at);
    telemetryCacheAccess('board-chat:c2', true, at);
    telemetryCacheAccess('board-chat:c1', false, at);
    telemetryCacheAccess('card-comments:c1', true, at);
    __flushTelemetryForTests();
    const events = captured.map((c) => [c.event, c.properties] as const);
    expect(events).toContainEqual(['cache_hit', { entity_type: 'board-chat', count: 2 }]);
    expect(events).toContainEqual(['cache_miss', { entity_type: 'board-chat', count: 1 }]);
    expect(events).toContainEqual(['cache_hit', { entity_type: 'card-comments', count: 1 }]);
    expect(events).toHaveLength(3);
  });
});

describe('startTelemetry', () => {
  it('is a no-op without a runtime (dev, SSR)', () => {
    expect(startTelemetry()).toBeNull();
  });
});

// ── the engine contract: behavior telemetry fires at echo retirement ──

describe('the sync engine telemetry contract', () => {
  type S = { value: string; count: number };

  /** The engine's effects need an owner, and its streams need the
   *  suite's push-driven shape (the sync tests' harness). */
  const harness = () => {
    const queue: S[] = [];
    let wake: (() => void) | undefined;
    const push = (next: S) => {
      queue.push(next);
      if (wake) {
        const w = wake;
        wake = undefined;
        w();
      }
    };
    async function* fakeStream(): AsyncGenerator<S> {
      let current: S = { value: '', count: 0 };
      while (true) {
        yield current;
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        const next = queue.shift();
        if (next) current = next;
      }
    }
    let engine!: ReturnType<typeof createEngine<S>>;
    const dispose = createRoot((d) => {
      engine = createEngine<S>({
        empty: { value: '', count: 0 },
        streamSource: () => fakeStream(),
        key: () => 'test',
        clone: (snapshot) => ({ ...snapshot }),
        merge: (draft, durable) => {
          draft.value = durable.value;
        },
      });
      return d;
    });
    return { engine, dispose, push };
  };

  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flush();
  };

  it('fires the spec telemetry ONCE when the author op echoes durable', async () => {
    const { runtime, captured } = fakeRuntime();
    setTelemetryRuntimeForTests(runtime);
    const { engine, dispose, push } = harness();
    const spec: OpSpec<S> = {
      kind: 'test-op',
      // The retire pass keys off guarded entities — every real op guards
      // or temp-ids what it touches.
      guards: ['value'],
      apply: (draft) => {
        draft.value = 'next';
      },
      send: () => Promise.resolve(),
      echo: (durable) => durable.value === 'next',
      telemetry: () =>
        captureCardCreated({ boardId: 'b1', hasDescription: false, hasDueDate: false }),
    };
    await settle();
    engine.mutate(spec);
    push({ value: 'next', count: 0 });
    await settle();
    expect(captured.filter((c) => c.event === 'card_created')).toHaveLength(1);
    const echoes = captured.filter((c) => c.event === 'mutation_echo');
    expect(echoes).toHaveLength(1);
    expect(echoes[0]!.properties).toEqual(
      expect.objectContaining({ op_kind: 'test-op', ok: true, remote: false }),
    );
    expect(engine.ops()).toHaveLength(0); // retired — the source of "once"
    dispose();
  });

  it('never fires telemetry for a failed op — the action did not happen', async () => {
    const { runtime, captured } = fakeRuntime();
    setTelemetryRuntimeForTests(runtime);
    const { engine, dispose } = harness();
    const spec: OpSpec<S> = {
      kind: 'test-op',
      guards: ['value'],
      apply: (draft) => {
        draft.value = 'next';
      },
      send: () => Promise.reject(new Error('nope')),
      echo: () => false,
      telemetry: () =>
        captureCardCreated({ boardId: 'b1', hasDescription: false, hasDueDate: false }),
    };
    await settle();
    engine.mutate(spec);
    await settle();
    expect(captured.filter((c) => c.event === 'card_created')).toHaveLength(0);
    const echoes = captured.filter((c) => c.event === 'mutation_echo');
    expect(echoes).toHaveLength(1);
    expect(echoes[0]!.properties).toEqual(
      expect.objectContaining({ op_kind: 'test-op', ok: false }),
    );
    dispose();
  });
});

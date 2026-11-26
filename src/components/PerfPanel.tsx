// The perf debug panel — the ?perf=1 window onto the marks (see
// lib/perf.ts). Fixed bottom-right, dark in both themes (it's a devtool,
// not app chrome), refreshes twice a second, copies as JSON for pasting
// into an issue.
import { For, Show, createSignal, onSettled } from 'solid-js';

import { perfClear, perfInFlight, perfStats, setPerfActive, type PerfStat } from '../lib/perf';

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

export function PerfPanel() {
  const [stats, setStats] = createSignal<PerfStat[]>(perfStats());
  const [inFlight, setInFlight] = createSignal<string[]>(perfInFlight());
  const [copied, setCopied] = createSignal(false);
  onSettled(() => {
    const timer = setInterval(() => {
      setStats(perfStats());
      setInFlight(perfInFlight());
    }, 500);
    return () => clearInterval(timer);
  });
  const copy = () => {
    void navigator.clipboard?.writeText(JSON.stringify(perfStats(), null, 2)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => setCopied(false),
    );
  };
  return (
    <div
      role="dialog"
      aria-label="Performance marks"
      class="fixed bottom-3 right-3 z-[90] max-h-[60vh] w-[380px] max-w-[92vw] overflow-auto rounded-lg border border-neutral-700 bg-neutral-900/95 p-3 text-xs text-neutral-100 shadow-2xl"
    >
      <div class="mb-2 flex items-center justify-between gap-2">
        <span class="font-semibold">Perf marks</span>
        <span class="flex items-center gap-1">
          <button
            type="button"
            onClick={copy}
            class="rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 hover:text-white"
          >
            {copied() ? 'copied ✓' : 'copy'}
          </button>
          <button
            type="button"
            onClick={() => perfClear()}
            class="rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 hover:text-white"
          >
            clear
          </button>
          <button
            type="button"
            onClick={() => setPerfActive(false)}
            class="rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 hover:text-white"
          >
            close
          </button>
        </span>
      </div>
      <Show
        when={stats().length > 0}
        fallback={
          <p class="text-neutral-400">No marks recorded yet — open a board, a chat, a card.</p>
        }
      >
        <table class="w-full tabular-nums">
          <thead>
            <tr class="text-left text-neutral-400">
              <th class="pr-2 font-medium">label</th>
              <th class="px-1 font-medium">n</th>
              <th class="px-1 font-medium">last</th>
              <th class="px-1 font-medium">p50</th>
              <th class="px-1 font-medium">p95</th>
              <th class="pl-1 font-medium">max</th>
            </tr>
          </thead>
          <tbody>
            <For each={stats()}>
              {(row) => (
                <tr class="border-t border-neutral-800">
                  <td class="py-0.5 pr-2">{row.label}</td>
                  <td class="px-1 text-neutral-400">{row.count}</td>
                  <td class="px-1">{fmt(row.last)}</td>
                  <td class="px-1">{fmt(row.p50)}</td>
                  <td class="px-1">{fmt(row.p95)}</td>
                  <td class="pl-1 text-neutral-400">{fmt(row.max)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
      <Show when={inFlight().length > 0}>
        <p class="mt-2 text-neutral-400">in flight: {inFlight().join(', ')}</p>
      </Show>
      <p class="mt-2 text-[11px] leading-4 text-neutral-500">
        Marks: board-open, board-refresh, board-chat-open, card-comments-open, card-timeline-open
        (paint) / card-timeline-fetch (revalidate), ws-detail-open (roster paint) /
        ws-detail-revalidate, and the cached streams' *-revalidate legs. Budgets live in
        docs/performance.md.
      </p>
    </div>
  );
}

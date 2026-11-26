// Extracted from the board route (phase 6): a panel is its own module
// so the route stays a wiring file (L5 rule 6).
import { For, Show, createSignal } from 'solid-js';

import { foldContext, lineDiff } from '../../lib/diff';

/** A description change in the trail: "updated the description" plus a
 *  collapsed, GitHub-style from/to diff (0063's snapshots). Rows without
 *  snapshots — events written before 0063 — keep the plain line. */
export function DescriptionDiffEvent(props: { from: string; to: string }) {
  const [open, setOpen] = createSignal(false);
  const rows = () => foldContext(lineDiff(props.from, props.to));
  return (
    <span>
      updated the description{' '}
      <button type="button" class="fd-diff-toggle" onClick={() => setOpen(!open())}>
        {open() ? 'hide changes' : 'show changes'}
      </button>
      <Show when={open()}>
        <div class="fd-diff mt-1 overflow-x-auto rounded-md border border-neutral-200 text-xs dark:border-neutral-700">
          <For each={rows()}>
            {(row) =>
              row.type === 'fold' ? (
                <div class="fd-diff-fold">
                  ⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'}
                </div>
              ) : (
                <div
                  class={[
                    'fd-diff-row',
                    `fd-diff-${row.type}`,
                    { 'fd-diff-empty': row.text === '' },
                  ]}
                >
                  <span class="fd-diff-sign">
                    {row.type === 'del' ? '−' : row.type === 'add' ? '+' : ' '}
                  </span>
                  <span class="fd-diff-text">{row.text}</span>
                </div>
              )
            }
          </For>
        </div>
      </Show>
    </span>
  );
}

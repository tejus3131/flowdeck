import type { RouteDefinition } from '@solidjs/router';
import { For } from 'solid-js';

import { playgroundPreload } from './guard';
import { PlaygroundHeading, PlaygroundShell, LifecycleTag } from './shell';
import { PAGES, type PlaygroundPage } from './component-registry';

export const route = {
  preload: playgroundPreload,
} satisfies RouteDefinition;

export default function PlaygroundIndex() {
  return (
    <PlaygroundShell>
      <PlaygroundHeading
        title="Flowdeck playground"
        note="The real production components and tokens, side by side, from synthetic fixtures. Previewing a variant here never changes anyone's production assignment."
      />
      <section>
        <h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Components
        </h2>
        <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <For each={Object.entries(PAGES) as [string, PlaygroundPage][]}>
            {([name, page]) => (
              <li>
                <a
                  href={`/playground/components/${name}`}
                  class="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
                >
                  <span class="font-medium">{page.title}</span>
                  <LifecycleTag status={page.status} />
                </a>
              </li>
            )}
          </For>
        </ul>
      </section>
      <section class="mt-6">
        <h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Foundations
        </h2>
        <a
          href="/playground/tokens"
          class="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
        >
          <span class="font-medium">Token sets</span>
          <LifecycleTag status="shipping" />
        </a>
      </section>
    </PlaygroundShell>
  );
}

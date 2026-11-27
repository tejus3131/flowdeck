import type { RouteDefinition } from '@solidjs/router';
import { For } from 'solid-js';

import { playgroundPreload } from '../guard';
import { PlaygroundHeading, PlaygroundShell, LifecycleTag } from '../shell';
import { PAGES, type PlaygroundPage } from '../component-registry';

export const route = {
  preload: playgroundPreload,
} satisfies RouteDefinition;

export default function PlaygroundComponents() {
  return (
    <PlaygroundShell>
      <PlaygroundHeading
        title="Components"
        note="The same implementations production imports — states, themes, and lifecycles side by side."
      />
      <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <For each={Object.entries(PAGES) as [string, PlaygroundPage][]}>
          {([name, page]: [string, PlaygroundPage]) => (
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
    </PlaygroundShell>
  );
}

import type { RouteDefinition } from '@solidjs/router';

import { playgroundPreload } from './guard';
import { PlaygroundHeading, PlaygroundShell, LifecycleTag } from './shell';
import { ComponentList } from './component-registry';

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
        <h2 class="mb-fd-2 text-fd-sm font-semibold uppercase tracking-wider text-fd-text-3">
          Components
        </h2>
        <ComponentList />
      </section>
      <section class="mt-fd-6">
        <h2 class="mb-fd-2 text-fd-sm font-semibold uppercase tracking-wider text-fd-text-3">
          Foundations
        </h2>
        <a
          href="/playground/tokens"
          class="flex items-center justify-between rounded-fd-md border border-fd-line px-fd-3 py-fd-2 text-fd-sm hover:bg-fd-bg-1"
        >
          <span class="font-medium">Token sets</span>
          <LifecycleTag status="shipping" />
        </a>
      </section>
    </PlaygroundShell>
  );
}

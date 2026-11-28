import type { RouteDefinition, RoutePreloadFuncArgs } from '@solidjs/router';
import { httpStatus } from '@solidjs/web';
import { Show } from 'solid-js';

import { playgroundPreload } from '../guard';
import { PlaygroundHeading, PlaygroundShell, LifecycleTag } from '../shell';
import { NotFound } from '../../../components/NotFound';
import { PAGES } from '../component-registry';

export const route = {
  preload: async (args: RoutePreloadFuncArgs) => {
    await playgroundPreload();
    // An unknown component name is an unknown page — the normal 404.
    if (!PAGES[args.params.name ?? '']) httpStatus(404);
  },
} satisfies RouteDefinition;

export default function PlaygroundComponentPage(props: { params: { name: string } }) {
  const page = () => PAGES[props.params.name];
  return (
    <PlaygroundShell>
      <Show when={page()} fallback={<NotFound />}>
        {(resolved) => (
          <>
            <PlaygroundHeading
              title={resolved().title}
              note="Variants, states, and themes — the production implementation, rendered from synthetic fixtures."
            />
            <div class="mb-4">
              <LifecycleTag status={resolved().status} />
            </div>
            {resolved().render()}
          </>
        )}
      </Show>
    </PlaygroundShell>
  );
}

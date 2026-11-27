import type { RouteDefinition } from '@solidjs/router';

import { playgroundPreload } from '../guard';
import { PlaygroundHeading, PlaygroundShell } from '../shell';
import { ComponentList } from '../component-registry';

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
      <ComponentList />
    </PlaygroundShell>
  );
}

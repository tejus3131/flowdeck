// The developer playground (docs/feature-flags-and-ui-playground.md):
// an environment-gated catalogue (ADR-17 amendment) of the REAL
// production components and the token layer, rendered side by side from
// synthetic fixtures. Gallery selection is explicitly local and
// non-persistent — a preview here never changes anyone's production
// flag assignment.
import { Title } from '@solidjs/meta';
import { Show, type ParentProps } from 'solid-js';

import { NotFound } from '../../components/NotFound';
import { playgroundEnabled } from './guard';

// Lifecycle statuses ride the tag-hue tokens (the same fixed-L/C hues
// the Badge primitive uses — they hold contrast in both themes, so no
// dark: variants): exploration = hue 2, candidate = hue 5, shipping =
// hue 3; retired is the neutral ladder. A status palette of its own is
// a P3 decision if the gallery grows more statuses.
export const LIFECYCLE = {
  exploration: 'bg-fd-tag-2/15 text-fd-tag-2',
  candidate: 'bg-fd-tag-5/15 text-fd-tag-5',
  shipping: 'bg-fd-tag-3/15 text-fd-tag-3',
  retired: 'bg-fd-bg-2 text-fd-text-3',
} as const;

export function LifecycleTag(props: { status: keyof typeof LIFECYCLE }) {
  return (
    <span class={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${LIFECYCLE[props.status]}`}>
      {props.status}
    </span>
  );
}

/** The shared shell: the client render agrees with the preload's server
 *  decision — both read the same build-baked environment values, so a
 *  production request renders the normal 404 on both sides. */
export function PlaygroundShell(props: ParentProps) {
  return (
    <Show when={playgroundEnabled()} fallback={<NotFound />}>
      <main class="mx-auto max-w-5xl px-4 py-8">
        <Title>Playground - Flowdeck</Title>
        <header class="mb-6">
          <p class="text-fd-xs font-semibold uppercase tracking-wider text-fd-text-3">
            Developer playground — synthetic data only
          </p>
          <nav class="mt-1 flex gap-4 text-sm">
            <a class="font-medium text-fd-accent hover:underline" href="/playground">
              Gallery
            </a>
            <a class="text-fd-text-2 hover:underline" href="/playground/tokens">
              Tokens
            </a>
            <a class="text-fd-text-2 hover:underline" href="/playground/components">
              Components
            </a>
          </nav>
        </header>
        {props.children}
      </main>
    </Show>
  );
}

/** The one-line "what am I looking at" header each page carries. */
export function PlaygroundHeading(props: { title: string; note: string }) {
  return (
    <div class="mb-6">
      <h1 class="text-lg font-semibold">{props.title}</h1>
      <p class="mt-1 text-fd-sm text-fd-text-2">{props.note}</p>
    </div>
  );
}

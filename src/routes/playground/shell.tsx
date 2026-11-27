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

export const LIFECYCLE = {
  exploration: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
  candidate: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300',
  shipping: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200',
  retired: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
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
          <p class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Developer playground — synthetic data only
          </p>
          <nav class="mt-1 flex gap-4 text-sm">
            <a
              class="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              href="/playground"
            >
              Gallery
            </a>
            <a
              class="text-neutral-600 hover:underline dark:text-neutral-300"
              href="/playground/tokens"
            >
              Tokens
            </a>
            <a
              class="text-neutral-600 hover:underline dark:text-neutral-300"
              href="/playground/components"
            >
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
      <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{props.note}</p>
    </div>
  );
}

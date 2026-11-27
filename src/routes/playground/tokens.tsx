import type { RouteDefinition } from '@solidjs/router';
import { For, createSignal } from 'solid-js';

import { playgroundPreload } from './guard';
import { PlaygroundHeading, PlaygroundShell } from './shell';

export const route = {
  preload: playgroundPreload,
} satisfies RouteDefinition;

/** One swatch — the token's actual computed value on a chip. */
function Swatch(props: { name: string; varName: string }) {
  return (
    <div class="flex items-center gap-2">
      <span
        class="h-8 w-12 rounded-fd-sm border border-fd-line"
        style={{ 'background-color': `var(${props.varName})` }}
      />
      <code class="text-xs text-fd-text-2">
        {props.name} <span class="text-fd-text-3">{props.varName}</span>
      </code>
    </div>
  );
}

const SURFACES = [
  ['page', '--fd-bg'],
  ['raised', '--fd-bg-1'],
  ['well', '--fd-bg-2'],
  ['line', '--fd-line'],
] as const;

const INK = [
  ['text', '--fd-text'],
  ['text-2', '--fd-text-2'],
  ['text-3', '--fd-text-3'],
] as const;

const ACCENTS = [
  ['accent', '--fd-accent'],
  ['accent-hover', '--fd-accent-hover'],
  ['accent-tint', '--fd-accent-tint'],
  ['danger', '--fd-danger'],
  ['success', '--fd-success'],
] as const;

const TYPE_SCALE = [
  ['fd-text-xs', 'text-fd-xs'],
  ['fd-text-sm', 'text-fd-sm'],
  ['fd-text-base', 'text-fd-base'],
  ['fd-text-lg', 'text-fd-lg'],
  ['fd-text-xl', 'text-fd-xl'],
] as const;

const RADIUS = [
  ['sm — inputs, chips', 'rounded-fd-sm'],
  ['md — cards, popovers', 'rounded-fd-md'],
  ['lg — drawer, modals', 'rounded-fd-lg'],
  ['full — avatars, pills', 'rounded-fd-full'],
] as const;

export default function PlaygroundTokens() {
  // Gallery selection is LOCAL and non-persistent: the P1 gray axis
  // swaps by data attribute on this page only — never a production
  // flag assignment.
  const [gray, setGray] = createSignal<'warm' | 'cool'>('warm');
  return (
    <PlaygroundShell>
      <PlaygroundHeading
        title="Token sets"
        note="The frozen layer (ADR-16) rendered from its own values. The gray axis is the open P1 experiment — swap it here; the choice is local and resets on reload."
      />
      <div data-gray={gray() === 'cool' ? 'cool' : undefined} class="rounded-fd-lg bg-fd-bg p-4">
        <div class="mb-4 flex gap-2 text-sm">
          <button
            type="button"
            class={[
              'rounded-fd-sm px-2 py-1 font-medium',
              { 'bg-fd-accent-tint text-fd-accent': gray() === 'warm' },
              { 'text-fd-text-2': gray() !== 'warm' },
            ]}
            onClick={() => setGray('warm')}
          >
            warm gray (P1-A)
          </button>
          <button
            type="button"
            class={[
              'rounded-fd-sm px-2 py-1 font-medium',
              { 'bg-fd-accent-tint text-fd-accent': gray() === 'cool' },
              { 'text-fd-text-2': gray() !== 'cool' },
            ]}
            onClick={() => setGray('cool')}
          >
            cool gray (P1-B)
          </button>
        </div>

        <section class="mb-6">
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-fd-text-3">
            Surfaces & ink
          </h3>
          <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
            <For each={SURFACES}>{([name, v]) => <Swatch name={name} varName={v} />}</For>
            <For each={INK}>{([name, v]) => <Swatch name={name} varName={v} />}</For>
          </div>
        </section>

        <section class="mb-6">
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-fd-text-3">
            Accent & semantic (rationed)
          </h3>
          <div class="grid grid-cols-2 gap-2 md:grid-cols-5">
            <For each={ACCENTS}>{([name, v]) => <Swatch name={name} varName={v} />}</For>
          </div>
        </section>

        <section class="mb-6">
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-fd-text-3">
            Tag hues — 8 fixed L/C, perceptually even
          </h3>
          <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
            <For each={[1, 2, 3, 4, 5, 6, 7, 8] as const}>
              {(hue) => <Swatch name={`tag-${hue}`} varName={`--fd-tag-${hue}`} />}
            </For>
          </div>
        </section>

        <section class="mb-6">
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-fd-text-3">
            Type scale — sizes with their line-heights
          </h3>
          <div class="space-y-1 text-fd-text">
            <For each={TYPE_SCALE}>
              {([token, cls]) => (
                <p class={cls}>{token} — The quick brown fox jumps over the lazy dog</p>
              )}
            </For>
          </div>
          <p class="mt-2 text-fd-xs text-fd-text-3">
            One family (Inter Variable), one measure: <code>--fd-measure: 708px</code>
          </p>
        </section>

        <section class="mb-6">
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-fd-text-3">
            Radius & spacing (Canva's 8px grid)
          </h3>
          <div class="flex flex-wrap items-center gap-3">
            <For each={RADIUS}>
              {([label, cls]) => (
                <div class={[cls, 'border border-fd-line bg-fd-bg-1 px-3 py-2 text-fd-xs']}>
                  {label}
                </div>
              )}
            </For>
          </div>
        </section>

        <section>
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-fd-text-3">
            Motion & elevation
          </h3>
          <p class="mb-2 text-fd-xs text-fd-text-2">
            Budget: enter 300ms / exit 200ms (never equal); zero motion on menus, chips, keystrokes;
            spring on completion only; drop-settle 330–550ms by drag distance.
            prefers-reduced-motion turns everything off globally.
          </p>
          <div class="flex flex-wrap gap-3">
            <div class="rounded-fd-sm bg-fd-bg-1 px-3 py-2 shadow-fd-1 text-fd-xs">
              shadow-fd-1 (cards on board)
            </div>
            <div class="rounded-fd-sm bg-fd-bg-1 px-3 py-2 shadow-fd-2 text-fd-xs">
              shadow-fd-2 (drawer, popovers)
            </div>
          </div>
        </section>
      </div>
    </PlaygroundShell>
  );
}

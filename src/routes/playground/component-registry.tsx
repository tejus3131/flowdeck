// The playground's component catalogue: every page renders the SAME
// production implementations the app imports (never a parallel copy),
// side by side with their states. Fixtures are synthetic; interactions
// are display-only.
import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';

import { Button, type ButtonVariant } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Surface } from '../../components/ui/Surface';
import { TagChip } from '../../components/TagChip';
import { FixtureContext } from './fixtures';

/** A labelled row of examples — the catalogue's one layout idea:
 * comparable variants side by side under the same fixture + viewport. */
function Row(props: { label: string; children: JSX.Element }) {
  return (
    <section class="mb-8">
      <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
        {props.label}
      </h3>
      <div class="flex flex-wrap items-center gap-3 rounded-fd-md bg-fd-bg p-4 dark:bg-neutral-950">
        {props.children}
      </div>
    </section>
  );
}

/** Light and dark side by side — the tokens override on the .dark
 *  subtree, so both themes render in one viewport without touching the
 *  user's own theme choice. */
function ThemePair(props: { children: JSX.Element }) {
  return (
    <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
      <div class="rounded-fd-md bg-fd-bg p-4">{props.children}</div>
      <div class="dark rounded-fd-md bg-fd-bg p-4">{props.children}</div>
    </div>
  );
}

const BUTTON_VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger'];

export type PlaygroundPage = {
  title: string;
  status: 'exploration' | 'candidate' | 'shipping' | 'retired';
  render: () => JSX.Element;
};

export const PAGES: Record<string, PlaygroundPage> = {
  button: {
    title: 'Button',
    status: 'shipping',
    render: () => (
      <>
        <Row label="Variants — the 60/30/10 discipline (accent on primary only)">
          <For each={BUTTON_VARIANTS}>
            {(variant) => <Button variant={variant}>{variant}</Button>}
          </For>
        </Row>
        <Row label="Sizes">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
        </Row>
        <Row label="States — hover, focus-visible (keyboard), disabled">
          <Button>Hover me</Button>
          <span class="text-xs text-neutral-400">← tab into the next one</span>
          <Button onClick={() => {}}>Focus target</Button>
          <Button disabled>Disabled</Button>
        </Row>
        <Row label="Themes — light and dark read the same tokens">
          <ThemePair>
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
          </ThemePair>
        </Row>
      </>
    ),
  },
  input: {
    title: 'Input + Field',
    status: 'shipping',
    render: () => (
      <>
        <Row label="States — empty, filled, focus, invalid (error), disabled">
          <div class="grid w-full max-w-sm grid-cols-1 gap-3">
            <Field label="Empty">
              <Input placeholder="Type something…" />
            </Field>
            <Field label="Filled">
              <Input value="Renaming surfaces" onInput={() => {}} />
            </Field>
            <Field label="Error" hint="Names must be unique in the workspace.">
              <Input value="design" invalid />
            </Field>
            <Field label="Disabled">
              <Input value="not now" disabled />
            </Field>
          </div>
        </Row>
        <Row label="Loading — the cold-path skeleton (never on a warm open)">
          <div class="h-[38px] w-full max-w-sm animate-pulse rounded-fd-sm bg-fd-bg-2" />
        </Row>
      </>
    ),
  },
  badge: {
    title: 'Badge (tag hues)',
    status: 'shipping',
    render: () => (
      <Row label="The 8 perceptually even hues — light and dark hold contrast">
        <ThemePair>
          <div class="flex flex-wrap gap-2">
            <For each={[1, 2, 3, 4, 5, 6, 7, 8] as const}>
              {(hue) => <Badge hue={hue}>hue {hue}</Badge>}
            </For>
          </div>
        </ThemePair>
      </Row>
    ),
  },
  surface: {
    title: 'Surface (the P2 elevation axis)',
    status: 'candidate',
    render: () => (
      <>
        <Row label="Tones — raised (level 1), well, page">
          <Surface>A raised card — shadow-fd-1</Surface>
          <Surface tone="well">A well — bg-fd-bg-2</Surface>
          <Surface tone="page">A page — bg-fd-bg</Surface>
        </Row>
        <Row label="Flat vs elevated — the P2 experiment, side by side">
          <ThemePair>
            <div class="flex gap-3">
              <Surface flat>
                <div class="p-4 text-fd-sm">Flat</div>
              </Surface>
              <Surface>
                <div class="p-4 text-fd-sm">Elevated</div>
              </Surface>
            </div>
          </ThemePair>
        </Row>
      </>
    ),
  },
  'tag-chip': {
    title: 'TagChip (the L5 worked example)',
    status: 'shipping',
    render: () => (
      <FixtureContext>
        <Row label="The REAL component — names resolve from the entity store via selectors">
          <TagChip tagId="fd-fixture-tag-1" fallbackName="design" />
          <TagChip tagId="fd-fixture-tag-2" fallbackName="backend" />
          <TagChip tagId="fd-fixture-tag-3" fallbackName="needs-review" />
          <TagChip tagId="fd-fixture-tag-unknown" fallbackName="cold-paint fallback" />
          <TagChip tagId="fd-fixture-tag-1" variant="drawer" />
        </Row>
      </FixtureContext>
    ),
  },
};

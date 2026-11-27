// The shared badge/chip primitives — tag hues are perceptually even
// (8 fixed L/C hues; the playground can show the whole chip set).
import type { ParentProps } from 'solid-js';

const TAG_VARS = [
  'text-fd-tag-1',
  'text-fd-tag-2',
  'text-fd-tag-3',
  'text-fd-tag-4',
  'text-fd-tag-5',
  'text-fd-tag-6',
  'text-fd-tag-7',
  'text-fd-tag-8',
] as const;

export function Badge(props: ParentProps & { hue?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 }) {
  return (
    <span
      class={`inline-flex items-center rounded-fd-full px-2 py-0.5 text-fd-xs font-medium
        ${TAG_VARS[(props.hue ?? 1) - 1]}`}
      style={{
        'background-color': `color-mix(in oklch, var(--fd-tag-${props.hue ?? 1}) 18%, transparent)`,
      }}
    >
      {props.children}
    </span>
  );
}

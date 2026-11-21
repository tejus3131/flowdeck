// A person's picture: the uploaded avatar when there is one, otherwise a
// colored initial. Used in the nav, the profile page, and member lists.
import { Show } from 'solid-js';

const SIZES = {
  sm: 'h-7 w-7 text-xs',
  md: 'h-9 w-9 text-sm',
  lg: 'h-24 w-24 text-3xl',
} as const;

export function Avatar(props: {
  src?: string | null;
  name?: string | null;
  email?: string | null;
  size?: keyof typeof SIZES;
}) {
  const initial = () =>
    (props.name?.trim() || props.email?.split('@')[0] || '?').charAt(0).toUpperCase();
  return (
    <Show
      when={props.src}
      fallback={
        <span
          aria-hidden="true"
          class={`flex select-none items-center justify-center rounded-full bg-indigo-100 font-semibold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200 ${SIZES[props.size ?? 'md']}`}
        >
          {initial()}
        </span>
      }
    >
      {(src) => (
        <img
          src={src()}
          alt={props.name ?? props.email ?? 'Avatar'}
          class={`rounded-full object-cover ring-1 ring-neutral-200 dark:ring-neutral-700 ${SIZES[props.size ?? 'md']}`}
        />
      )}
    </Show>
  );
}

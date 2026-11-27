// The shared UI primitives — the frozen token layer's first consumers
// (docs/design-system.md, ADR-16). Production surfaces and the developer
// playground import the SAME implementations; nothing here hardcodes a
// color, spacing, radius, or motion value — every one reads an --fd-*
// token through its Tailwind mapping.
import type { ParentProps } from 'solid-js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANT: Record<ButtonVariant, string> = {
  // 60/30/10 discipline: the accent appears on primary actions only.
  primary: 'bg-fd-accent text-fd-bg hover:bg-fd-accent-hover disabled:hover:bg-fd-accent',
  secondary:
    'bg-fd-bg-1 text-fd-text border border-fd-line hover:bg-fd-bg-2 disabled:hover:bg-fd-bg-1',
  ghost: 'bg-transparent text-fd-text-2 hover:bg-fd-bg-2 hover:text-fd-text',
  danger: 'bg-fd-danger text-fd-bg hover:opacity-90',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'px-fd-2 py-fd-1 text-fd-xs',
  md: 'px-fd-3 py-fd-1 text-fd-sm',
};

export function Button(
  props: ParentProps & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    disabled?: boolean;
    type?: 'button' | 'submit';
    onClick?: () => void;
  },
) {
  return (
    <button
      type={props.type ?? 'button'}
      disabled={props.disabled ?? false}
      onClick={() => props.onClick?.()}
      class={[
        'inline-flex items-center justify-center gap-fd-1 rounded-fd-sm font-medium',
        'transition-colors duration-fd-1 ease-fd-out',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT[props.variant ?? 'primary'],
        SIZE[props.size ?? 'md'],
      ]}
    >
      {props.children}
    </button>
  );
}

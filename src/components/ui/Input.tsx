// The shared input primitive — the token layer's baseline form control.
// New surfaces and the playground use this so form controls and their
// focus wells come from one place.
import { Show, type ParentProps } from 'solid-js';

export function Input(
  props: ParentProps & {
    value?: string;
    placeholder?: string;
    invalid?: boolean;
    disabled?: boolean;
    onInput?: (value: string) => void;
  },
) {
  return (
    <input
      value={props.value ?? ''}
      placeholder={props.placeholder}
      disabled={props.disabled ?? false}
      onInput={(event) => props.onInput?.(event.currentTarget.value)}
      aria-invalid={props.invalid ? 'true' : undefined}
      class={[
        'w-full rounded-fd-sm border bg-fd-bg-1 px-fd-3 py-fd-2 text-fd-sm text-fd-text outline-none',
        'placeholder:text-fd-text-3 transition-colors duration-fd-1 ease-fd-out',
        'focus:border-fd-accent focus:ring-2 focus:ring-fd-accent-tint',
        'disabled:cursor-not-allowed disabled:opacity-50',
        props.invalid ? 'border-fd-danger' : 'border-fd-line',
      ]}
    />
  );
}

/** A labeled field wrapper — the form rhythm (label, control, hint). */
export function Field(props: ParentProps & { label: string; hint?: string }) {
  return (
    <label class="block">
      <span class="mb-1 block text-fd-xs font-medium text-fd-text-2">{props.label}</span>
      {props.children}
      <Show when={props.hint}>
        <span class="mt-1 block text-fd-xs text-fd-text-3">{props.hint}</span>
      </Show>
    </label>
  );
}

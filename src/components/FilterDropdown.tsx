// A GitHub-issues-style filter dropdown: a labeled button, a search box,
// and a multi-select (or single-select) checklist. Click-away closes.
import { For, Show, createSignal, onSettled } from 'solid-js';

export function FilterDropdown(props: {
  label: string;
  items: { value: string; label: string; sub?: string }[];
  selected: string[];
  onChange: (selected: string[]) => void;
  /** Single-select mode: picking one clears the rest. */
  single?: boolean;
  searchable?: boolean;
  /** Extra fixed entries (e.g. "Unassigned") rendered above the items. */
  leading?: { value: string; label: string }[];
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  let root: HTMLDivElement | undefined;

  onSettled(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (open() && root && !root.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  });

  const filtered = () => {
    const q = query().trim().toLowerCase();
    return props.items.filter(
      (item) =>
        !q || item.label.toLowerCase().includes(q) || (item.sub ?? '').toLowerCase().includes(q),
    );
  };

  const toggle = (value: string) => {
    if (props.single) {
      props.onChange(props.selected.includes(value) ? [] : [value]);
      setOpen(false);
      return;
    }
    props.onChange(
      props.selected.includes(value)
        ? props.selected.filter((v) => v !== value)
        : [...props.selected, value],
    );
  };

  const buttonLabel = () => {
    if (props.selected.length === 0) return props.label;
    if (props.selected.length === 1) {
      const match =
        props.items.find((item) => item.value === props.selected[0]) ??
        props.leading?.find((item) => item.value === props.selected[0]);
      return match?.label ?? props.label;
    }
    return `${props.label}: ${props.selected.length}`;
  };

  return (
    <div ref={root} class="relative">
      <button
        type="button"
        class={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
          props.selected.length > 0
            ? 'border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300'
            : 'border-neutral-200 text-neutral-500 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-500'
        }`}
        onClick={() => setOpen(!open())}
      >
        {buttonLabel()}
        <span class="text-[9px] text-neutral-400">▼</span>
      </button>

      <Show when={open()}>
        <div class="absolute left-0 top-full z-40 mt-1.5 w-56 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
          <div class="border-b border-neutral-100 p-1.5 dark:border-neutral-800">
            <input
              type="search"
              class="w-full text-xs"
              placeholder={`Filter ${props.label.toLowerCase()}…`}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <div class="max-h-56 overflow-y-auto p-1">
            <For each={props.leading ?? []}>
              {(item) => (
                <button
                  type="button"
                  class={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs ${
                    props.selected.includes(item.value)
                      ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                      : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                  }`}
                  onClick={() => toggle(item.value)}
                >
                  <span class="flex-1">{item.label}</span>
                  <Show when={props.selected.includes(item.value)}>✓</Show>
                </button>
              )}
            </For>
            <Show when={(props.leading?.length ?? 0) > 0}>
              <div class="my-1 h-px bg-neutral-100 dark:bg-neutral-800" />
            </Show>
            <For each={filtered()}>
              {(item) => (
                <button
                  type="button"
                  title={item.sub}
                  class={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs ${
                    props.selected.includes(item.value)
                      ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                      : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                  }`}
                  onClick={() => toggle(item.value)}
                >
                  <span class="min-w-0 flex-1 truncate">{item.label}</span>
                  <span class="shrink-0 truncate text-[10px] text-neutral-400">{item.sub}</span>
                  <Show when={props.selected.includes(item.value)}>✓</Show>
                </button>
              )}
            </For>
            <Show when={filtered().length === 0 && (props.leading?.length ?? 0) === 0}>
              <p class="px-2 py-1.5 text-xs text-neutral-400">No matches</p>
            </Show>
          </div>
          <Show when={props.selected.length > 0}>
            <div class="border-t border-neutral-100 p-1.5 dark:border-neutral-800">
              <button
                type="button"
                class="w-full rounded-lg px-2 py-1 text-xs font-medium text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800"
                onClick={() => props.onChange([])}
              >
                Clear
              </button>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// Extracted from the board route (phase 6): a panel is its own module
// so the route stays a wiring file (L5 rule 6).
import { For, Show, createSignal } from 'solid-js';

import { findOrCreateTag } from '../../lib/boards';

/** The tag input: chips backed by the workspace's shared vocabulary.
 *  Existing tags autocomplete by name; a NEW name opens a tiny inline
 *  form that takes a description with it (the "what is this tag for"
 *  the vocabulary deserves) — then it's created and attached. */
export function TagInput(props: {
  workspaceTags: { id: string; name: string; description?: string }[];
  workspaceId: string;
  onAdd: (tag: { id: string; name: string }) => void;
}) {
  const [draft, setDraft] = createSignal('');
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [creating, setCreating] = createSignal<string | null>(null);
  const [description, setDescription] = createSignal('');
  let root: HTMLDivElement | undefined;

  const suggestions = () => {
    const q = draft().trim().toLowerCase().replace(/^#/, '');
    return props.workspaceTags.filter((tag) => !q || tag.name.includes(q)).slice(0, 5);
  };
  /** Does the typed name already exist? (then no create flow needed) */
  const exists = () => {
    const clean = draft().trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
    return clean !== '' && props.workspaceTags.some((tag) => tag.name === clean);
  };
  /** Open the create-with-description form for the typed name. */
  const openCreate = () => {
    const clean = draft().trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').slice(0, 24);
    if (!clean) return;
    setCreating(clean);
    setDescription('');
  };

  const add = async (name: string) => {
    const clean = name.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').slice(0, 24);
    if (!clean || busy()) return;
    setBusy(true);
    try {
      const existing = props.workspaceTags.find((tag) => tag.name === clean);
      const tag = existing ?? (await findOrCreateTag(props.workspaceId, clean, description()));
      props.onAdd(tag);
      setDraft('');
      setOpen(false);
      setCreating(null);
      setDescription('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="relative" onClick={(event) => event.stopPropagation()}>
      <input
        class="w-28 rounded-full border border-dashed border-neutral-300 bg-transparent px-2 py-0.5 text-[11px] dark:border-neutral-700"
        placeholder="+ tag…"
        value={draft()}
        onInput={(event) => {
          setDraft(event.currentTarget.value);
          setCreating(null);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          // Focus moving INTO the dropdown (the create form's description
          // input) must keep it open — the old timer closed it out from
          // under the typist.
          if (root?.contains(event.relatedTarget as Node | null)) return;
          setTimeout(() => {
            setOpen(false);
            setCreating(null);
          }, 150);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            const first = suggestions()[0];
            if (first && draft().trim() !== '' && !creating()) void add(first.name);
            else if (draft().trim() !== '' && !creating()) openCreate();
          }
          if (event.key === 'Escape') setOpen(false);
        }}
      />
      <Show when={open() && draft().trim() !== ''}>
        <div
          ref={root}
          class="absolute left-0 top-full z-30 mt-1 w-56 rounded-xl border border-neutral-200 bg-white p-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
        >
          <For each={suggestions()}>
            {(tag) => (
              <button
                type="button"
                class="block w-full rounded-lg px-2 py-1 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                onMouseDown={(event) => {
                  event.preventDefault();
                  void add(tag.name);
                }}
              >
                #{tag.name}
                <Show when={tag.description}>
                  <span class="ml-1 text-[10px] text-neutral-400">— {tag.description}</span>
                </Show>
              </button>
            )}
          </For>
          <Show
            when={!exists() && !creating()}
            fallback={
              <Show when={creating()}>
                <form
                  class="space-y-1.5 border-t border-neutral-100 p-1.5 dark:border-neutral-800"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void add(creating()!);
                  }}
                >
                  <p class="text-[11px] font-semibold text-neutral-500 dark:text-neutral-300">
                    New tag #{creating()}
                  </p>
                  <input
                    class="w-full text-xs"
                    placeholder="What is this tag for? (optional)"
                    value={description()}
                    onInput={(event) => setDescription(event.currentTarget.value)}
                    autofocus
                  />
                  <div class="flex gap-2">
                    <button
                      type="submit"
                      disabled={busy()}
                      class="rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {busy() ? 'Creating…' : 'Create & add'}
                    </button>
                    <button
                      type="button"
                      class="text-[11px] font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                      onClick={() => setCreating(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </Show>
            }
          >
            <button
              type="button"
              class="mt-0.5 block w-full rounded-lg px-2 py-1 text-left text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950"
              onMouseDown={(event) => {
                event.preventDefault();
                openCreate();
              }}
            >
              + Create “{draft().trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-')}”
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

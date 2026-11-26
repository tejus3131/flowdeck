// Extracted from the board route (phase 6): a panel is its own module
// so the route stays a wiring file (L5 rule 6).
import { Show, createSignal } from 'solid-js';

export function AddList(props: { onAdd: (name: string) => void }) {
  const [open, setOpen] = createSignal(false);
  return (
    <Show
      when={open()}
      fallback={
        <button
          type="button"
          class="h-10 w-72 shrink-0 rounded-2xl border border-dashed border-neutral-300 text-sm font-medium text-neutral-500 hover:border-neutral-400 hover:bg-neutral-100/60 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:bg-neutral-900/70"
          onClick={() => setOpen(true)}
        >
          + Add list
        </button>
      }
    >
      <form
        class="flex w-72 shrink-0 flex-col gap-2 rounded-2xl border border-neutral-200/80 bg-neutral-100/60 p-3 dark:border-neutral-800 dark:bg-neutral-900/70"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const name = String(new FormData(form).get('name') ?? '').trim();
          if (name) props.onAdd(name);
          form.reset();
          setOpen(false);
        }}
      >
        <input name="name" placeholder="List name…" autofocus />
        <div class="flex gap-2">
          <button
            type="submit"
            class="rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
          >
            Add list
          </button>
          <button
            type="button"
            class="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
        </div>
      </form>
    </Show>
  );
}

/**
 * The card detail drawer — the GitHub-PR experience at card scale: markdown
 * description with preview/edit, #number citations that open cards, and
 * LIVE comments (a small engine over the card's comment stream; new
 * comments arrive by relay instantly and by echo durably, whoever wrote
 * them). Opening a card marks its comments seen.
 */
/** The mentionable handle for a member: username, first name, or email
 *  handle — the exact string @autocomplete inserts and chips validate. */

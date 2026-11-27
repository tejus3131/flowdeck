// Extracted from the board route (phase 6): a panel is its own module
// so the route stays a wiring file (L5 rule 6).
import { For, Show, createSignal, onSettled } from 'solid-js';

import { getChatPref, setChatPref, CHAT_LEVELS, type ChatLevel } from '../../lib/chat-prefs';

/**
 * The per-scope notification settings (Slack channel-notification style):
 * all messages / direct + team mentions / direct only / nothing. Shared
 * by the board chat header and the card drawer header.
 */
export function ChatPrefMenu(props: { scopeType: 'board' | 'card'; scopeId: string }) {
  const [level, setLevel] = createSignal<ChatLevel | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

  onSettled(() => {
    // The click-away listener registers synchronously so onSettled can
    // return the cleanup (onCleanup is forbidden inside onSettled — the
    // throw took down the whole board page in dev).
    const onPointerDown = (event: MouseEvent) => {
      if (open() && root && !root.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    void getChatPref(props.scopeType, props.scopeId)
      .then((saved) => {
        setLevel(saved);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => document.removeEventListener('mousedown', onPointerDown);
  });

  const current = () => level() ?? 'mentions_team';
  const pick = (next: ChatLevel | null) => {
    setLevel(next);
    void setChatPref(props.scopeType, props.scopeId, next).catch(() => {});
    setOpen(false);
  };

  return (
    <div ref={root} class="relative">
      <button
        type="button"
        title="Notification settings"
        class={`rounded-md px-1.5 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
          level() === null ? 'text-neutral-400' : 'text-indigo-500'
        }`}
        onClick={() => setOpen(!open())}
      >
        🔔
      </button>
      <Show when={open()}>
        <div class="absolute right-0 top-full z-40 mt-1.5 w-60 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
          <p class="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Notify me about
          </p>
          <For each={CHAT_LEVELS}>
            {(option) => (
              <button
                type="button"
                class={`flex w-full flex-col rounded-lg px-2 py-1.5 text-left text-xs ${
                  current() === option.value
                    ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                    : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                }`}
                onClick={() => pick(option.value)}
              >
                <span class="font-medium">{option.label}</span>
                <span class="text-[10px] text-neutral-400">{option.hint}</span>
              </button>
            )}
          </For>
          <Show when={level() !== null && loaded()}>
            <button
              type="button"
              class="mt-0.5 w-full rounded-lg px-2 py-1.5 text-left text-xs text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              onClick={() => pick(null)}
            >
              Reset to default
            </button>
          </Show>
          <p class="px-2 pt-1.5 text-[10px] leading-snug text-neutral-400">
            Mentions arrive as notifications; “all” activity is quiet — it lives in the bell’s Chat
            section.
          </p>
        </div>
      </Show>
    </div>
  );
}

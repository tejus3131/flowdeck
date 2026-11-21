// The signed-in nav menu: avatar (or initial) → profile link, theme control,
// sign out. Click-away and Escape close it.
import { revalidate } from '@solidjs/router';
import { Show, createSignal, onSettled, For } from 'solid-js';

import { Avatar } from './Avatar';
import type { MeProfile } from '../lib/auth';
import { signOut } from '../lib/auth';
import { addPasskey } from '../lib/passkey';
import { applyTheme, parseTheme, saveTheme, writeThemeCookie, type Theme } from '../lib/theme';

const QUICK_THEMES: { value: Theme; icon: string; label: string }[] = [
  { value: 'system', icon: '🖥', label: 'System' },
  { value: 'light', icon: '☀️', label: 'Light' },
  { value: 'dark', icon: '🌙', label: 'Dark' },
];

export function UserMenu(props: { profile: () => MeProfile }) {
  const [open, setOpen] = createSignal(false);
  const [passkeyBusy, setPasskeyBusy] = createSignal(false);
  let root: HTMLDivElement | undefined;

  onSettled(() => {
    // Document-level click-away: active for the page's life, cheap to no-op.
    const onPointerDown = (event: MouseEvent) => {
      if (open() && root && !root.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open()) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  });

  const quickTheme = async (theme: Theme) => {
    const previous = parseTheme(props.profile().theme) ?? 'system';
    if (theme === previous) return;
    applyTheme(theme);
    writeThemeCookie(theme);
    try {
      await saveTheme(theme); // mutation → revalidates, syncs other devices
    } catch {
      applyTheme(previous);
      writeThemeCookie(previous);
    }
  };

  const addPass = async () => {
    setPasskeyBusy(true);
    const result = await addPasskey();
    setPasskeyBusy(false);
    if (result.ok) revalidate('me');
  };

  return (
    <div ref={root} class="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open() ? 'true' : 'false'}
        title={props.profile().display_name ?? props.profile().email}
        class="rounded-full transition hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
        onClick={() => setOpen(!open())}
      >
        <Avatar
          src={props.profile().avatar_url}
          name={props.profile().display_name}
          email={props.profile().email}
          size="sm"
        />
      </button>

      <Show when={open()}>
        <div
          role="menu"
          class="absolute right-0 top-full z-50 mt-2 w-64 rounded-2xl border border-neutral-200 bg-white p-2 shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
        >
          <a
            role="menuitem"
            href="/profile"
            class="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            onClick={() => setOpen(false)}
          >
            <Avatar
              src={props.profile().avatar_url}
              name={props.profile().display_name}
              email={props.profile().email}
              size="md"
            />
            <span class="min-w-0">
              <span class="block truncate text-sm font-semibold">
                {props.profile().display_name || props.profile().email}
              </span>
              <span class="block truncate text-xs text-neutral-400">
                {props.profile().username ? `@${props.profile().username}` : props.profile().email}
              </span>
            </span>
          </a>

          <div class="my-1 h-px bg-neutral-200 dark:bg-neutral-800" />

          <div class="flex items-center justify-between gap-1 px-2 py-1.5">
            <span class="text-xs font-medium text-neutral-400">Theme</span>
            <span class="flex gap-1">
              <For each={QUICK_THEMES}>
                {(theme) => (
                  <button
                    type="button"
                    title={theme.label}
                    aria-label={`${theme.label} theme`}
                    class={[
                      'rounded-lg px-1.5 py-1 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800',
                      {
                        'bg-neutral-100 opacity-100 dark:bg-neutral-800':
                          (parseTheme(props.profile().theme) ?? 'system') === theme.value,
                        'opacity-50': (parseTheme(props.profile().theme) ?? 'system') !== theme.value,
                      },
                    ]}
                    onClick={() => void quickTheme(theme.value)}
                  >
                    {theme.icon}
                  </button>
                )}
              </For>
            </span>
          </div>

          <a
            role="menuitem"
            href="/profile"
            class="block rounded-xl px-2 py-2 text-sm font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800"
            onClick={() => setOpen(false)}
          >
            Profile &amp; settings
          </a>

          <Show when={!props.profile().has_passkey}>
            <button
              type="button"
              role="menuitem"
              disabled={passkeyBusy()}
              class="w-full rounded-xl px-2 py-2 text-left text-sm font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-60 dark:text-indigo-400 dark:hover:bg-indigo-950"
              onClick={() => void addPass()}
            >
              🔑 {passkeyBusy() ? 'Waiting for your device…' : 'Add a passkey'}
            </button>
          </Show>

          <form action={signOut} method="post">
            <button
              type="submit"
              role="menuitem"
              class="w-full rounded-xl px-2 py-2 text-left text-sm font-medium text-neutral-500 hover:bg-neutral-100 hover:text-red-500 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              Sign out
            </button>
          </form>
        </div>
      </Show>
    </div>
  );
}

// The signed-in nav menu: avatar (or initial) → profile link, theme control,
// sign out. Click-away and Escape close it.
import { revalidate } from '@solidjs/router';
import { Show, createSignal, onSettled, For } from 'solid-js';

import { Avatar } from './Avatar';
import type { MeProfile } from '../lib/auth';
import { signOut } from '../lib/auth';
import { addPasskey } from '../lib/passkey';
import { applyTheme, parseTheme, saveTheme, writeThemeCookie, type Theme } from '../lib/theme';
import {
  deleteStatusPreset,
  dndActive,
  myStatus,
  refreshMyStatus,
  saveStatusPreset,
  setStatus,
} from '../lib/status';

const STATUS_DURATIONS: { minutes: number | null; label: string }[] = [
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
  { minutes: null, label: 'No limit' },
];
const QUICK_THEMES: { value: Theme; icon: string; label: string }[] = [
  { value: 'system', icon: '🖥', label: 'System' },
  { value: 'light', icon: '☀️', label: 'Light' },
  { value: 'dark', icon: '🌙', label: 'Dark' },
];

export function UserMenu(props: { profile: () => MeProfile }) {
  const [open, setOpen] = createSignal(false);
  const [passkeyBusy, setPasskeyBusy] = createSignal(false);
  let root: HTMLDivElement | undefined;

  // ── status editing (the little Slack-style picker) ───────────────────
  const [statusOpen, setStatusOpen] = createSignal(false);
  const [statusEmoji, setStatusEmoji] = createSignal('');
  const [statusText, setStatusText] = createSignal('');
  const [statusDnd, setStatusDnd] = createSignal(false);
  const [statusMinutes, setStatusMinutes] = createSignal<number | null>(null);
  const [statusBusy, setStatusBusy] = createSignal(false);

  const openStatusEditor = () => {
    const current = myStatus();
    setStatusEmoji(current?.emoji ?? '');
    setStatusText(current?.label ?? '');
    setStatusDnd(Boolean(current?.dnd));
    setStatusMinutes(current?.clearAt ? 60 : null);
    setStatusOpen(!statusOpen());
  };

  const applyStatus = async () => {
    if (statusBusy()) return;
    setStatusBusy(true);
    try {
      await setStatus({
        emoji: statusEmoji().trim() || null,
        label: statusText().trim() || null,
        minutes: statusMinutes(),
        dnd: statusDnd(),
      });
      setStatusOpen(false);
    } finally {
      setStatusBusy(false);
    }
  };

  const clearMyStatus = async () => {
    if (statusBusy()) return;
    setStatusBusy(true);
    try {
      await setStatus({ emoji: null, label: null, dnd: false, minutes: null });
      setStatusOpen(false);
    } finally {
      setStatusBusy(false);
    }
  };

  onSettled(() => {
    void refreshMyStatus();
  });

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
                {props.profile().email}
              </span>
            </span>
          </a>

          <div class="my-1 h-px bg-neutral-200 dark:bg-neutral-800" />

          {/* ── status (Slack-style) ─────────────────────────────────── */}
          <Show
            when={!statusOpen()}
            fallback={
              <div class="flex flex-col gap-1.5 px-2 py-1.5">
                <span class="text-xs font-medium text-neutral-400">Set a status</span>
                <div class="flex gap-1.5">
                  <input
                    class="w-10 rounded-lg border border-neutral-200 bg-transparent px-1.5 py-1 text-center text-sm dark:border-neutral-700"
                    placeholder="🙂"
                    maxlength="4"
                    value={statusEmoji()}
                    onInput={(event) => setStatusEmoji(event.currentTarget.value)}
                  />
                  <input
                    class="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
                    placeholder="What's happening?"
                    maxlength="60"
                    value={statusText()}
                    onInput={(event) => setStatusText(event.currentTarget.value)}
                  />
                </div>
                <label class="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                  <input
                    type="checkbox"
                    checked={statusDnd()}
                    onChange={(event) => setStatusDnd(event.currentTarget.checked)}
                  />
                  Do not disturb — silence all notifications
                </label>
                <div class="flex flex-wrap gap-1">
                  <For each={STATUS_DURATIONS}>
                    {(option) => (
                      <button
                        type="button"
                        class={`rounded-lg px-2 py-0.5 text-[11px] font-medium ${
                          statusMinutes() === option.minutes
                            ? 'bg-indigo-600 text-white'
                            : 'bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700'
                        }`}
                        onClick={() => setStatusMinutes(option.minutes)}
                      >
                        {option.label}
                      </button>
                    )}
                  </For>
                </div>
                <Show when={(statusEmoji().trim() || statusText().trim()) && !(myStatus()?.emoji === statusEmoji().trim() && myStatus()?.label === statusText().trim())}>
                  <button
                    type="button"
                    title="Save this as a one-click preset"
                    class="self-start text-[11px] font-medium text-neutral-400 hover:text-indigo-500"
                    onClick={() => void saveStatusPreset({ emoji: statusEmoji().trim() || null, label: statusText().trim() || null, dnd: statusDnd() })}
                  >
                    💾 Save as preset
                  </button>
                </Show>
                <div class="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    class="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                    disabled={statusBusy()}
                    onClick={() => void applyStatus()}
                  >
                    {statusBusy() ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    class="text-xs font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                    onClick={() => setStatusOpen(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            }
          >
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
              onClick={openStatusEditor}
            >
              <span class="text-sm">{myStatus()?.emoji ?? '💬'}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs font-medium">
                  {myStatus()?.label ?? 'Set a status'}
                </span>
                <span class="block truncate text-[10px] text-neutral-400">
                  {dndActive() ? '🔕 notifications silenced' : 'visible on your profile + mentions'}
                </span>
              </span>
            </button>
            <Show when={(myStatus()?.presets.length ?? 0) > 0 || (myStatus()?.emoji || myStatus()?.label)}>
              <div class="flex flex-wrap gap-1 px-2 pb-1">
                <Show when={myStatus()?.emoji || myStatus()?.label}>
                  <button
                    type="button"
                    title="Clear status"
                    class="rounded-lg bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500 hover:bg-red-50 hover:text-red-600 dark:bg-neutral-800 dark:text-neutral-300"
                    onClick={() => void clearMyStatus()}
                  >
                    ✕ clear
                  </button>
                </Show>
                <For each={myStatus()?.presets ?? []}>
                  {(preset, index) => (
                    <span class="group/preset inline-flex items-center gap-0.5 rounded-lg bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
                      <button
                        type="button"
                        title={preset.dnd ? 'Apply (do not disturb)' : 'Apply'}
                        class="text-[11px] font-medium text-neutral-600 hover:text-indigo-600 dark:text-neutral-300 dark:hover:text-indigo-400"
                        onClick={() => void setStatus({ emoji: preset.emoji, label: preset.label, dnd: preset.dnd, minutes: null })}
                      >
                        {preset.emoji ?? '💬'} {preset.label ?? preset.dnd ? preset.label : ''}
                        {preset.dnd ? ' 🔕' : ''}
                      </button>
                      <button
                        type="button"
                        title="Delete preset"
                        class="text-[10px] text-neutral-300 hover:text-red-500 dark:text-neutral-600"
                        onClick={() => void deleteStatusPreset(index())}
                      >
                        ×
                      </button>
                    </span>
                  )}
                </For>
              </div>
            </Show>
          </Show>

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

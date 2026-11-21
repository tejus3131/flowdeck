// The theme choice UI: a segmented System / Light / Dark control. The
// choice applies instantly and the save happens in the background — a
// failure reverts and surfaces inline, matching the board engine's feel.
import { revalidate } from '@solidjs/router';
import { Show, createSignal, For } from 'solid-js';

import { saveTheme, applyTheme, writeThemeCookie, type Theme, THEMES } from '../lib/theme';

const THEME_META: Record<Theme, { label: string; icon: string; hint: string }> = {
  system: { label: 'System', icon: '🖥', hint: 'Match this device' },
  light: { label: 'Light', icon: '☀️', hint: 'Always light' },
  dark: { label: 'Dark', icon: '🌙', hint: 'Always dark' },
};

export function ThemePicker(props: { theme: () => Theme }) {
  const [saving, setSaving] = createSignal<Theme | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const pick = async (theme: Theme) => {
    if (theme === props.theme() || saving()) return;
    const previous = props.theme();
    setError(null);
    setSaving(theme);
    applyTheme(theme); // instant, everywhere on this device
    writeThemeCookie(theme);
    try {
      await saveTheme(theme); // database is the source of truth
      revalidate('me'); // refresh the profile choice for every consumer
    } catch (err) {
      applyTheme(previous); // revert on failure — the engine way
      writeThemeCookie(previous);
      setError(err instanceof Error ? err.message : 'Could not save your theme');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Theme"
        class="inline-flex rounded-xl border border-neutral-200 bg-neutral-100 p-1 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <For each={THEMES}>
          {(theme) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.theme() === theme ? 'true' : 'false'}
              title={THEME_META[theme].hint}
              class={[
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition',
                {
                  'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white':
                    props.theme() === theme,
                  'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200':
                    props.theme() !== theme,
                },
              ]}
              onClick={() => void pick(theme)}
            >
              <span aria-hidden="true">{THEME_META[theme].icon}</span>
              <span>{THEME_META[theme].label}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={error()}>
        <p role="alert" class="mt-2 text-sm text-red-600 dark:text-red-400">
          {error()}
        </p>
      </Show>
    </div>
  );
}

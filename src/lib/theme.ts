// The theme system. The database (profiles.theme) is the source of truth so
// the choice follows the user across devices; a long-lived cookie mirrors it
// per device so the very first paint is always right (no flash), and an
// inline head script resolves "system" against prefers-color-scheme before
// anything renders. Realtime profiles updates push changes to other
// devices instantly.
import { getRequestEvent } from '@solidjs/web';
import { stringifySetCookie } from 'cookie';

import { createSupabaseRequestClient } from '../server/supabase';

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_COOKIE = 'ob_theme';
const YEAR_SECONDS = 60 * 60 * 24 * 365;

export function parseTheme(value: string | null | undefined): Theme | null {
  return THEMES.includes(value as Theme) ? (value as Theme) : null;
}

/** Cookie serialization shared by the server response and client writes. */
export function themeCookie(theme: Theme): string {
  return stringifySetCookie({
    name: THEME_COOKIE,
    value: theme,
    path: '/',
    maxAge: YEAR_SECONDS,
    sameSite: 'lax',
  });
}

// ── client (browser) ───────────────────────────────────────────────────────

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Apply a theme choice to <html> immediately — no server round trip. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const dark = theme === 'dark' || (theme === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

/** Mirror the theme into the device cookie so first paints stay right. */
export function writeThemeCookie(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.cookie = themeCookie(theme);
}

/** The currently-effective choice from the cookie (pre-hydration truth). */
export function readThemeCookieClient(): Theme {
  if (typeof document === 'undefined') return 'system';
  const match = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=(system|light|dark)`));
  return parseTheme(match?.[1]) ?? 'system';
}

/** Watch OS-level preference flips while the choice is "system". */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

// ── server ────────────────────────────────────────────────────────────────

/** The theme cookie as sent with this request (for SSR paint). */
export function readThemeCookieServer(): Theme {
  const event = getRequestEvent();
  const header = event?.request.headers.get('cookie') ?? '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${THEME_COOKIE}=(system|light|dark)`));
  return parseTheme(match?.[1]) ?? 'system';
}

/**
 * Persist the choice to profiles.theme and refresh the device cookie on the
 * response. The caller has already applied the theme locally — this never
 * blocks the UI; on error the picker reverts.
 */
export async function saveTheme(theme: Theme): Promise<boolean> {
  'use server';
  const choice = parseTheme(theme);
  if (!choice) throw new Error('Unknown theme');

  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Sign in to save your theme');

  const { error } = await supabase.from('profiles').update({ theme: choice }).eq('id', user.id);
  if (error) throw new Error(error.message);

  const event = getRequestEvent();
  event?.response.headers.append('set-cookie', themeCookie(choice));
  return true;
}

// The theme engine's client half: corrects any drift between the database
// and this device's cookie after hydration, follows OS preference changes
// while the choice is "system", and subscribes to our own profile row so a
// theme (or name/avatar) change on another device applies here instantly.
import { revalidate } from '@solidjs/router';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { onSettled } from 'solid-js';
import { isServer } from '@solidjs/web';

import type { MeProfile } from '../lib/auth';
import { browserClient } from '../lib/supabase-client';
import {
  applyTheme,
  parseTheme,
  readThemeCookieClient,
  watchSystemTheme,
  writeThemeCookie,
} from '../lib/theme';

export function ThemeSync(props: { me: () => MeProfile | null }) {
  onSettled(() => {
    if (isServer) return;

    // The effective choice: the database value once signed in, the cookie
    // otherwise (pre-hydration the inline head script already applied it).
    const choice = () => parseTheme(props.me()?.theme) ?? readThemeCookieClient();

    // Hydration correction: the DB is the source of truth. If this device's
    // cookie is stale (first sign-in here, or changed elsewhere while away),
    // apply the database theme and refresh the cookie.
    const profile = props.me();
    const dbTheme = profile ? parseTheme(profile.theme) : null;
    if (dbTheme && dbTheme !== readThemeCookieClient()) {
      applyTheme(dbTheme);
      writeThemeCookie(dbTheme);
    }

    // OS preference flips only matter while the choice is "system".
    const stopSystemWatcher = watchSystemTheme(() => applyTheme(choice()));

    // Realtime: our own profile row. Theme changes from other devices apply
    // instantly; any profile change refreshes `me` (name/avatar in the nav).
    let channel: RealtimeChannel | null = null;
    const client = browserClient();
    if (client && profile) {
      void (async () => {
        // Load the session before subscribing — otherwise the socket joins
        // anonymously and RLS filters the stream (the boardStream lesson).
        const {
          data: { user },
        } = await client.auth.getUser();
        if (!user) return;
        channel = client.channel(`theme-${user.id}`);
        channel
          .on(
            'postgres_changes',
            {
              event: 'UPDATE',
              schema: 'public',
              table: 'profiles',
              filter: `id=eq.${user.id}`,
            },
            (payload) => {
              const row = payload.new as { theme?: string };
              const theme = parseTheme(row.theme);
              if (theme && theme !== readThemeCookieClient()) {
                applyTheme(theme);
                writeThemeCookie(theme);
              }
              revalidate('me');
            },
          )
          .subscribe();
      })();
    }

    return () => {
      stopSystemWatcher();
      if (channel && client) void client.removeChannel(channel);
    };
  });

  return null;
}

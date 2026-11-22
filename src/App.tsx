import { Title } from '@solidjs/meta';
import { Loading, Show, createMemo, onSettled } from 'solid-js';
// Typed client env, validated and baked in at build time (see env.ts).
import { env } from 'virtual:solid-env/client';
import { paths, Router } from './router';
import { getMe } from './lib/auth';
import { ThemeSync } from './components/ThemeSync';
import { UserMenu } from './components/UserMenu';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { NotificationFeed } from './components/NotificationFeed';
import { NotificationBell } from './components/NotificationBell';
import { PushSetup } from './components/PushSetup';
import './app.css';

export default function App() {
  return (
    <Router>
      {(props) => {
        // query() reads the router cache, so the memo must live inside the
        // Router context — App's body is outside it.
        const me = createMemo(() => getMe());
        return (
          <>
            <Title>{env.VITE_APP_NAME}</Title>
            <ThemeSync me={me} />
            <nav class="sticky top-0 z-40 flex h-12 items-center justify-between border-b border-neutral-200 bg-white/80 px-4 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
              <a href={paths()} class="flex items-center gap-2">
                <span class="flex h-5 w-5 items-center justify-center rounded bg-indigo-600 text-[11px] font-bold text-white">
                  F
                </span>
                <span class="text-sm font-semibold tracking-tight">Flowdeck</span>
              </a>
              <WorkspaceSwitcher />
              {/* The auth area reads getMe() — a pending read — so it sits
                  inside its own hold rather than the page-level one. */}
              <Loading fallback={<span />}>
                <Show
                  when={me()}
                  fallback={
                    <a
                      href={paths['sign-in']()}
                      class="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
                    >
                      Sign in
                    </a>
                  }
                >
                  {(profile) => (
                    <span class="flex items-center gap-2">
                      <NotificationBell />
                      <UserMenu profile={profile} />
                    </span>
                  )}
                </Show>
              </Loading>
            </nav>
            <Loading fallback={<main class="p-6 text-sm text-neutral-400">Loading…</main>}>
              {props.children}
            </Loading>
            <Show when={me()}>
              <NotificationFeed />
              <PushSetup />
            </Show>
          </>
        );
      }}
    </Router>
  );
}

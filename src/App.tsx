import { Title } from '@solidjs/meta';
import { Loading, Show, createMemo } from 'solid-js';
// Typed client env, validated and baked in at build time (see env.ts).
import { env } from 'virtual:solid-env/client';
import { paths, Router } from './router';
import { getMe, signOut } from './lib/auth';
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
          <nav class="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
            <a href={paths()} class="text-sm font-semibold tracking-tight">
              Flowdeck
            </a>
            {/* The auth area reads getMe() — a pending read — so it sits
                inside its own hold rather than the page-level one. */}
            <Loading fallback={<span />}>
              <Show
                when={me()}
                fallback={
                  <a
                    href={paths['sign-in']()}
                    class="text-sm text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white"
                  >
                    Sign in
                  </a>
                }
              >
                {(profile) => (
                  <div class="flex items-center gap-3 text-sm">
                    <span class="text-neutral-500 dark:text-neutral-400">
                      {profile().email}
                    </span>
                    <form action={signOut} method="post">
                      <button
                        type="submit"
                        class="text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white"
                      >
                        Sign out
                      </button>
                    </form>
                  </div>
                )}
              </Show>
            </Loading>
          </nav>
          <Loading fallback={<main>Loading…</main>}>{props.children}</Loading>
        </>
        );
      }}
    </Router>
  );
}

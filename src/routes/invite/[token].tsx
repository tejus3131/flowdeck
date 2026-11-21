// The invite acceptance page: /invite/<token>. Signed-out visitors are
// sent to sign-in with `next` pointing back here (the server function
// throws that redirect itself); signed-in ones join the workspace and land
// on the dashboard — already switched to it.
import { Title } from '@solidjs/meta';
import { useNavigate } from '@solidjs/router';
import { revalidate } from '@solidjs/router';
import type { RouteProps } from '@solidjs/router';
import { Show, createSignal, onSettled } from 'solid-js';

import { acceptInvite } from '../../lib/workspaces';

export default function AcceptInvite(props: RouteProps<'/invite/:token'>) {
  const navigate = useNavigate();
  const [error, setError] = createSignal<string | null>(null);

  onSettled(() => {
    void (async () => {
      try {
        // A redirect carrier (e.g. "sign in first, with next") is applied
        // by the router and the call RESOLVES with no payload — only a
        // real acceptance returns { workspaceId }, and only that navigates.
        const result = (await acceptInvite(props.params.token)) as
          | { workspaceId?: string }
          | null
          | undefined;
        if (result?.workspaceId) {
          // Joined + this device's workspace cookie switched. Refresh the
          // workspace list (the "current" flag reads the cookie) and land
          // on the dashboard.
          revalidate('workspaces');
          navigate('/');
        }
      } catch (err) {
        // Genuine failures only — redirects resolved above.
        setError(err instanceof Error ? err.message : 'Could not accept the invitation');
      }
    })();
  });

  return (
    <main class="mx-auto flex min-h-[80vh] max-w-sm flex-col justify-center px-4">
      <Title>Invitation - Flowdeck</Title>
      <div class="rounded-2xl border border-neutral-200 bg-white p-6 text-center shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <Show
          when={!error()}
          fallback={
            <>
              <p class="text-lg font-semibold">Invitation problem</p>
              <p role="alert" class="mt-2 text-sm text-red-600 dark:text-red-400">
                {error()}
              </p>
              <p class="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
                Ask an admin to resend it — links can be used only once.
              </p>
              <a
                href="/"
                class="mt-5 inline-block rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
              >
                Go to Flowdeck
              </a>
            </>
          }
        >
          <p class="text-lg font-semibold">Joining…</p>
          <p class="mt-2 animate-pulse text-sm text-neutral-400">Accepting your invitation</p>
        </Show>
      </div>
    </main>
  );
}

// The MCP consent page — the browser half of the OAuth-style flow
// (card #16). An MCP client that supports OAuth opens this page with
// client_id, redirect_uri, a PKCE S256 challenge, and its state; after
// sign-in the user sees exactly who is asking and what a token means
// before Allow hands back a single-use authorization code.
import { Title } from '@solidjs/meta';
import { useSearchParams } from '@solidjs/router';
import { For, Show, createEffect, createSignal } from 'solid-js';

import { MembershipWatch } from '../../components/MembershipWatch';
import { approveMcpClient, listMyWorkspaceChoices } from '../../lib/mcp-auth';

export default function McpAuthorizePage() {
  const [params] = useSearchParams();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [denied, setDenied] = createSignal(false);
  const [workspaces, setWorkspaces] = createSignal<{ id: string; name: string; role: string }[]>([]);
  const [selected, setSelected] = createSignal<string[]>([]);
  const [loaded, setLoaded] = createSignal(false);

  // Offer the compartmentalization: scope the connection to specific
  // workspaces, loaded once the request shape is valid.
  createEffect(
    () => valid(),
    (ok) => {
      if (!ok || loaded()) return;
      setLoaded(true);
      void listMyWorkspaceChoices().then((list) => {
        setWorkspaces(list);
        // One workspace = preselect it. More = start with none (the user
        // picks, or explicitly grants the whole account).
        if (list.length === 1) setSelected([list[0]!.id]);
      });
    },
  );

  const clientId = () => String(params.client_id ?? '').trim();
  const redirectUri = () => String(params.redirect_uri ?? '').trim();
  const codeChallenge = () => String(params.code_challenge ?? '').trim();
  const challengeMethod = () => String(params.code_challenge_method ?? 'S256').trim();
  const state = () => (params.state ? String(params.state) : null);

  // The visible host of the callback — that is what a user can reason
  // about ("is this really my local Cursor?").
  const redirectHost = () => {
    try {
      return new URL(redirectUri()).host || redirectUri();
    } catch {
      return redirectUri();
    }
  };

  const valid =
    clientId().length > 0 &&
    redirectUri().length > 0 &&
    codeChallenge().length > 0 &&
    challengeMethod() === 'S256';

  const allow = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy() || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const { redirectTo } = await approveMcpClient({
        clientId: clientId(),
        redirectUri: redirectUri(),
        codeChallenge: codeChallenge(),
        challengeMethod: challengeMethod(),
        state: state(),
        workspaceIds: selected(),
      });
      window.location.href = redirectTo;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setBusy(false);
    }
  };

  const deny = () => {
    setDenied(true);
    // No code is ever minted: the client's own timeout handles a denied
    // request. (OAuth spec allows error=access_denied on the callback,
    // but only when we can trust the redirect target — an explicit code
    // mint is safer than honoring arbitrary redirect_uri's with errors.)
  };

  return (
    <main class="mx-auto max-w-xl px-4 py-10">
      <MembershipWatch />
      <Title>Authorize agent — Flowdeck</Title>
      <p class="text-xs font-semibold uppercase tracking-wider text-indigo-500">
        Connect your AI agent
      </p>
      <h1 class="mt-1 text-2xl font-bold tracking-tight">
        <span class="font-mono">{clientId() || 'Unknown client'}</span> wants access
      </h1>

      <Show
        when={valid}
        fallback={
          <p role="alert" class="mt-6 rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            This authorization request is incomplete or invalid. Ask the client to restart the
            connection.
          </p>
        }
      >
        <div class="mt-6 space-y-3 rounded-2xl border border-neutral-200 p-5 text-sm dark:border-neutral-800">
          <p class="leading-relaxed text-neutral-600 dark:text-neutral-300">
            This agent will be able to act <strong>as you</strong> in Flowdeck: read and edit your
            boards, cards, comments and chats, manage your teams and notifications — everything you
            can do, under the same permissions. You can revoke it any time on your{' '}
            <a href="/profile" class="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              Profile → API tokens
            </a>{' '}
            page.
          </p>
          <p class="text-neutral-500 dark:text-neutral-400">
            Callback host: <span class="font-mono">{redirectHost()}</span>
          </p>
          <Show when={workspaces().length > 0}>
            <div class="border-t border-neutral-200 pt-3 dark:border-neutral-800">
              <p class="mb-2 font-medium">Workspace access</p>
              <p class="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
                Limit this connection to specific workspaces — recommended when the agent serves
                one project. Nothing selected means your whole account.
              </p>
              <div class="flex flex-col gap-1.5">
                <For each={workspaces()}>
                  {(ws) => (
                    <label class="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selected().includes(ws.id)}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.currentTarget.checked
                              ? [...current, ws.id]
                              : current.filter((id) => id !== ws.id),
                          )
                        }
                      />
                      {ws.name} <span class="text-xs text-neutral-400">({ws.role})</span>
                    </label>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>

        <Show when={error()}>
          <p role="alert" class="mt-4 rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error()}{' '}
            <Show when={error()?.includes('sign in')}>
              <a href="/sign-in" class="font-semibold underline">
                Sign in
              </a>
            </Show>
          </p>
        </Show>

        <Show when={denied()}>
          <p class="mt-4 rounded-xl bg-neutral-100 p-4 text-sm text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
            Request denied. You can close this tab — the client will time out on its own.
          </p>
        </Show>

        <div class="mt-6 flex gap-3">
          <Show when={!denied()}>
            <button
              type="button"
              class="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              onClick={allow}
              disabled={busy()}
            >
              {busy() ? 'Connecting…' : 'Allow access'}
            </button>
            <button
              type="button"
              class="flex-1 rounded-xl border border-neutral-300 px-4 py-2.5 text-sm font-semibold text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
              onClick={deny}
            >
              Deny
            </button>
          </Show>
        </div>
      </Show>

      <p class="mt-8 text-xs text-neutral-400">
        Flowdeck authorizes MCP clients with the OAuth flow (PKCE S256): the code this page issues
        only works once, and the token it becomes is stored hashed, exactly like a personal access
        token.
      </p>
    </main>
  );
}

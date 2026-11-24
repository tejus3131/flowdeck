// The MCP consent page — the browser half of the OAuth-style flow
// (card #16). An MCP client that supports OAuth opens this page with
// client_id, redirect_uri, a PKCE S256 challenge, and its state; after
// sign-in the user sees exactly who is asking and what a token means
// before Allow hands back a single-use authorization code.
import { Title } from '@solidjs/meta';
import { useSearchParams } from '@solidjs/router';
import { For, Show, createEffect, createSignal } from 'solid-js';

import { MembershipWatch } from '../../components/MembershipWatch';
import {
  DEFAULT_TOOL_OPS,
  TOOL_CATEGORIES,
  approveMcpClient,
  listMyWorkspaceChoices,
  mcpAuthSignedIn,
} from '../../lib/mcp-auth';

export default function McpAuthorizePage() {
  const [params] = useSearchParams();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [denied, setDenied] = createSignal(false);
  const [workspaces, setWorkspaces] = createSignal<{ id: string; name: string; role: string }[]>([]);
  const [selected, setSelected] = createSignal<string[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [signedIn, setSignedIn] = createSignal<boolean | null>(null);
  const [hostConfirm, setHostConfirm] = createSignal('');
  // Non-loopback callbacks are a phishing surface (an attacker can start
  // a flow with their own redirect_uri); the user must TYPE the host to
  // enable Allow. Loopback is exempt (local clients).
  const loopback = () => {
    try {
      const host = new URL(redirectUri()).hostname;
      return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    } catch {
      return false;
    }
  };
  const hostConfirmed = () => loopback() || hostConfirm().trim() === redirectHost();
  // Tool permissions: the SAFE default (read + profile + inbox) is the
  // starting state; writing/administering categories are opt-in, and
  // "everything" is an explicit full-power grant.
  const [grantedCategories, setGrantedCategories] = createSignal<string[]>(
    TOOL_CATEGORIES.filter((category) => category.defaultOn).map((category) => category.id),
  );
  const [grantAll, setGrantAll] = createSignal(false);

  // Signed-out gate: render the sign-in panel instead of a consent UI
  // that only fails later on Allow.
  createEffect(
    () => valid(),
    (ok) => {
      if (!ok || signedIn() !== null) return;
      void mcpAuthSignedIn().then(setSignedIn);
    },
  );

  // Offer the compartmentalization: scope the connection to specific
  // workspaces, loaded once the request shape is valid and signed in.
  createEffect(
    () => valid() && signedIn() === true,
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

  const valid = () =>
    clientId().length > 0 &&
    redirectUri().length > 0 &&
    codeChallenge().length > 0 &&
    challengeMethod() === 'S256';

  const allow = async () => {
    if (busy() || !valid() || !hostConfirmed()) return;
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
        toolCategories: grantAll() ? ['*'] : grantedCategories(),
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

      <Show when={valid() && signedIn() === null}>
        <div class="mt-6 rounded-2xl border border-neutral-200 p-6 text-center dark:border-neutral-800">
          <p class="text-sm text-neutral-600 dark:text-neutral-300">Checking your session…</p>
        </div>
      </Show>
      <Show when={valid() && signedIn() === false}>
        <div class="mt-6 rounded-2xl border border-neutral-200 p-6 text-center dark:border-neutral-800">
          <p class="text-sm text-neutral-600 dark:text-neutral-300">
            You need to sign in to authorize an agent.
          </p>
          <a
            href="/sign-in"
            class="mt-3 inline-block rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            Sign in
          </a>
        </div>
      </Show>
      <Show
        when={valid() && signedIn() === true}
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
          <div class="border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <p class="mb-2 font-medium">What the agent can do</p>
            <label class="mb-2 flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={grantAll()}
                onChange={(event) => setGrantAll(event.currentTarget.checked)}
              />
              Everything (full power — not recommended)
            </label>
            <Show when={!grantAll()}>
              <div class="flex flex-col gap-1.5">
                <For each={TOOL_CATEGORIES}>
                  {(category) => (
                    <label class="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        class="mt-1"
                        checked={grantedCategories().includes(category.id)}
                        onChange={(event) =>
                          setGrantedCategories((current) =>
                            event.currentTarget.checked
                              ? [...current, category.id]
                              : current.filter((id) => id !== category.id),
                          )
                        }
                      />
                      <span>
                        {category.label}{' '}
                        <span class="block text-xs text-neutral-400">{category.description}</span>
                      </span>
                    </label>
                  )}
                </For>
              </div>
            </Show>
            <p class="mt-2 text-xs text-neutral-400">
              {grantAll() ? 'The agent gets every tool.' : `${DEFAULT_TOOL_OPS.length > 0 ? 'Granted: ' : ''}${grantedCategories().join(', ')}`}
            </p>
          </div>
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

        <Show when={!loopback()}>
          <div class="border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <p class="mb-2 text-sm font-medium">Confirm the callback host</p>
            <p class="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
              This client is redirecting somewhere other than your machine. To make sure the
              authorization code isn't shipped to a lookalike, type{' '}
              <span class="font-mono font-semibold">{redirectHost()}</span> to enable Allow.
            </p>
            <input
              value={hostConfirm()}
              onInput={(event) => setHostConfirm(event.currentTarget.value)}
              placeholder={redirectHost()}
              class="font-mono"
            />
          </div>
        </Show>

        <div class="mt-6 flex gap-3">
          <Show when={!denied()}>
            <button
              type="button"
              class="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              onClick={allow}
              disabled={busy() || !hostConfirmed()}
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

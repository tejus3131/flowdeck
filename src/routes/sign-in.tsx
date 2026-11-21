import { Title } from '@solidjs/meta';
import { useNavigate, useSearchParams } from '@solidjs/router';
import { Show, createSignal } from 'solid-js';

import { checkEmail, signIn } from '../lib/auth';
import { browserClient } from '../lib/supabase-client';

/**
 * The sign-in flow:
 *   - Passkey is the DEFAULT for returning users: the email field opts into
 *     WebAuthn Conditional UI (the browser offers saved passkeys as
 *     autofill), and the passkey button works with no email at all.
 *   - New emails get a magic link (one-time; the account is created on
 *     first sign-in and the app immediately prompts to add a passkey).
 *   - "Email me a link" is always available as the fallback.
 * Without JavaScript the form falls back to the magic-link server action.
 */
export default function SignIn() {
  const [search] = useSearchParams<{ sent?: string; error?: string }>();
  const navigate = useNavigate();
  const [busy, setBusy] = createSignal<false | 'check' | 'passkey' | 'link'>(false);
  const [notice, setNotice] = createSignal<string | null>(null);

  let form: HTMLFormElement | undefined;

  const sendMagicLink = () => {
    setBusy('link');
    form?.requestSubmit();
  };

  const usePasskey = async () => {
    const client = browserClient();
    if (!client) {
      setNotice('Passkeys are unavailable — email a link instead.');
      return;
    }
    setBusy('passkey');
    setNotice(null);
    const { error } = await client.auth.signInWithPasskey({
      // "modal" is a spec-valid mediation value; TS's DOM lib lags behind it.
      options: { mediation: 'modal' as CredentialMediationRequirement },
    });
    setBusy(false);
    if (error) {
      setNotice(error.message);
      return;
    }
    // The ceremony wrote the session cookies; go home signed in.
    navigate('/');
  };

  const onSubmit = async (event: SubmitEvent) => {
    // The no-JS fallback: let the form post the magic-link server action.
    event.preventDefault();
    const target = event.currentTarget;
    if (!(target instanceof HTMLFormElement)) return;
    const email = String(new FormData(target).get('email') ?? '').trim();
    if (!email) return;

    setBusy('check');
    setNotice(null);
    try {
      const status = await checkEmail(email);
      if (status.exists && status.hasPasskey) {
        // Returning user: the passkey ceremony is the default.
        await usePasskey();
      } else {
        // New user (or no passkey yet): magic link.
        sendMagicLink();
      }
    } catch (error) {
      setBusy(false);
      setNotice(error instanceof Error ? error.message : 'Something went wrong');
    }
  };

  return (
    <main class="mx-auto flex min-h-[80vh] max-w-sm flex-col justify-center px-4">
      <Title>Sign in - Flowdeck</Title>
      <div class="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h1 class="text-xl font-semibold tracking-tight">Welcome to Flowdeck</h1>

        <Show
          when={!search.sent}
          fallback={
            <div class="mt-6 rounded-lg bg-indigo-50 px-3 py-3 text-sm text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
              <p class="font-medium">Check your inbox</p>
              <p class="mt-1">We sent a sign-in link. It's valid for one hour.</p>
            </div>
          }
        >
          <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Passwordless: passkeys by default, a one-time email link for new accounts.
          </p>

          <form ref={form} action={signIn} method="post" class="mt-6 flex flex-col gap-3" onSubmit={onSubmit}>
            <label class="text-sm font-medium" for="email">
              Email
            </label>
            <input
              // WebAuthn Conditional UI: the browser offers saved passkeys
              // as autofill on this field.
              autocomplete="username webauthn"
              id="email"
              name="email"
              type="email"
              required
              placeholder="you@example.com"
            />
            <Show when={search.error || notice()}>
              <p
                class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950 dark:text-red-400"
                role="alert"
              >
                {search.error || notice()}
              </p>
            </Show>
            <button
              type="submit"
              disabled={busy() !== false}
              class="mt-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
            >
              {busy() === 'check' ? 'Checking…' : busy() === 'passkey' ? 'Waiting for your passkey…' : 'Continue'}
            </button>
          </form>

          <div class="mt-4 flex items-center gap-3">
            <span class="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
            <span class="text-xs text-neutral-400">or</span>
            <span class="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
          </div>

          <button
            type="button"
            disabled={busy() !== false}
            class="mt-4 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm font-semibold hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
            onClick={() => void usePasskey()}
          >
            🔑 Sign in with a passkey
          </button>
          <button
            type="button"
            class="mt-2 w-full rounded-lg px-3 py-2 text-xs font-medium text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
            onClick={() => {
              const email = String(new FormData(form!).get('email') ?? '').trim();
              if (email) sendMagicLink();
              else setNotice('Enter your email first.');
            }}
          >
            Email me a one-time link instead
          </button>
        </Show>
      </div>
      <p class="mt-4 text-center text-xs text-neutral-400">
        Sessions persist — you won't need a new link every visit.
      </p>
    </main>
  );
}

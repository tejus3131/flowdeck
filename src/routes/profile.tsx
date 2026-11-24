import { Title } from '@solidjs/meta';
import { revalidate, useNavigate } from '@solidjs/router';
import type { JSX } from '@solidjs/web';
import { For, Show, createMemo, createSignal, onSettled } from 'solid-js';

import { Avatar } from '../components/Avatar';
import { PasskeyPrompt } from '../components/PasskeyPrompt';
import { MembershipWatch } from '../components/MembershipWatch';
import { ThemePicker } from '../components/ThemePicker';
import { deleteAccount, getMe } from '../lib/auth';
import { uploadAvatar } from '../lib/avatar';
import { addPasskey } from '../lib/passkey';
import { setAvatarUrl, updateProfile } from '../lib/profile';
import { createApiToken, getMyTokens, revokeApiToken } from '../lib/tokens';
import { parseTheme } from '../lib/theme';
import { getMyStatus, setWorkHours } from '../lib/status';
import { errorMessage } from '../lib/error-message';

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <section class="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-neutral-400">{props.title}</h2>
      <div class="mt-4">{props.children}</div>
    </section>
  );
}

/** Work hours — when set, notifications outside the window narrow to
 *  direct mentions (statuses and DND live in the account menu). */
function WorkHoursSection() {
  const [start, setStart] = createSignal('');
  const [end, setEnd] = createSignal('');
  const [days, setDays] = createSignal<number[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);

  const DAYS: { value: number; label: string }[] = [
    { value: 1, label: 'Mon' },
    { value: 2, label: 'Tue' },
    { value: 3, label: 'Wed' },
    { value: 4, label: 'Thu' },
    { value: 5, label: 'Fri' },
    { value: 6, label: 'Sat' },
    { value: 7, label: 'Sun' },
  ];

  onSettled(() => {
    void getMyStatus().then((status) => {
      setStart(status.workStart ?? '');
      setEnd(status.workEnd ?? '');
      setDays(status.workdays);
      setLoaded(true);
    });
  });

  const toggleDay = (day: number) => {
    setDays((current) =>
      current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort(),
    );
  };

  const save = async () => {
    if (busy()) return;
    setBusy(true);
    setSaved(false);
    try {
      const valid = /^\d{2}:\d{2}$/.test(start()) && /^\d{2}:\d{2}$/.test(end());
      await setWorkHours(
        valid && start() && end()
          ? { start: start(), end: end(), workdays: days().length > 0 ? days() : [1, 2, 3, 4, 5] }
          : { start: null, end: null, workdays: [1, 2, 3, 4, 5] },
      );
      setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Work hours">
      <p class="text-sm text-neutral-500 dark:text-neutral-400">
        During work hours you get all notifications; outside them only direct mentions toast
        (everything still lands in the bell). Leave empty for notifications around the clock.
      </p>
      <Show when={loaded()}>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="time"
            class="rounded-lg border border-neutral-200 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            value={start()}
            onInput={(event) => setStart(event.currentTarget.value)}
          />
          <span class="text-xs text-neutral-400">to</span>
          <input
            type="time"
            class="rounded-lg border border-neutral-200 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            value={end()}
            onInput={(event) => setEnd(event.currentTarget.value)}
          />
          <span class="ml-1 flex flex-wrap gap-1">
            <For each={DAYS}>
              {(day) => (
                <button
                  type="button"
                  class={`rounded-lg px-2 py-1 text-[11px] font-medium ${
                    days().includes(day.value)
                      ? 'bg-indigo-600 text-white'
                      : 'bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
                  }`}
                  onClick={() => toggleDay(day.value)}
                >
                  {day.label}
                </button>
              )}
            </For>
          </span>
          <button
            type="button"
            disabled={busy()}
            class="ml-auto rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            onClick={() => void save()}
          >
            {busy() ? 'Saving…' : 'Save hours'}
          </button>
        </div>
        <Show when={saved()}>
          <p class="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">Saved ✓</p>
        </Show>
      </Show>
    </Section>
  );
}

export default function ProfilePage() {
  const me = createMemo(() => getMe());
  const navigate = useNavigate();

  // ── profile form ──────────────────────────────────────────────────────
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      // A mutation revalidates the route queries — `me` refreshes itself.
      const data = new FormData(form);
      await updateProfile({
        displayName: String(data.get('display_name') ?? ''),
      });
      setSaved(true);
    } catch (error) {
      setSaveError(errorMessage(error, 'Could not save your profile'));
    } finally {
      setSaving(false);
    }
  };

  // ── avatar ─────────────────────────────────────────────────────────────
  let fileInput: HTMLInputElement | undefined;
  const [avatarBusy, setAvatarBusy] = createSignal(false);
  const [avatarError, setAvatarError] = createSignal<string | null>(null);

  const onFile = async (event: Event) => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    const profile = me();
    if (!file || !profile) return;
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const url = await uploadAvatar(profile.id, file);
      await setAvatarUrl(url); // mutation → revalidates `me`
    } catch (error) {
      setAvatarError(errorMessage(error, 'Upload failed — try again'));
    } finally {
      setAvatarBusy(false);
      input.value = ''; // lets picking the same file retry
    }
  };

  const removeAvatar = async () => {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      await setAvatarUrl(null);
    } catch (error) {
      setAvatarError(errorMessage(error, 'Could not remove the picture'));
    } finally {
      setAvatarBusy(false);
    }
  };

  // ── passkey ────────────────────────────────────────────────────────────
  const [passkeyBusy, setPasskeyBusy] = createSignal(false);  const [passkeyError, setPasskeyError] = createSignal<string | null>(null);

  // ── API tokens (MCP) ──────────────────────────────────────────────────────
  const tokens = createMemo(() => getMyTokens());
  const [tokenName, setTokenName] = createSignal('');
  const [tokenBusy, setTokenBusy] = createSignal(false);
  const [freshToken, setFreshToken] = createSignal<string | null>(null);
  const [tokenError, setTokenError] = createSignal<string | null>(null);
  const [copiedToken, setCopiedToken] = createSignal(false);

  const mint = async (event: SubmitEvent) => {
    event.preventDefault();
    setTokenBusy(true);
    setTokenError(null);
    setFreshToken(null);
    setCopiedToken(false);
    try {
      const result = await createApiToken(tokenName());
      setTokenName('');
      setFreshToken(result.token); // shown exactly once
      revalidate('my-tokens');
    } catch (err) {
      setTokenError(errorMessage(err, 'Could not create the token'));
    } finally {
      setTokenBusy(false);
    }
  };

  const copyToken = async () => {
    const value = freshToken();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedToken(true);
    } catch {
      setTokenError('Could not copy — select the token text instead.');
    }
  };

  const revoke = async (tokenId: string) => {
    setTokenError(null);
    try {
      await revokeApiToken(tokenId);
      revalidate('my-tokens');
    } catch (err) {
      setTokenError(errorMessage(err, 'Could not revoke the token'));
    }
  };

  const addPass = async () => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    const result = await addPasskey();
    setPasskeyBusy(false);
    if (!result.ok) {
      setPasskeyError(result.error ?? 'Passkey registration failed — try again.');
      return;
    }
    revalidate('me'); // client-side-only change; the flag lives in the DB
  };

  // ── delete account ────────────────────────────────────────────────────
  const [confirmDelete, setConfirmDelete] = createSignal<'idle' | 'confirm'>('idle');
  const [deleteWord, setDeleteWord] = createSignal('');
  const [deleting, setDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);

  const deleteAccountNow = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAccount();
      // The server cleared the (now invalid) session cookies; make sure no
      // cached view of the account lingers, then land signed-out.
      revalidate('me');
      navigate('/');
    } catch (err) {
      setDeleteError(errorMessage(err, 'Could not delete the account'));
      setDeleting(false);
    }
  };
  return (
    <main class="mx-auto max-w-2xl px-4 py-10">
      <MembershipWatch />
      <Title>Profile - Flowdeck</Title>
      <h1 class="text-2xl font-semibold tracking-tight">Your profile</h1>

      <Show
        when={me()}
        fallback={
          <p class="mt-8 text-sm text-neutral-500 dark:text-neutral-400">
            <a href="/sign-in" class="font-medium text-indigo-600 underline dark:text-indigo-400">
              Sign in
            </a>{' '}
            to edit your profile.
          </p>
        }
      >
        {(profile) => (
          <div class="mt-6 space-y-5">
            <PasskeyPrompt profile={profile} />

            <Section title="Picture &amp; name">
              <div class="flex flex-col gap-5 sm:flex-row sm:items-center">
                <div class="relative shrink-0">
                  <Avatar src={profile().avatar_url} name={profile().display_name} email={profile().email} size="lg" />
                  <Show when={avatarBusy()}>
                    <span class="absolute inset-0 flex items-center justify-center rounded-full bg-neutral-950/40 text-xs font-medium text-white">
                      …
                    </span>
                  </Show>
                </div>
                <div class="space-y-2">
                  <div class="flex gap-2">
                    <button
                      type="button"
                      disabled={avatarBusy()}
                      class="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
                      onClick={() => fileInput?.click()}
                    >
                      {profile().avatar_url ? 'Change picture' : 'Upload a picture'}
                    </button>
                    <Show when={profile().avatar_url}>
                      <button
                        type="button"
                        disabled={avatarBusy()}
                        class="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-500 hover:text-red-500 disabled:opacity-60"
                        onClick={() => void removeAvatar()}
                      >
                        Remove
                      </button>
                    </Show>
                  </div>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/*"
                    class="hidden"
                    onChange={(event) => void onFile(event)}
                  />
                  <p class="text-xs text-neutral-400">PNG, JPG or WebP — cropped to a square automatically.</p>
                  <Show when={avatarError()}>
                    <p role="alert" class="text-sm text-red-600 dark:text-red-400">
                      {avatarError()}
                    </p>
                  </Show>
                </div>
              </div>

              <form class="mt-6 flex flex-col gap-4" onSubmit={save}>
                <label class="flex flex-col gap-1.5 text-sm font-medium">
                  Display name
                  <input
                    name="display_name"
                    defaultValue={profile().display_name ?? ''}
                    placeholder="Ada Lovelace"
                    maxlength="80"
                  />
                  <span class="text-xs font-normal text-neutral-400">
                    This is what teammates see — and how @mentions label you.
                  </span>
                </label>
                <div class="flex items-center gap-3">
                  <button
                    type="submit"
                    disabled={saving()}
                    class="w-fit rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
                  >
                    {saving() ? 'Saving…' : 'Save changes'}
                  </button>
                  <Show when={saved() && !saveError()}>
                    <span class="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                      Saved ✓
                    </span>
                  </Show>
                  <Show when={saveError()}>
                    <p role="alert" class="text-sm text-red-600 dark:text-red-400">
                      {saveError()}
                    </p>
                  </Show>
                </div>
              </form>
            </Section>

            <Section title="Theme">
              <p class="-mt-1 mb-3 text-sm text-neutral-500 dark:text-neutral-400">
                Defaults to your system, follows you across devices, and switches everywhere
                instantly.
              </p>
              <ThemePicker theme={() => parseTheme(profile().theme) ?? 'system'} />
            </Section>

            <Section title="API tokens">
              <p class="-mt-1 mb-3 text-sm text-neutral-500 dark:text-neutral-400">
                Connect AI agents. Tokens act as your account —
                everything the web app can do, and nothing more.
              </p>
              <form class="flex flex-col gap-2 sm:flex-row" onSubmit={mint}>
                <input
                  placeholder="Token name (e.g. laptop CLI)"
                  value={tokenName()}
                  onInput={(e) => setTokenName(e.currentTarget.value)}
                  class="flex-1"
                  maxlength="60"
                />
                <button
                  type="submit"
                  disabled={tokenBusy()}
                  class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
                >
                  {tokenBusy() ? 'Creating…' : 'Create token'}
                </button>
              </form>
              <Show when={tokenError()}>
                <p role="alert" class="mt-2 text-sm text-red-600 dark:text-red-400">
                  {tokenError()}
                </p>
              </Show>
              <Show when={freshToken()}>
                <div class="mt-3 flex flex-col gap-2 rounded-lg bg-amber-50 px-3 py-2 dark:bg-amber-950">
                  <p class="text-sm font-medium text-amber-800 dark:text-amber-200">
                    Copy this token now — it will never be shown again:
                  </p>
                  <div class="flex items-center gap-2">
                    <code class="flex-1 truncate rounded bg-white px-2 py-1 text-xs dark:bg-neutral-900">
                      {freshToken()}
                    </code>
                    <button
                      type="button"
                      class="shrink-0 rounded-lg bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-200 dark:bg-amber-900 dark:text-amber-200"
                      onClick={() => void copyToken()}
                    >
                      {copiedToken() ? 'Copied ✓' : 'Copy'}
                    </button>
                  </div>
                </div>
              </Show>
              <Show when={tokens().length > 0}>
                <ul class="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">
                  <For each={tokens()}>
                    {(token) => (
                      <li class="flex items-center gap-3 py-2.5 text-sm">
                        <span class="min-w-0 flex-1">
                          <span class="block truncate font-medium">{token.name}</span>
                          <span class="block text-xs text-neutral-400">
                            created {new Date(token.created_at).toLocaleDateString()}
                            {token.last_used_at
                              ? ` · last used ${new Date(token.last_used_at).toLocaleDateString()}`
                              : ' · never used'}
                          </span>
                        </span>
                        <button
                          type="button"
                          class="rounded-lg px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                          onClick={() => void revoke(token.id)}
                        >
                          Revoke
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Section>

            <Section title="Passkey">
              <Show
                when={profile().has_passkey}
                fallback={
                  <div class="flex flex-col gap-2">
                    <p class="text-sm text-neutral-500 dark:text-neutral-400">
                      Add a passkey (Face&nbsp;ID, Touch&nbsp;ID, Windows&nbsp;Hello, or a security
                      key) to sign in without email links.
                    </p>
                    <button
                      type="button"
                      disabled={passkeyBusy()}
                      class="w-fit rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
                      onClick={() => void addPass()}
                    >
                      {passkeyBusy() ? 'Waiting for your device…' : 'Add a passkey'}
                    </button>
                    <Show when={passkeyError()}>
                      <p role="alert" class="text-sm text-red-600 dark:text-red-400">
                        {passkeyError()}
                      </p>
                    </Show>
                  </div>
                }
              >
                <p class="text-sm text-emerald-600 dark:text-emerald-400">
                  ✓ A passkey is set up — you can sign in with it on this device and any you add
                  it to.
                </p>
              </Show>
            </Section>

            {/* ── work hours + agents ────────────────────────────── */}
            <WorkHoursSection />

            <Section title="Agents &amp; docs">
              <p class="text-sm text-neutral-500 dark:text-neutral-400">
                Connect AI agents (Claude, Cursor, your own) to your Flowdeck — they see and manage
                exactly what your account can, under the same permissions. Create a token above,
                then follow the guides.
              </p>
              <div class="mt-3 flex flex-wrap gap-2">
                <a
                  href="/docs/mcp"
                  class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                >
                  MCP connection docs
                </a>
              </div>
            </Section>

            <p class="text-xs text-neutral-400">
              Signed in as {profile().email} · member since{' '}
              {new Date(profile().created_at).toLocaleDateString(undefined, {
                month: 'long',
                year: 'numeric',
              })}
            </p>

            {/* ── danger zone ─────────────────────────────────────── */}
            <section class="rounded-2xl border border-red-200 bg-white p-5 dark:border-red-900 dark:bg-neutral-900">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-red-500 dark:text-red-400">
                Danger zone
              </h2>
              <div class="mt-4 flex flex-col gap-3">
                <div>
                  <p class="text-sm font-medium">Delete your account</p>
                  <p class="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
                    Removes the account, your profile, boards you own and any workspace you're the
                    only member of. Workspaces you own with other people must be transferred
                    first. This cannot be undone.
                  </p>
                </div>
                <Show
                  when={confirmDelete() === 'idle'}
                  fallback={
                    <div class="flex flex-col gap-2">
                      <p class="text-sm text-red-600 dark:text-red-400">
                        Type <span class="font-mono font-semibold">delete</span> to confirm —
                        everything you own is removed permanently.
                      </p>
                      <form
                        class="flex max-w-sm items-center gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void deleteAccountNow();
                        }}
                      >
                        <input
                          class="w-36 font-mono text-sm"
                          placeholder="delete"
                          aria-label="Type delete to confirm"
                          onInput={(e) => setDeleteWord(e.currentTarget.value)}
                        />
                        <button
                          type="submit"
                          disabled={deleting() || deleteWord() !== 'delete'}
                          class="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-60"
                        >
                          {deleting() ? 'Deleting…' : 'Delete my account'}
                        </button>
                        <button
                          type="button"
                          class="rounded-lg px-3 py-2 text-sm font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                          onClick={() => setConfirmDelete('idle')}
                        >
                          Cancel
                        </button>
                      </form>
                      <Show when={deleteError()}>
                        <p role="alert" class="text-sm text-red-600 dark:text-red-400">
                          {deleteError()}
                        </p>
                      </Show>
                    </div>
                  }
                >
                  <button
                    type="button"
                    class="w-fit rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                    onClick={() => setConfirmDelete('confirm')}
                  >
                    Delete account…
                  </button>
                </Show>
              </div>
            </section>
          </div>
        )}
      </Show>
    </main>
  );
}

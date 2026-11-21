import { Title } from '@solidjs/meta';
import { revalidate } from '@solidjs/router';
import type { JSX } from '@solidjs/web';
import { Show, createMemo, createSignal } from 'solid-js';

import { Avatar } from '../components/Avatar';
import { PasskeyPrompt } from '../components/PasskeyPrompt';
import { ThemePicker } from '../components/ThemePicker';
import { getMe } from '../lib/auth';
import { uploadAvatar } from '../lib/avatar';
import { addPasskey } from '../lib/passkey';
import { setAvatarUrl, updateProfile } from '../lib/profile';
import { parseTheme } from '../lib/theme';

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <section class="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-neutral-400">{props.title}</h2>
      <div class="mt-4">{props.children}</div>
    </section>
  );
}

export default function ProfilePage() {
  const me = createMemo(() => getMe());

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
        username: String(data.get('username') ?? ''),
      });
      setSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save your profile');
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
      setAvatarError(error instanceof Error ? error.message : 'Upload failed — try again');
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
      setAvatarError(error instanceof Error ? error.message : 'Could not remove the picture');
    } finally {
      setAvatarBusy(false);
    }
  };

  // ── passkey ────────────────────────────────────────────────────────────
  const [passkeyBusy, setPasskeyBusy] = createSignal(false);
  const [passkeyError, setPasskeyError] = createSignal<string | null>(null);

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

  return (
    <main class="mx-auto max-w-2xl px-4 py-10">
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
                <div class="grid gap-4 sm:grid-cols-2">
                  <label class="flex flex-col gap-1.5 text-sm font-medium">
                    Display name
                    <input
                      name="display_name"
                      defaultValue={profile().display_name ?? ''}
                      placeholder="Ada Lovelace"
                      maxlength="80"
                    />
                  </label>
                  <label class="flex flex-col gap-1.5 text-sm font-medium">
                    Username
                    <input
                      name="username"
                      defaultValue={profile().username ?? ''}
                      placeholder="ada"
                      pattern="[a-zA-Z0-9._\-]{3,20}"
                      title="3-20 characters: letters, digits, . _ -"
                    />
                    <span class="text-xs font-normal text-neutral-400">
                      Lowercase letters, digits, and . _ — used for mentions and links.
                    </span>
                  </label>
                </div>
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

            <p class="text-xs text-neutral-400">
              Signed in as {profile().email} · member since{' '}
              {new Date(profile().created_at).toLocaleDateString(undefined, {
                month: 'long',
                year: 'numeric',
              })}
            </p>
          </div>
        )}
      </Show>
    </main>
  );
}

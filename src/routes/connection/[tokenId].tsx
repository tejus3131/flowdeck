// The MCP connection detail page: rename, change what the connection may
// do (the same org → entity → action picker the consent flow uses), and
// revoke — with a warning that revoking means reconnecting the client.
import { Title } from '@solidjs/meta';
import { RouteProps, useNavigate } from '@solidjs/router';
import { Show, createEffect, createSignal, onCleanup } from 'solid-js';

import { PermissionPicker } from '../../components/PermissionPicker';
import { listMyWorkspaceChoices } from '../../lib/mcp-auth';
import {
  workspaceOpsToSelection,
  type PermissionSelection,
} from '../../lib/mcp-permissions';
import {
  getConnection,
  renameConnection,
  revokeApiToken,
  updateConnectionPermissions,
} from '../../lib/tokens';

/** The connection page's own row shape (the query's own type). */
type Connection = NonNullable<Awaited<ReturnType<typeof getConnection>>>;

export default function ConnectionPage(props: RouteProps<'/connection/:tokenId'>) {
  const navigate = useNavigate();
  const [connection, setConnection] = createSignal<Connection | null>(null);
  const [workspaces, setWorkspaces] = createSignal<
    { id: string; name: string; role: 'member' | 'admin' | 'owner'; board_creation: string; is_team_admin: boolean }[]
  >([]);
  const [selection, setSelection] = createSignal<PermissionSelection>({ workspaces: {}, account: {} });
  const [name, setName] = createSignal('');
  const [status, setStatus] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [confirmRevoke, setConfirmRevoke] = createSignal(false);

  createEffect(
    () => props.params.tokenId,
    (tokenId) => void (async () => {
    const [detail, choices] = await Promise.all([getConnection(tokenId), listMyWorkspaceChoices()]);
    if (!detail) {
      navigate('/profile', { replace: true });
      return;
    }
    setConnection(detail);
    setName(detail.name);
    setWorkspaces(choices);
    // Legacy tokens (pre per-workspace permissions) convert on first
    // save; the picker starts from the flat grant applied everywhere.
    const legacyScope =
      detail.workspace_ops === null
        ? detail.legacy_workspace_scope ?? choices.map((ws) => ws.id)
        : null;
    setSelection(
      legacyScope
        ? // Legacy token: the flat grant (null = full power) applied to
          // each workspace it was scoped to. First save converts it.
          workspaceOpsToSelection(null, detail.legacy_allowed_ops ?? undefined, legacyScope)
        : workspaceOpsToSelection(detail.workspace_ops),
    );
    })(),
  );

  // ── autosave ─────────────────────────────────────────────────────────
  // No save buttons: every change saves itself. Single-flight per field —
  // a save in flight never stacks; the latest change wins when it lands.
  // The server is authoritative: on failure the inline error offers a
  // retry (the local state stays so nothing is silently lost).
  let nameTimer: ReturnType<typeof setTimeout> | undefined;
  let permsTimer: ReturnType<typeof setTimeout> | undefined;
  let nameInFlight = false;
  let permsInFlight = false;
  /** Which field the last failure came from — Retry re-saves THAT one. */
  let lastFailed: 'name' | 'perms' | null = null;
  // A debounced save must never fire after the page is gone.
  onCleanup(() => {
    clearTimeout(nameTimer);
    clearTimeout(permsTimer);
  });

  const doSaveName = async () => {
    if (nameInFlight) {
      nameTimer = setTimeout(() => void doSaveName(), 400);
      return;
    }
    nameInFlight = true;
    setError(null);
    setStatus('Saving…');
    try {
      await renameConnection(props.params.tokenId, name());
      setStatus('Saved');
      if (lastFailed === 'name') lastFailed = null;
    } catch (err) {
      lastFailed = 'name';
      setError(err instanceof Error ? err.message : 'Could not save the name');
    } finally {
      nameInFlight = false;
    }
  };

  const doSavePermissions = async () => {
    if (permsInFlight) {
      permsTimer = setTimeout(() => void doSavePermissions(), 400);
      return;
    }
    permsInFlight = true;
    setError(null);
    setStatus('Saving…');
    try {
      await updateConnectionPermissions(props.params.tokenId, selection());
      setStatus('Saved — new calls pick it up immediately');
      if (lastFailed === 'perms') lastFailed = null;
    } catch (err) {
      lastFailed = 'perms';
      setError(err instanceof Error ? err.message : 'Could not save the permissions');
    } finally {
      permsInFlight = false;
    }
  };

  /** Debounced name save (typing settles → save). */
  const onNameInput = (value: string) => {
    setName(value);
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => void doSaveName(), 800);
  };

  /** The picker's changes save themselves (debounced, single-flight). */
  const onPermissionsChange = (next: PermissionSelection) => {
    setSelection(next);
    clearTimeout(permsTimer);
    permsTimer = setTimeout(() => void doSavePermissions(), 500);
  };

  const retrySave = () => {
    setError(null);
    if (lastFailed === 'name') void doSaveName();
    else void doSavePermissions();
  };

  const revoke = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await revokeApiToken(props.params.tokenId);
      navigate('/profile');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setBusy(false);
    }
  };

  return (
    <main class="mx-auto max-w-2xl px-4 py-10">
      <Title>Connection — Flowdeck</Title>
      <p class="text-xs font-semibold uppercase tracking-wider text-indigo-500">
        MCP connection
      </p>
      <h1 class="mt-1 text-2xl font-bold tracking-tight">{name() || 'Connection'}</h1>
      <Show when={connection()}>
        <p class="mt-1 text-xs text-neutral-400">
          Created {new Date(connection()!.created_at).toLocaleDateString()} ·{' '}
          <Show
            when={connection()!.last_used_at}
            fallback="never used"
          >
            {(lastUsed) => `last used ${new Date(lastUsed()).toLocaleString()}`}
          </Show>
        </p>

        <label class="mt-6 block">
          <span class="mb-1 block text-sm font-medium">Connection name</span>
          <div class="flex gap-2">
            <input
              type="text"
              value={name()}
              maxlength="80"
              onInput={(event) => onNameInput(event.currentTarget.value)}
              class="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <span class="shrink-0 self-center text-xs text-neutral-400">{status()}</span>
          </div>
        </label>

        <div class="mt-6">
          <p class="mb-2 text-sm font-medium">What this connection can do</p>
          <PermissionPicker
            selection={selection()}
            workspaces={workspaces()}
            onChange={onPermissionsChange}
          />
        </div>

        <Show when={status()}>
          <p class="mt-3 rounded-xl bg-green-50 p-3 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
            {status()}
          </p>
        </Show>
        <Show when={error()}>
          <p role="alert" class="mt-3 flex items-center justify-between gap-3 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            <span>{error()}</span>
            <button
              type="button"
              onClick={retrySave}
              class="shrink-0 rounded-lg border border-red-300 px-3 py-1 text-xs font-semibold dark:border-red-800"
            >
              Retry
            </button>
          </p>
        </Show>

        <div class="mt-8 border-t border-neutral-200 pt-5 dark:border-neutral-800">
          <p class="mb-2 text-sm font-medium">Revoke connection</p>
          <p class="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
            Revoking signs the agent out immediately. To keep using it, you'll need to reconnect
            the MCP client through the sign-in flow and grant access again.
          </p>
          <Show
            when={!confirmRevoke()}
            fallback={
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy()}
                  onClick={() => void revoke()}
                  class="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                >
                  Yes, revoke it
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRevoke(false)}
                  class="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
                >
                  Keep it
                </button>
              </div>
            }
          >
            <button
              type="button"
              onClick={() => setConfirmRevoke(true)}
              class="rounded-xl border border-red-300 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
            >
              Revoke this connection
            </button>
          </Show>
        </div>
      </Show>
    </main>
  );
}

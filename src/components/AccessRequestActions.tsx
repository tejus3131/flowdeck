// Grant/Deny — an admin's inline answer to an access request, wherever the
// request shows up (updates strip, notifications page). The server side
// dismisses the request from every admin's list and notifies the asker.
import { Show, createSignal } from 'solid-js';

import { revalidate } from '@solidjs/router';

import { acceptInvite } from '../lib/workspaces';
import { resolveAccessRequest } from '../lib/access';
import type { NotificationRow } from '../lib/notifications';
import { errorMessage } from '../lib/error-message';

/** Pull the invite token out of the notification's accept href. */
export function inviteTokenOf(row: Pick<NotificationRow, 'href'>): string | null {
  const match = row.href?.match(/\/invite\/([0-9a-f-]{16,})/i);
  return match?.[1] ?? null;
}

/** Accept/Deny on an invite notification. Accept joins the workspace
 *  directly from the panel (the row's href page stays for email links);
 *  Deny just declines this notification — the invite itself is untouched.
 *  Either answer LOCKS the row: the state badge replaces the buttons. */
export function InviteActions(props: {
  row: NotificationRow;
  done: 'accepted' | 'declined' | null;
  onDone: (state: 'accepted' | 'declined') => void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const accept = async () => {
    const token = inviteTokenOf(props.row);
    if (!token || busy()) return;
    setBusy(true);
    setError(null);
    try {
      await acceptInvite(token);
      // The joined workspace is now this device's current one — refresh
      // what the dashboard and switcher know.
      revalidate('workspaces');
      revalidate('boards');
      props.onDone('accepted');
    } catch (cause) {
      // Real failures only (redirect carriers resolve empty). The reason
      // shows inline — "invalid, revoked, or already used" usually means
      // the workspace was deleted or the invite was consumed elsewhere.
      setError(errorMessage(cause, 'Could not accept'));
    } finally {
      setBusy(false);
    }
  };

  const decline = () => {
    if (busy()) return;
    props.onDone('declined');
  };

  return (
    <Show
      when={!props.done}
      fallback={
        <span
          class={`shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold ${
            props.done === 'accepted'
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
              : 'bg-neutral-100 text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500'
          }`}
        >
          {props.done === 'accepted' ? 'Accepted ✓' : 'Declined'}
        </span>
      }
    >
      <span class="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          disabled={busy()}
          class="rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          onClick={() => void accept()}
        >
          {busy() ? '…' : 'Accept'}
        </button>
        <button
          type="button"
          disabled={busy()}
          class="rounded-md border border-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800 dark:text-neutral-300"
          onClick={decline}
        >
          Deny
        </button>
        <Show when={error()}>
          <span class="max-w-32 truncate text-[11px] text-red-500" title={error() ?? ''}>
            {error()}
          </span>
        </Show>
      </span>
    </Show>
  );
}

export function AccessRequestActions(props: { row: NotificationRow }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const act = async (grant: boolean) => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await resolveAccessRequest({
        boardId: props.row.board_id ?? '',
        ...(props.row.subject_team_id
          ? { teamId: props.row.subject_team_id }
          : { userId: props.row.subject_id ?? '' }),
        grant,
      });
      // The live inbox drops the row when the server deletes it.
    } catch (cause) {
      setError(errorMessage(cause, 'Something went wrong'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span class="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        disabled={busy()}
        class="rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        onClick={() => void act(true)}
      >
        {busy() ? '…' : 'Grant'}
      </button>
      <button
        type="button"
        disabled={busy()}
        class="rounded-md border border-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800 dark:text-neutral-300"
        onClick={() => void act(false)}
      >
        Deny
      </button>
      <Show when={error()}>
        <span class="text-[11px] text-red-500">{error()}</span>
      </Show>
    </span>
  );
}

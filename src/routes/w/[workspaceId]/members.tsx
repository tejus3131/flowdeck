import { Title } from '@solidjs/meta';
import { revalidate } from '@solidjs/router';
import type { RouteProps } from '@solidjs/router';
import { For, Show, createMemo, createSignal } from 'solid-js';

import { Avatar } from '../../../components/Avatar';
import {
  getWorkspaceDetail,
  inviteMember,
  removeMember,
  revokeInvite,
  setBoardAccess,
  updateMemberRole,
  type InviteRole,
  type WorkspaceRole,
} from '../../../lib/workspaces';

const ROLE_STYLE: Record<WorkspaceRole, string> = {
  owner: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  admin: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  member: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
};

const ROLES: WorkspaceRole[] = ['owner', 'admin', 'member'];

export default function MembersPage(props: RouteProps<'/w/:workspaceId/members'>) {
  const detail = createMemo(() => getWorkspaceDetail(props.params.workspaceId));

  const isAdmin = () => detail()?.myRole === 'owner' || detail()?.myRole === 'admin';
  const isOwner = () => detail()?.myRole === 'owner';

  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);

  // ── invite form ───────────────────────────────────────────────────────
  const [inviteEmail, setInviteEmail] = createSignal('');
  const [inviteRole, setInviteRole] = createSignal<InviteRole>('member');
  const [inviteBusy, setInviteBusy] = createSignal(false);
  const [inviteLink, setInviteLink] = createSignal<string | null>(null);

  const invite = async (event: SubmitEvent) => {
    event.preventDefault();
    setInviteBusy(true);
    setError(null);
    setNotice(null);
    setInviteLink(null);
    try {
      const result = await inviteMember({
        workspaceId: props.params.workspaceId,
        email: inviteEmail(),
        role: inviteRole(),
      });
      setInviteEmail('');
      revalidate('workspace-detail');
      if (result.emailed) {
        setNotice(`Invitation emailed to ${inviteEmail() || 'them'} ✓`);
      } else {
        // No mail provider configured — surface the link to copy.
        setInviteLink(result.acceptUrl);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the invitation');
    } finally {
      setInviteBusy(false);
    }
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setNotice('Link copied ✓');
    } catch {
      setError('Could not copy — select the link text instead.');
    }
  };

  const reinvite = async (email: string, role: InviteRole) => {
    setInviteBusy(true);
    setError(null);
    try {
      const result = await inviteMember({
        workspaceId: props.params.workspaceId,
        email,
        role,
      });
      if (!result.emailed) setInviteLink(result.acceptUrl);
      else setNotice(`Invitation emailed again to ${email} ✓`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend');
    } finally {
      setInviteBusy(false);
    }
  };

  const revoke = async (inviteId: string) => {
    setError(null);
    try {
      await revokeInvite(inviteId);
      revalidate('workspace-detail');
      setNotice('Invitation revoked');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke');
    }
  };

  // ── members ──────────────────────────────────────────────────────────
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal<string | null>(null);

  const changeRole = async (userId: string, role: WorkspaceRole) => {
    setError(null);
    try {
      await updateMemberRole({ workspaceId: props.params.workspaceId, userId, role });
      revalidate('workspace-detail');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the role');
    }
  };

  const remove = async (userId: string) => {
    setError(null);
    try {
      await removeMember({ workspaceId: props.params.workspaceId, userId });
      revalidate('workspace-detail');
      setConfirming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the member');
    }
  };

  const changeAccess = async (boardId: string, userId: string, access: 'edit' | 'view' | null) => {
    setError(null);
    try {
      await setBoardAccess({ boardId, userId, access });
      revalidate('workspace-detail');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change board access');
    }
  };

  return (
    <main class="mx-auto max-w-3xl px-4 py-10">
      <Title>Members - Flowdeck</Title>
      <Show when={detail()} fallback={<p class="mt-8 text-sm text-neutral-400">Loading…</p>}>
        {(data) => (
          <>
            <div class="flex items-center justify-between">
              <div>
                <h1 class="text-2xl font-semibold tracking-tight">{data().workspace.name}</h1>
                <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  People with access · you are {data().myRole}
                </p>
              </div>
              <a
                href="/"
                class="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                ← Boards
              </a>
            </div>

            <Show when={error()}>
              <p role="alert" class="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950 dark:text-red-400">
                {error()}
              </p>
            </Show>
            <Show when={notice()}>
              <p class="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                {notice()}
              </p>
            </Show>

            {/* ── invite ─────────────────────────────────────────────── */}
            <Show when={isAdmin()}>
              <section class="mt-8 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
                <h2 class="text-sm font-semibold uppercase tracking-wider text-neutral-400">
                  Invite someone
                </h2>
                <form class="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={invite}>
                  <input
                    type="email"
                    required
                    placeholder="teammate@company.com"
                    value={inviteEmail()}
                    onInput={(e) => setInviteEmail(e.currentTarget.value)}
                    class="flex-1"
                  />
                  <select
                    value={inviteRole()}
                    onChange={(e) => setInviteRole(e.currentTarget.value as InviteRole)}
                    class="sm:w-36"
                    aria-label="Invite role"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button
                    type="submit"
                    disabled={inviteBusy()}
                    class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
                  >
                    {inviteBusy() ? 'Inviting…' : 'Invite'}
                  </button>
                </form>
                <Show when={inviteLink()}>
                  {(url) => (
                    <div class="mt-3 flex flex-col gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950">
                      <p class="text-amber-800 dark:text-amber-200">
                        Email isn't configured yet — share this link (it also works if they don't
                        have an account yet):
                      </p>
                      <div class="flex items-center gap-2">
                        <input readonly={true} value={url()} class="flex-1 text-xs" />
                        <button
                          type="button"
                          class="shrink-0 rounded-lg bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-200 dark:bg-amber-900 dark:text-amber-200"
                          onClick={() => void copyLink(url())}
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  )}
                </Show>
              </section>

              {/* ── pending invites ─────────────────────────────────── */}
              <Show when={data().invites.length > 0}>
                <section class="mt-6">
                  <h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-neutral-400">
                    Pending invitations
                  </h2>
                  <ul class="divide-y divide-neutral-200 rounded-2xl border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900">
                    <For each={data().invites}>
                      {(invite) => (
                        <li class="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
                          <span class="min-w-0 flex-1 truncate">{invite.email}</span>
                          <span class="capitalize text-neutral-400">{invite.role}</span>
                          <button
                            type="button"
                            class="rounded-lg px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                            onClick={() =>
                              void copyLink(
                                `${location.origin}/invite/${invite.token}`,
                              )
                            }
                          >
                            Copy link
                          </button>
                          <button
                            type="button"
                            disabled={inviteBusy()}
                            class="rounded-lg px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 dark:text-indigo-400 dark:hover:bg-indigo-950"
                            onClick={() => void reinvite(invite.email, invite.role)}
                          >
                            Reinvite
                          </button>
                          <button
                            type="button"
                            class="rounded-lg px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                            onClick={() => void revoke(invite.id)}
                          >
                            Revoke
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>
            </Show>

            {/* ── members ────────────────────────────────────────────── */}
            <section class="mt-6">
              <h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-neutral-400">
                Members
              </h2>
              <ul class="divide-y divide-neutral-200 rounded-2xl border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900">
                <For each={data().members}>
                  {(member) => (
                    <li class="px-4 py-3">
                      <div class="flex flex-wrap items-center gap-3">
                        <Avatar
                          src={member.avatar_url}
                          name={member.display_name}
                          email={member.email}
                          size="sm"
                        />
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-sm font-medium">
                            {member.display_name || member.email}
                            {member.username ? (
                              <span class="font-normal text-neutral-400"> @{member.username}</span>
                            ) : null}
                          </span>
                          <span class="block truncate text-xs text-neutral-400">{member.email}</span>
                        </span>

                        <Show
                          when={isAdmin() && member.role !== 'owner'}
                          fallback={<span class={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${ROLE_STYLE[member.role]}`}>{member.role}</span>}
                        >
                          <select
                            value={member.role}
                            aria-label={`Role for ${member.display_name ?? member.email}`}
                            class="w-28 text-xs"
                            onChange={(e) =>
                              void changeRole(member.user_id, e.currentTarget.value as WorkspaceRole)
                            }
                          >
                            <For each={isOwner() ? ROLES : ROLES.filter((r) => r !== 'owner')}>
                              {(role) => <option value={role}>{role}</option>}
                            </For>
                          </select>
                        </Show>

                        <Show when={isAdmin() && data().boards.length > 0}>
                          <button
                            type="button"
                            class="rounded-lg px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                            onClick={() =>
                              setExpanded(expanded() === member.user_id ? null : member.user_id)
                            }
                          >
                            {expanded() === member.user_id ? 'Hide access' : 'Board access'}
                          </button>
                        </Show>

                        <Show
                          when={confirming() === member.user_id}
                          fallback={
                            <Show
                              when={isAdmin() && member.role !== 'owner'}
                            >
                              <button
                                type="button"
                                title="Remove member"
                                class="rounded-lg px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                                onClick={() => setConfirming(member.user_id)}
                              >
                                Remove
                              </button>
                            </Show>
                          }
                        >
                          <button
                            type="button"
                            class="rounded-lg bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-600 dark:bg-red-950 dark:text-red-400"
                            onClick={() => void remove(member.user_id)}
                          >
                            Really remove?
                          </button>
                        </Show>
                      </div>

                      {/* per-board access overrides (admins) */}
                      <Show when={expanded() === member.user_id && isAdmin()}>
                        <div class="mt-3 space-y-2 rounded-xl bg-neutral-50 p-3 dark:bg-neutral-800/50">
                          <p class="text-xs text-neutral-400">
                            Per-board overrides. Default for workspace members is edit; set a
                            board to view to make someone read-only there.
                          </p>
                          <For each={data().boards}>
                            {(board) => {
                              const override = () =>
                                data().access[`${board.id}:${member.user_id}`] ?? null;
                              return (
                                <label class="flex items-center justify-between gap-2 text-sm">
                                  <span class="min-w-0 truncate">{board.name}</span>
                                  <select
                                    class="w-36 text-xs"
                                    value={override() ?? 'default'}
                                    onChange={(e) => {
                                      const value = e.currentTarget.value;
                                      void changeAccess(
                                        board.id,
                                        member.user_id,
                                        value === 'default' ? null : (value as 'edit' | 'view'),
                                      );
                                    }}
                                  >
                                    <option value="default">Default (edit)</option>
                                    <option value="edit">Always edit</option>
                                    <option value="view">View only</option>
                                  </select>
                                </label>
                              );
                            }}
                          </For>
                        </div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </>
        )}
      </Show>
    </main>
  );
}

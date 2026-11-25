import { Title } from '@solidjs/meta';
import { liveQuery, revalidate } from '@solidjs/router';
import { useNavigate } from '@solidjs/router';
import type { RouteProps } from '@solidjs/router';
import { For, Show, createMemo, createSignal } from 'solid-js';

import { Avatar } from '../../../components/Avatar';
import { getMe } from '../../../lib/auth';
import { createEngine } from '../../../lib/sync';
import { createWorkspaceRelay } from '../../../lib/workspace-relay';
import {
  applyDetailOp,
  echoDetailOp,
  guardsForDetailOp,
  mergeWorkspaceDetail,
  tempIdsForDetailOp,
  WS_OPS_KNOWN,
  type WorkspaceOpPayload,
} from '../../../lib/workspace-ops';
import { updateBoardCreation } from '../../../lib/workspaces';
import {
  deleteWorkspace,
  purgeAllBoards,
  getWorkspaceSnapshot,
  inviteMember,
  leaveWorkspace,
  removeMember,
  renameWorkspace,
  revokeInvite,
  updateInviteDomains,
  updateMemberRole,
  workspaceStream,
  type InviteRole,
  type WorkspaceDetail,
  type WorkspaceRole,
} from '../../../lib/workspaces';
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  reinstateTeam,
  removeTeamMember,
  setTeamMemberRole,
} from '../../../lib/teams';
import { errorMessage } from '../../../lib/error-message';
import { cachedStream, cachePut } from '../../../lib/cache';
import { perfFirstValue } from '../../../lib/perf';

const ROLE_STYLE: Record<WorkspaceRole, string> = {
  owner: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  admin: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  member: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
};

const ROLES: WorkspaceRole[] = ['owner', 'admin', 'member'];

const EMPTY_DETAIL: WorkspaceDetail = {
  workspace: { id: '', name: '', invite_domains: [], board_creation: 'team_admins' },
  myRole: null,
  members: [],
  invites: [],
  boards: [],
  access: {},
  tags: [],
  teams: [],
  deactivatedTeams: [],
  teamAccess: {},
};

export default function MembersPage(props: RouteProps<'/w/:workspaceId/members'>) {
  const navigate = useNavigate();
  const me = createMemo(() => getMe());

  // One shared live channel for this workspace: durable snapshots through
  // the SSE producer, provisional (relayed) ops through the workspace
  // relay — the same double path the board page runs.
  const workspaceLive = liveQuery(workspaceStream, 'workspace');
  const engine = createEngine<WorkspaceDetail>({
    // Stale-while-revalidate like the board page's roster engine — the
    // same cache key (ws-detail:<id>), so a board visit warms this page
    // and vice versa. No more "?" avatars on reload.
    streamSource: (key) =>
      perfFirstValue(
        cachedStream(`ws-detail:${key}`, () => workspaceLive(key), 'ws-detail-revalidate'),
        'ws-detail-open',
      ),
    key: () => props.params.workspaceId,
    empty: EMPTY_DETAIL,
    clone: (snapshot) => ({
      workspace: { ...snapshot.workspace },
      myRole: snapshot.myRole,
      members: snapshot.members.slice(),
      invites: snapshot.invites.slice(),
      boards: snapshot.boards.slice(),
      access: { ...snapshot.access },
      tags: snapshot.tags.slice(),
      teams: snapshot.teams.map((team) => ({ ...team, members: team.members.slice() })),
      deactivatedTeams: snapshot.deactivatedTeams.slice(),
      teamAccess: Object.fromEntries(
        Object.entries(snapshot.teamAccess).map(([key, value]) => [key, value.slice()]),
      ),
    }),
    merge: mergeWorkspaceDetail,
    status: () => workspaceLive.status(props.params.workspaceId),
    // The durable poll keeps the roster cache warm (parity with the
    // board's refresh writeback). EMPTY — no access or a failed read —
    // never writes: a stale seed is recoverable, a wrong empty one is a
    // flash of missing members.
    refresh: async () => {
      const snapshot = await getWorkspaceSnapshot(props.params.workspaceId);
      if (snapshot) cachePut(`ws-detail:${props.params.workspaceId}`, snapshot);
      return snapshot ?? EMPTY_DETAIL;
    },
  });
  const detail = createMemo(() => {
    const view = engine.view();
    return view.workspace.id ? view : null;
  });

  const isAdmin = () => detail()?.myRole === 'owner' || detail()?.myRole === 'admin';
  const isOwner = () => detail()?.myRole === 'owner';

  // ── the relay: author out, provisional in ────────────────────────────
  const relay = createWorkspaceRelay(
    () => props.params.workspaceId,
    () => me(),
    (op) => {
      if ('payload' in op && op.payload && typeof op.payload === 'object') {
        const payload = op.payload as WorkspaceOpPayload;
        if (!WS_OPS_KNOWN.has(payload.kind)) return;
        engine.applyRemote(
          {
            kind: payload.kind,
            guards: guardsForDetailOp(payload, me()?.id ?? null),
            tempIds: tempIdsForDetailOp(payload),
            apply: (draft) => applyDetailOp(draft, payload, me()?.id ?? null, new Date().toISOString()),
            echo: (durable) => echoDetailOp(durable, payload, me()?.id ?? null),
          },
          op.opId,
        );
        // If *I* was removed, the page stops being mine — go home.
        if (payload.kind === 'member-removed' && payload.userId === me()?.id) {
          navigate('/');
        }
      } else if ('opId' in op) {
        engine.failRemote(op.opId);
      }
    },
  );

  /** Author path: outbox op + relay to the other viewers. */
  const runOp = (payload: WorkspaceOpPayload, send: () => Promise<unknown>) => {
    const opId = crypto.randomUUID();
    engine.mutate({
      kind: payload.kind,
      guards: guardsForDetailOp(payload, me()?.id ?? null),
      tempIds: tempIdsForDetailOp(payload),
      apply: (draft) => applyDetailOp(draft, payload, me()?.id ?? null, new Date().toISOString()),
      send: () =>
        send().catch((error) => {
          relay.broadcastOpFail(opId);
          throw error;
        }),
      echo: (durable) => echoDetailOp(durable, payload, me()?.id ?? null),
    });
    relay.broadcastOp({ opId, payload });
  };

  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);

  /** Apply + relay a team op (author's broadcast doesn't loop back, so
   *  the author applies it locally too — the echo retires it). */
  const relayTeamOp = (payload: WorkspaceOpPayload) => {
    const opId = crypto.randomUUID();
    engine.applyRemote(
      {
        kind: payload.kind,
        guards: guardsForDetailOp(payload, me()?.id ?? null),
        tempIds: [],
        apply: (draft) => applyDetailOp(draft, payload, me()?.id ?? null, new Date().toISOString()),
        echo: (durable) => echoDetailOp(durable, payload, me()?.id ?? null),
      },
      opId,
    );
    relay.broadcastOp({ opId, payload });
  };

  /** Owners set who can create boards (the GitHub org setting). */
  const changeBoardCreation = async (policy: 'admins' | 'team_admins' | 'everyone') => {
    setError(null);
    try {
      await updateBoardCreation(props.params.workspaceId, policy);
      // Relay-after-ack: peers (and the dashboard's create button) flip
      // instantly; the author applies the same op locally since their own
      // broadcast doesn't loop back.
      relayTeamOp({ kind: 'ws-policy-changed', boardCreation: policy });
      setNotice(
        policy === 'admins'
          ? 'Only owners and admins can create boards'
          : policy === 'team_admins'
            ? 'Team admins can create boards ✓'
            : 'Everyone can create boards ✓',
      );
    } catch (cause) {
      setError(errorMessage(cause, 'Could not save the setting'));
    }
  };

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
      const email = inviteEmail();
      const role = inviteRole();
      const result = await inviteMember({
        workspaceId: props.params.workspaceId,
        email,
        role,
      });
      setInviteEmail('');
      // Relay-after-ack: the server minted the invite's id + token, so
      // the payload can only exist post-response. Everyone (self
      // included) applies it as a provisional the echo retires.
      relayInvite(result, email, role);
      if (result.emailed) {
        setNotice(`Invitation emailed to ${email} ✓`);
      } else {
        // No mail provider configured — surface the link to copy.
        setInviteLink(result.acceptUrl);
      }
    } catch (err) {
      setError(errorMessage(err, 'Could not send the invitation'));
    } finally {
      setInviteBusy(false);
    }
  };

  /** Apply + relay a fresh (server-minted) invite row provisionally. */
  const relayInvite = (
    result: { id: string; token: string; createdAt: string },
    email: string,
    role: InviteRole,
  ) => {
    const opId = crypto.randomUUID();
    const payload: WorkspaceOpPayload = {
      kind: 'invite-created',
      id: result.id,
      email,
      role,
      token: result.token,
      createdAt: result.createdAt,
    };
    engine.applyRemote(
      {
        kind: payload.kind,
        guards: guardsForDetailOp(payload, me()?.id ?? null),
        tempIds: tempIdsForDetailOp(payload),
        apply: (draft) => applyDetailOp(draft, payload, me()?.id ?? null, new Date().toISOString()),
        echo: (durable) => echoDetailOp(durable, payload, me()?.id ?? null),
      },
      opId,
    );
    relay.broadcastOp({ opId, payload });
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
      relayInvite(result, email, role);
      if (!result.emailed) setInviteLink(result.acceptUrl);
      else setNotice(`Invitation emailed again to ${email} ✓`);
    } catch (err) {
      setError(errorMessage(err, 'Could not resend'));
    } finally {
      setInviteBusy(false);
    }
  };

  const revoke = (inviteId: string) => {
    setError(null);
    runOp({ kind: 'invite-revoked', inviteId }, async () => {
      await revokeInvite(inviteId);
      setNotice('Invitation revoked');
    });
  };

  // ── members ──────────────────────────────────────────────────────────
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [confirmingLeave, setConfirmingLeave] = createSignal(false);
  const [leaving, setLeaving] = createSignal(false);
  // The owner-removal explainer modal ("demote first").
  const [ownerModal, setOwnerModal] = createSignal<string | null>(null);
  // Workspace rename (owners).
  const [renaming, setRenaming] = createSignal(false);
  const [nameDraft, setNameDraft] = createSignal('');
  // Invite domain allowlist (owners) — edited as a list of rows.
  const [domainsDraft, setDomainsDraft] = createSignal<string | null>(null);
  const [domainsBusy, setDomainsBusy] = createSignal(false);
  const domainRows = () =>
    (domainsDraft() ?? '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
  const setDomainRow = (index: number, value: string) => {
    const rows = domainRows();
    rows[index] = value;
    setDomainsDraft(rows.join(','));
  };
  const removeDomainRow = (index: number) => {
    const rows = domainRows();
    rows.splice(index, 1);
    setDomainsDraft(rows.join(','));
  };
  const [newDomainRow, setNewDomainRow] = createSignal('');
  const commitNewDomainRow = () => {
    const clean = newDomainRow().trim().toLowerCase().replace(/^@/, '');
    if (!clean) return;
    const rows = domainRows();
    if (!rows.includes(clean)) rows.push(clean);
    setDomainsDraft(rows.join(','));
    setNewDomainRow('');
  };
  // Delete workspace (owners).
  const [confirmingDeleteWs, setConfirmingDeleteWs] = createSignal(false);
  const [deletingWs, setDeletingWs] = createSignal(false);
  // Teams.
  const [teamName, setTeamName] = createSignal('');
  const [teamDescription, setTeamDescription] = createSignal('');
  const [teamBusy, setTeamBusy] = createSignal(false);
  const [teamModal, setTeamModal] = createSignal(false);
  const [teamQuery, setTeamQuery] = createSignal('');
  const [showDeactivated, setShowDeactivated] = createSignal(false);
  /** Can this viewer change that member's role?
   * Admins manage members; OWNERS also manage other owners — transferring
   * ownership is exactly that (the server keeps ≥1 owner and hands over
   * workspaces.owner_id). Your own role is never changed from here. */
  const canChangeRole = (member: { user_id: string; role: WorkspaceRole }) =>
    member.user_id !== me()?.id &&
    (isAdmin() || isOwner()) &&
    (member.role !== 'owner' || isOwner());

  const leave = () => {
    setError(null);
    setLeaving(true);
    runOp({ kind: 'member-removed', userId: me()?.id ?? '' }, async () => {
      await leaveWorkspace(props.params.workspaceId);
      setConfirmingLeave(false);
      setLeaving(false);
      // The dashboard must know the cookie's workspace is gone — it
      // shows the workspace picker instead of a dead board list.
      revalidate('workspaces');
      revalidate('boards');
      navigate('/');
    });
  };

  const changeRole = (userId: string, role: WorkspaceRole) => {
    setError(null);
    runOp({ kind: 'member-role', userId, role }, () =>
      updateMemberRole({ workspaceId: props.params.workspaceId, userId, role }),
    );
  };

  const remove = (userId: string) => {
    setError(null);
    runOp({ kind: 'member-removed', userId }, async () => {
      await removeMember({ workspaceId: props.params.workspaceId, userId });
      setConfirming(null);
    });
  };

  // ── workspace management (owners) ────────────────────────────────────
  const rename = async () => {
    const name = nameDraft().trim();
    if (!name || name === detail()?.workspace.name) {
      setRenaming(false);
      return;
    }
    setError(null);
    try {
      await renameWorkspace(props.params.workspaceId, name);
      setRenaming(false);
      setNotice('Workspace renamed ✓');
    } catch (cause) {
      setError(errorMessage(cause, 'Could not rename'));
    }
  };

  const saveDomains = async () => {
    if (domainsBusy()) return;
    setDomainsBusy(true);
    setError(null);
    try {
      const domains = (domainsDraft() ?? '')
        .split(/[\s,]+/)
        .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean);
      await updateInviteDomains(props.params.workspaceId, domains);
      setDomainsDraft(null);
      relayTeamOp({ kind: 'ws-policy-changed', inviteDomains: domains });
      setNotice(
        domains.length > 0
          ? `Invites restricted to ${domains.join(', ')} ✓`
          : 'Invites open to any email address ✓',
      );
    } catch (cause) {
      setError(errorMessage(cause, 'Could not save the allowlist'));
    } finally {
      setDomainsBusy(false);
    }
  };

  // ── bulk purge: every board, one typed confirmation (0070). The
  // workspace itself stays — this is the "empty it out" path that makes
  // the final delete possible.
  const [purgePanel, setPurgePanel] = createSignal(false);
  const [purgeTyped, setPurgeTyped] = createSignal('');
  const [purging, setPurging] = createSignal(false);
  const [purgeNote, setPurgeNote] = createSignal<string | null>(null);
  const purgeWs = async () => {
    if (purging()) return;
    setPurging(true);
    setError(null);
    try {
      const result = await purgeAllBoards(props.params.workspaceId);
      setPurgeNote(
        `Purged ${result.boardsPurged} board${result.boardsPurged === 1 ? '' : 's'} and ${result.cardsDeleted} card${result.cardsDeleted === 1 ? '' : 's'} — permanently.`,
      );
      setPurgePanel(false);
      setPurgeTyped('');
      await engine.refresh();
      revalidate('boards');
    } catch (cause) {
      setError(errorMessage(cause, 'Could not purge the boards'));
    }
    setPurging(false);
  };

  const deleteWs = async () => {
    if (deletingWs()) return;
    setDeletingWs(true);
    setError(null);
    try {
      await deleteWorkspace(props.params.workspaceId);
      revalidate('workspaces');
      revalidate('boards');
      navigate('/');
    } catch (cause) {
      setError(errorMessage(cause, 'Could not delete the workspace'));
      setDeletingWs(false);
    }
  };

  // ── teams ───────────────────────────────────────────────────────────
  const isWsAdmin = () => isAdmin() || isOwner();
  /** May this viewer manage THIS team's members (ws admin or team admin)? */
  const canManageTeam = (team: { members: { user_id: string; role: string }[] }) =>
    isWsAdmin() || team.members.some((m) => m.user_id === me()?.id && m.role === 'admin');

  const filteredTeams = () => {
    const q = teamQuery().trim().toLowerCase();
    return (detail()?.teams ?? []).filter((team) => !q || team.name.toLowerCase().includes(q));
  };

  const createTeamHere = async () => {
    const name = teamName().trim();
    if (!name || teamBusy()) return;
    setTeamBusy(true);
    setError(null);
    try {
      const created = await createTeam({
        workspaceId: props.params.workspaceId,
        name,
        description: teamDescription().trim(),
      });
      setTeamName('');
      setTeamDescription('');
      setTeamModal(false);
      setNotice(`Team “${name}” created — you're its admin`);
      relayTeamOp({
        kind: 'team-created',
        teamId: created.id,
        name,
        description: teamDescription().trim(),
      });
    } catch (cause) {
      setError(errorMessage(cause, 'Could not create the team'));
    } finally {
      setTeamBusy(false);
    }
  };

  const teamAction = async (
    action: () => Promise<unknown>,
    ok: string,
    relay?: () => void,
  ) => {
    setError(null);
    try {
      await action();
      setNotice(ok);
      relay?.();
    } catch (cause) {
      setError(errorMessage(cause, 'Something went wrong'));
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
                <Show
                  when={!renaming()}
                  fallback={
                    <form
                      class="flex items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void rename();
                      }}
                    >
                      <input
                        class="text-2xl font-semibold tracking-tight"
                        value={nameDraft()}
                        onInput={(event) => setNameDraft(event.currentTarget.value)}
                        autofocus
                      />
                      <button
                        type="submit"
                        class="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        class="text-xs font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                        onClick={() => setRenaming(false)}
                      >
                        Cancel
                      </button>
                    </form>
                  }
                >
                  <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                    {data().workspace.name}
                    <Show when={data().myRole === 'owner'}>
                      <button
                        type="button"
                        title="Rename workspace"
                        class="rounded-md px-1.5 py-0.5 text-sm text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                        onClick={() => {
                          setNameDraft(data().workspace.name);
                          setRenaming(true);
                        }}
                      >
                        ✎
                      </button>
                    </Show>
                  </h1>
                </Show>
                <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  People with access · you are {data().myRole}
                </p>
              </div>
              <div class="flex items-center gap-2">
                <Show when={data().myRole !== 'owner'}>
                <Show
                  when={confirmingLeave()}
                  fallback={
                    <button
                      type="button"
                      class="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                      onClick={() => setConfirmingLeave(true)}
                    >
                      Leave workspace
                    </button>
                  }
                >
                  <span class="flex items-center gap-1 text-sm text-red-600 dark:text-red-400">
                    Really leave?
                    <button
                      type="button"
                      disabled={leaving()}
                      class="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-60"
                      onClick={() => void leave()}
                    >
                      {leaving() ? 'Leaving…' : 'Yes, leave'}
                    </button>
                    <button
                      type="button"
                      class="rounded-lg px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      onClick={() => setConfirmingLeave(false)}
                    >
                      Cancel
                    </button>
                  </span>
                </Show>
                </Show>
                <a
                  href="/"
                  class="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  ← Boards
                </a>
              </div>
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
              <p class="mb-3 text-xs text-neutral-400">
                Roles live here. What each person can do on a specific board is granted in that
                board's settings (⚙) — new members start with access to no boards.
              </p>
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
                            {member.user_id === me()?.id ? (
                              <span class="ml-1 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">You</span>
                            ) : null}
                          </span>
                          <span class="block truncate text-xs text-neutral-400">{member.email}</span>
                        </span>

                        <Show
                          when={canChangeRole(member)}
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

                        <Show
                          when={confirming() === member.user_id}
                          fallback={
                            <Show when={isAdmin() && member.user_id !== me()?.id}>
                              <button
                                type="button"
                                title="Remove member"
                                class="rounded-lg px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                                onClick={() => {
                                  if (member.role === 'owner') {
                                    setOwnerModal(member.display_name || member.email);
                                    return;
                                  }
                                  setConfirming(member.user_id);
                                }}
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
                    </li>
                  )}
                </For>
              </ul>
            </section>

            {/* ── teams ─────────────────────────────────────────────── */}
            <section class="mt-8">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h2 class="text-sm font-semibold uppercase tracking-wider text-neutral-400">
                  Teams
                </h2>
                <div class="flex items-center gap-2">
                  <input
                    type="search"
                    class="w-44 text-sm"
                    placeholder="Search teams…"
                    value={teamQuery()}
                    onInput={(event) => setTeamQuery(event.currentTarget.value)}
                  />
                  <Show when={isWsAdmin()} fallback={<span />}>
                    <button
                      type="button"
                      class="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                      onClick={() => {
                        setTeamName('');
                        setTeamDescription('');
                        setTeamModal(true);
                      }}
                    >
                      + New team
                    </button>
                  </Show>
                </div>
              </div>
              <p class="mb-3 mt-1 text-xs text-neutral-400">
                Grant a whole team access to a board from that board's settings. @team mentions
                notify every member — each with their own notification. Team admins manage their
                team's people.
              </p>
              <Show when={isWsAdmin()}>
                <p class="mb-3 -mt-2 text-xs font-medium text-violet-600 dark:text-violet-400">
                  You're a workspace {detail()?.myRole === 'owner' ? 'owner' : 'admin'} — you can
                  create teams and manage every team's people.
                </p>
              </Show>

              <Show
                when={filteredTeams().length > 0}
                fallback={
                  <p class="text-sm text-neutral-400">
                    {teamQuery().trim()
                      ? 'No teams match that search.'
                      : isWsAdmin()
                        ? 'No teams yet — create the first one.'
                        : 'No teams yet.'}
                  </p>
                }
              >
                <ul class="mt-2 flex flex-col gap-2">
                  <For each={filteredTeams()}>
                    {(team) => {
                      const admins = () => team.members.filter((m) => m.role === 'admin');
                      return (
                        <li class="group flex items-center gap-3 rounded-2xl border border-neutral-200 bg-white px-4 py-3 transition hover:border-indigo-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-indigo-700">
                          <a
                            href={`/w/${props.params.workspaceId}/t/${team.id}`}
                            class="min-w-0 flex-1"
                          >
                            <p class="truncate text-sm font-semibold">
                              @{team.name}
                              <Show when={team.description}>
                                <span class="ml-2 text-xs font-normal text-neutral-400">
                                  {team.description}
                                </span>
                              </Show>
                            </p>
                            <p class="mt-0.5 text-xs text-neutral-400">
                              {team.members.length} member{team.members.length === 1 ? '' : 's'} ·{' '}
                              {admins().length} admin{admins().length === 1 ? '' : 's'}
                            </p>
                          </a>
                          <span class="flex -space-x-1.5">
                            <For each={team.members.slice(0, 4)}>
                              {(member) => {
                                const person = () =>
                                  data().members.find((m) => m.user_id === member.user_id);
                                return (
                                  <span class="rounded-full ring-2 ring-white dark:ring-neutral-900" title={person()?.display_name ?? 'Former member'}>
                                    <Avatar
                                      src={person()?.avatar_url}
                                      name={person()?.display_name}
                                      email={person()?.email}
                                      size="sm"
                                    />
                                  </span>
                                );
                              }}
                            </For>
                          </span>
                          <Show when={isWsAdmin()}>
                            <button
                              type="button"
                              title="Decommission team (mentions keep working; members and access drop)"
                              class="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-neutral-300 hover:bg-red-50 hover:text-red-500 dark:text-neutral-600 dark:hover:bg-red-950"
                              onClick={() =>
                                void teamAction(
                                  () => deleteTeam(team.id),
                                  `@${team.name} decommissioned`,
                                  () => relayTeamOp({ kind: 'team-deleted', teamId: team.id }),
                                )
                              }
                            >
                              ×
                            </button>
                          </Show>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </Show>

              {/* Decommissioned teams: kept so old mentions resolve. */}
              <Show when={data().deactivatedTeams.length > 0}>
                <div class="mt-3">
                  <button
                    type="button"
                    class="flex items-center gap-1.5 text-xs font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                    onClick={() => setShowDeactivated(!showDeactivated())}
                  >
                    🗄️ {data().deactivatedTeams.length} decommissioned
                    {showDeactivated() ? '▴' : '▾'}
                  </button>
                  <Show when={showDeactivated()}>
                    <ul class="mt-2 flex flex-col gap-1.5">
                      <For each={data().deactivatedTeams}>
                        {(team) => (
                          <li class="flex items-center justify-between gap-3 rounded-xl border border-dashed border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700">
                            <span class="min-w-0 truncate text-neutral-500 dark:text-neutral-400">
                              @{team.name}
                              <span class="ml-2 text-xs text-neutral-400">
                                removed{' '}
                                {new Date(team.deactivated_at).toLocaleDateString(undefined, {
                                  month: 'short',
                                  day: 'numeric',
                                })}
                              </span>
                            </span>
                            <Show when={isWsAdmin()}>
                              <button
                                type="button"
                                class="shrink-0 rounded-lg border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-500 hover:border-indigo-400 hover:text-indigo-600 dark:border-neutral-700 dark:text-neutral-400"
                                onClick={() =>
                                  void teamAction(
                                    () => reinstateTeam(team.id),
                                    `@${team.name} reinstated — add its members fresh`,
                                    () =>
                                      relayTeamOp({
                                        kind: 'team-created',
                                        teamId: team.id,
                                        name: team.name,
                                        description: '',
                                      }),
                                  )
                                }
                              >
                                Reinstate
                              </button>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
              </Show>
            </section>

            {/* ── create-team modal ──────────────────────────────────── */}
            <Show when={teamModal()}>
              <div
                class="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/40 p-4"
                onClick={() => setTeamModal(false)}
              >
                <form
                  class="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
                  onClick={(event) => event.stopPropagation()}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createTeamHere();
                  }}
                >
                  <h3 class="text-lg font-semibold">New team</h3>
                  <label class="mt-4 block text-xs font-semibold uppercase tracking-wider text-neutral-400">
                    Name
                  </label>
                  <input
                    class="mt-1 w-full"
                    maxlength="60"
                    placeholder="Backend, Design…"
                    value={teamName()}
                    onInput={(event) => setTeamName(event.currentTarget.value)}
                  />
                  <label class="mt-3 block text-xs font-semibold uppercase tracking-wider text-neutral-400">
                    Description <span class="font-normal normal-case">(optional)</span>
                  </label>
                  <textarea
                    class="mt-1 w-full"
                    rows={2}
                    maxlength="500"
                    placeholder="What does this team do?"
                    value={teamDescription()}
                    onInput={(event) => setTeamDescription(event.currentTarget.value)}
                  />
                  <div class="mt-4 flex justify-end gap-2">
                    <button
                      type="button"
                      class="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      onClick={() => setTeamModal(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!teamName().trim() || teamBusy()}
                      class="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {teamBusy() ? 'Creating…' : 'Create team'}
                    </button>
                  </div>
                </form>
              </div>
            </Show>

            {/* ── invite allowlist (owners) ──────────────────────────── */}
            <Show when={data().myRole === 'owner'}>
              <section class="mt-8 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
                <div class="flex items-center justify-between">
                  <h2 class="text-sm font-semibold uppercase tracking-wider text-neutral-400">
                    Invite allowlist
                  </h2>
                  <Show
                    when={domainsDraft() !== null}
                    fallback={
                      <button
                        type="button"
                        class="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-500 hover:border-indigo-400 hover:text-indigo-600 dark:border-neutral-700 dark:text-neutral-400"
                        onClick={() => setDomainsDraft(data().workspace.invite_domains.join(','))}
                      >
                        {data().workspace.invite_domains.length > 0 ? 'Edit' : 'Restrict invites'}
                      </button>
                    }
                  >
                    <span class="flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        disabled={domainsBusy()}
                        class="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                        onClick={() => void saveDomains()}
                      >
                        {domainsBusy() ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        class="font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                        onClick={() => setDomainsDraft(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  </Show>
                </div>

                <Show
                  when={domainsDraft() !== null}
                  fallback={
                    <div class="mt-3">
                      <Show
                        when={data().workspace.invite_domains.length > 0}
                        fallback={
                          <p class="text-xs text-neutral-400">
                            Open — any email address can be invited.
                          </p>
                        }
                      >
                        <ul class="flex flex-wrap gap-2">
                          <For each={data().workspace.invite_domains}>
                            {(domain) => (
                              <li class="rounded-lg bg-neutral-100 px-2.5 py-1 font-mono text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                                @{domain}
                              </li>
                            )}
                          </For>
                        </ul>
                        <p class="mt-2 text-xs text-neutral-400">
                          Only addresses at these domains can be invited.
                        </p>
                      </Show>
                    </div>
                  }
                >
                  {/* The editor: one row per domain, an add row, save/cancel above. */}
                  <ul class="mt-3 flex flex-col gap-1.5">
                    <For each={domainRows()}>
                      {(domain, index) => (
                        <li class="flex items-center gap-2">
                          <span class="text-neutral-400">@</span>
                          <input
                            class="w-full font-mono text-xs"
                            placeholder="company.com"
                            value={domain}
                            onInput={(event) => setDomainRow(index(), event.currentTarget.value)}
                          />
                          <button
                            type="button"
                            title="Remove"
                            class="shrink-0 rounded-md px-1.5 py-1 text-xs text-neutral-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950"
                            onClick={() => removeDomainRow(index())}
                          >
                            ×
                          </button>
                        </li>
                      )}
                    </For>
                    <li class="flex items-center gap-2">
                      <span class="text-neutral-400">@</span>
                      <input
                        class="w-full font-mono text-xs"
                        placeholder="add a domain…"
                        value={newDomainRow()}
                        onInput={(event) => setNewDomainRow(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            commitNewDomainRow();
                          }
                        }}
                      />
                      <button
                        type="button"
                        class="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950"
                        onClick={commitNewDomainRow}
                      >
                        + Add
                      </button>
                    </li>
                  </ul>
                  <p class="mt-2 text-xs text-neutral-400">
                    Empty list = any address may be invited. Saved as shown — one row per domain.
                  </p>
                </Show>
              </section>
            </Show>

            {/* ── board creation policy (owners) ───────────────────────── */}
            <Show when={data().myRole === 'owner'}>
              <section class="mt-8 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
                <h2 class="text-sm font-semibold uppercase tracking-wider text-neutral-400">
                  Board creation
                </h2>
                <p class="mb-3 mt-1 text-xs text-neutral-400">
                  Who can create boards in this workspace. Owners and admins always can.
                </p>
                <div class="flex gap-2">
                  <For each={['admins', 'team_admins', 'everyone'] as const}>
                    {(policy) => (
                      <button
                        type="button"
                        class={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                          data().workspace.board_creation === policy
                            ? 'border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300'
                            : 'border-neutral-200 text-neutral-500 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400'
                        }`}
                        onClick={() => void changeBoardCreation(policy)}
                      >
                        {policy === 'admins'
                          ? 'Owners & admins only'
                          : policy === 'team_admins'
                            ? '+ Team admins'
                            : 'Everyone'}
                      </button>
                    )}
                  </For>
                </div>
              </section>
            </Show>

            {/* ── danger zone (owners) ───────────────────────────────── */}
            <Show when={data().myRole === 'owner'}>
              <section class="mt-8 border-t border-neutral-200 pt-4 dark:border-neutral-800">
                <h2 class="text-sm font-semibold uppercase tracking-wider text-red-500">
                  Danger zone
                </h2>
                <p class="mt-1 text-xs text-neutral-400">
                  Deleting removes the workspace and every board, card, comment, team, and
                  invite inside it — for everyone.
                </p>
                <Show when={purgeNote()}>
                  <p class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">{purgeNote()}</p>
                </Show>
                <Show
                  when={!purgePanel()}
                  fallback={
                    <div class="mt-2 rounded-xl border border-red-200 bg-red-50/60 p-3 dark:border-red-900 dark:bg-red-950/30">
                      <p class="text-xs text-red-700 dark:text-red-300">
                        Type <span class="font-mono font-semibold">{data().workspace.name}</span> to
                        permanently delete every board in this workspace and all their cards.
                        The workspace itself stays.
                      </p>
                      <input
                        class="mt-2 w-44 rounded-lg border border-red-200 bg-white px-2 py-1 text-xs outline-none dark:border-red-900 dark:bg-neutral-900"
                        placeholder="Workspace name"
                        value={purgeTyped()}
                        onInput={(event) => setPurgeTyped(event.currentTarget.value)}
                      />
                      <div class="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          disabled={purging() || purgeTyped() !== data().workspace.name}
                          class="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                          onClick={() => void purgeWs()}
                        >
                          {purging() ? 'Purging…' : `Purge all ${data().boards.length} board${data().boards.length === 1 ? '' : 's'}…`}
                        </button>
                        <button
                          type="button"
                          class="text-xs font-medium text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                          onClick={() => {
                            setPurgePanel(false);
                            setPurgeTyped('');
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  }
                >
                  <button
                    type="button"
                    class="mt-2 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950"
                    onClick={() => {
                      setPurgeNote(null);
                      setPurgePanel(true);
                    }}
                  >
                    Purge all boards…
                  </button>
                </Show>
                <Show
                  when={confirmingDeleteWs()}
                  fallback={
                    <button
                      type="button"
                      class="mt-2 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950"
                      onClick={() => setConfirmingDeleteWs(true)}
                    >
                      Delete this workspace…
                    </button>
                  }
                >
                  <span class="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={deletingWs()}
                      class="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                      onClick={() => void deleteWs()}
                    >
                      {deletingWs() ? 'Deleting…' : 'Really delete everything?'}
                    </button>
                    <button
                      type="button"
                      class="text-xs font-medium text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                      onClick={() => setConfirmingDeleteWs(false)}
                    >
                      Cancel
                    </button>
                  </span>
                </Show>
              </section>
            </Show>

            {/* The owner-removal explainer: an owner is demoted first. */}
            <Show when={ownerModal()}>
              {(name) => (
                <div
                  class="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/40 p-4"
                  onClick={() => setOwnerModal(null)}
                >
                  <div
                    class="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-5 text-center shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <p class="text-2xl">🛡️</p>
                    <h3 class="mt-2 text-sm font-semibold">
                      You can't remove an owner
                    </h3>
                    <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      {name()} is an owner of this workspace. Make them an admin or a member
                      first (their role dropdown above), then remove them.
                    </p>
                    <button
                      type="button"
                      class="mt-4 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                      onClick={() => setOwnerModal(null)}
                    >
                      Got it
                    </button>
                  </div>
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
    </main>
  );
}

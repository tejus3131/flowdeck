// The team profile — where an @team mention lands. One page per team:
// who's on it (and who administers it), which boards it can reach, its
// description, and its lifecycle (decommissioned teams explain themselves
// and can be reinstated by workspace admins).
import { Title } from '@solidjs/meta';
import { liveQuery, useNavigate, type RouteProps } from '@solidjs/router';
import { For, Show, createMemo, createSignal, onSettled } from 'solid-js';

import { Avatar } from '../../../../components/Avatar';
import { getMe } from '../../../../lib/auth';
import { createEngine } from '../../../../lib/sync';
import {
  getWorkspaceSnapshot,
  workspaceStream,
  type WorkspaceDetail,
} from '../../../../lib/workspaces';
import { mergeWorkspaceDetail } from '../../../../lib/workspace-ops';
import {
  addTeamMember,
  reinstateTeam,
  removeTeamMember,
  setTeamMemberRole,
  updateTeam,
} from '../../../../lib/teams';
import { errorMessage } from '../../../../lib/error-message';

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

export default function TeamPage(props: RouteProps<'/w/:workspaceId/t/:teamId'>) {
  const navigate = useNavigate();
  const me = createMemo(() => getMe());

  const workspaceLive = liveQuery(workspaceStream, 'workspace');
  const engine = createEngine<WorkspaceDetail>({
    streamSource: (key) => workspaceLive(key),
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
    refresh: async () =>
      (await getWorkspaceSnapshot(props.params.workspaceId)) ?? EMPTY_DETAIL,
  });

  const detail = createMemo(() => {
    const view = engine.view();
    return view.workspace.id ? view : null;
  });
  const team = createMemo(
    () =>
      detail()?.teams.find((entry) => entry.id === props.params.teamId) ?? null,
  );
  const deactivated = createMemo(
    () => detail()?.deactivatedTeams.find((entry) => entry.id === props.params.teamId) ?? null,
  );
  const exists = () => team() !== null || deactivated() !== null;

  const isAdmin = () => detail()?.myRole === 'owner' || detail()?.myRole === 'admin';
  const isTeamAdmin = () =>
    team()?.members.some((m) => m.user_id === me()?.id && m.role === 'admin') ?? false;
  const canManage = () => (team() !== null) && (isAdmin() || isTeamAdmin());

  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);

  /** Boards this team can reach: the teamAccess map is keyed by board. */
  const boards = () => {
    const map = detail()?.teamAccess ?? {};
    const out: { boardId: string; boardName: string; access: 'edit' | 'view' }[] = [];
    for (const [boardId, grants] of Object.entries(map)) {
      const grant = grants.find((entry) => entry.teamId === props.params.teamId);
      if (!grant) continue;
      out.push({
        boardId,
        boardName:
          detail()?.boards.find((b) => b.id === boardId)?.name ?? 'A board',
        access: grant.access,
      });
    }
    return out;
  };

  const action = async (run: () => Promise<unknown>, ok: string) => {
    setError(null);
    try {
      await run();
      setNotice(ok);
    } catch (cause) {
      setError(errorMessage(cause, 'Something went wrong'));
    }
  };

  // ── name / description editing (team admins + ws admins) ──────────────
  const [renaming, setRenaming] = createSignal(false);
  const [nameDraft, setNameDraft] = createSignal('');
  const [describing, setDescribing] = createSignal(false);
  const [descriptionDraft, setDescriptionDraft] = createSignal('');

  const saveName = () => {
    const name = nameDraft().trim();
    setRenaming(false);
    if (!name || name === team()?.name) return;
    void action(
      () => updateTeam({ teamId: props.params.teamId, name }),
      'Team renamed ✓',
    );
  };
  const saveDescription = () => {
    const description = descriptionDraft().trim();
    setDescribing(false);
    if (description === (team()?.description ?? '')) return;
    void action(
      () => updateTeam({ teamId: props.params.teamId, description }),
      'Description saved ✓',
    );
  };

  return (
    <main class="mx-auto max-w-3xl px-4 py-10">
      <Title>Team - Flowdeck</Title>
      <Show
        when={exists()}
        fallback={
          <Show when={detail()} fallback={<p class="mt-8 text-sm text-neutral-400">Loading…</p>}>
            <p class="mt-8 text-sm text-neutral-400">
              This team doesn't exist in this workspace.{' '}
              <a href={`/w/${props.params.workspaceId}/members`} class="text-indigo-600 underline dark:text-indigo-400">
                Back to members
              </a>
            </p>
          </Show>
        }
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <Show
              when={!renaming()}
              fallback={
                <form
                  class="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveName();
                  }}
                >
                  <input
                    class="text-2xl font-semibold tracking-tight"
                    value={nameDraft()}
                    onInput={(event) => setNameDraft(event.currentTarget.value)}
                    autofocus
                  />
                  <button type="submit" class="text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                    Save
                  </button>
                </form>
              }
            >
              <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                @{team()?.name ?? deactivated()?.name}
                <Show when={canManage() && team()}>
                  <button
                    type="button"
                    title="Rename team"
                    class="rounded-md px-1.5 py-0.5 text-sm text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                    onClick={() => {
                      setNameDraft(team()?.name ?? '');
                      setRenaming(true);
                    }}
                  >
                    ✎
                  </button>
                </Show>
              </h1>
            </Show>
            <Show
              when={!describing()}
              fallback={
                <form
                  class="mt-2 flex items-start gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveDescription();
                  }}
                >
                  <textarea
                    class="mt-0 w-full max-w-md text-sm"
                    rows={2}
                    value={descriptionDraft()}
                    onInput={(event) => setDescriptionDraft(event.currentTarget.value)}
                  />
                  <button type="submit" class="shrink-0 text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                    Save
                  </button>
                </form>
              }
            >
              <p class="mt-1 flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
                {team()?.description || 'No description yet.'}
                <Show when={canManage() && team()}>
                  <button
                    type="button"
                    title="Edit description"
                    class="text-xs text-neutral-400 hover:text-indigo-600 dark:hover:text-indigo-400"
                    onClick={() => {
                      setDescriptionDraft(team()?.description ?? '');
                      setDescribing(true);
                    }}
                  >
                    ✎
                  </button>
                </Show>
              </p>
            </Show>
          </div>
          <a
            href={`/w/${props.params.workspaceId}/members`}
            class="shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            ← Members
          </a>
        </div>

        {/* Decommissioned banner: mentions still resolve, nothing works. */}
        <Show when={deactivated()}>
          <div class="mt-6 rounded-2xl border border-dashed border-neutral-300 p-4 dark:border-neutral-700">
            <p class="text-sm font-semibold text-neutral-500 dark:text-neutral-400">
              🗄️ This team is decommissioned
            </p>
            <p class="mt-1 text-xs text-neutral-400">
              Old @mentions keep naming it, but it has no members and no board access.
              Reinstating brings the name back — people and access are granted fresh.
            </p>
            <Show when={isAdmin()}>
              <button
                type="button"
                class="mt-3 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-indigo-400 hover:text-indigo-600 dark:border-neutral-700 dark:text-neutral-400"
                onClick={() =>
                  void action(
                    () => reinstateTeam(props.params.teamId),
                    'Team reinstated — add its members fresh',
                  )
                }
              >
                Reinstate team
              </button>
            </Show>
          </div>
        </Show>

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

        {/* Members */}
        <section class="mt-8">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-neutral-400">
            Members · {team()?.members.length ?? 0}
          </h2>
          <Show when={team()}>
            <p class="mb-3 mt-1 text-xs text-neutral-400">
              @mentioning the team notifies every member — each with their own notification.
            </p>
            <Show when={isAdmin()}>
              <p class="mb-3 -mt-2 text-xs font-medium text-violet-600 dark:text-violet-400">
                You're a workspace {detail()?.myRole === 'owner' ? 'owner' : 'admin'} — you can
                manage every team, its people, and its board access.
              </p>
            </Show>
            <ul class="divide-y divide-neutral-200 rounded-2xl border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900">
              <For each={team()?.members}>
                {(member) => {
                  const person = () =>
                    detail()?.members.find((m) => m.user_id === member.user_id);
                  return (
                    <li class="flex items-center gap-3 px-4 py-3">
                      <Avatar
                        src={person()?.avatar_url}
                        name={person()?.display_name}
                        email={person()?.email}
                        size="sm"
                      />
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm font-medium">
                          {person()?.display_name ?? person()?.email ?? 'Former member'}
                        </span>
                        <span class="block truncate text-xs text-neutral-400">
                          {person()?.email ?? ''}
                        </span>
                      </span>
                      <Show when={person()?.role === 'owner'}>
                        <span
                          title="Workspace owner — can manage every team"
                          class="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                        >
                          ws owner
                        </span>
                      </Show>
                      <Show when={person()?.role === 'admin'}>
                        <span
                          title="Workspace admin — can manage every team"
                          class="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                        >
                          ws admin
                        </span>
                      </Show>
                      <Show
                        when={member.role === 'admin'}
                        fallback={
                          <Show when={canManage()}>
                            <button
                              type="button"
                              title="Make a team admin"
                              class="rounded-lg px-2 py-0.5 text-[11px] font-medium text-neutral-400 hover:bg-neutral-100 hover:text-indigo-600 dark:hover:bg-neutral-800 dark:hover:text-indigo-400"
                              onClick={() =>
                                void action(
                                  () =>
                                    setTeamMemberRole({
                                      teamId: props.params.teamId,
                                      userId: member.user_id,
                                      role: 'admin',
                                    }),
                                  'Promoted to team admin ✓',
                                )
                              }
                            >
                              ↑ admin
                            </button>
                          </Show>
                        }
                      >
                        <span class="flex items-center gap-1">
                          <span class="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                            team admin
                          </span>
                          {/* Workspace admins can demote team admins back to
                              member (the policy allows exactly them). */}
                          <Show when={isAdmin()}>
                            <button
                              type="button"
                              title="Make a normal member"
                              class="rounded-lg px-2 py-0.5 text-[11px] font-medium text-neutral-400 hover:bg-neutral-100 hover:text-indigo-600 dark:hover:bg-neutral-800 dark:hover:text-indigo-400"
                              onClick={() =>
                                void action(
                                  () =>
                                    setTeamMemberRole({
                                      teamId: props.params.teamId,
                                      userId: member.user_id,
                                      role: 'member',
                                    }),
                                  'Demoted to member ✓',
                                )
                              }
                            >
                              ↓ member
                            </button>
                          </Show>
                        </span>
                      </Show>
                      <Show when={canManage()}>
                        <button
                          type="button"
                          title="Remove from team"
                          class="rounded-lg px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950"
                          onClick={() =>
                            void action(
                              () =>
                                removeTeamMember({
                                  teamId: props.params.teamId,
                                  userId: member.user_id,
                                }),
                              'Removed from the team',
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

            {/* Add a member (ws members not already on the team). */}
            <Show when={canManage()}>
              <form
                class="mt-3 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const select = event.currentTarget.querySelector<HTMLSelectElement>('select');
                  const userId = select?.value ?? '';
                  if (!userId || !select) return;
                  select.value = '';
                  void action(
                    () => addTeamMember({ teamId: props.params.teamId, userId }),
                    'Added to the team ✓',
                  );
                }}
              >
                <select class="flex-1 text-sm" aria-label="Add a member">
                  <option value="">Add someone to the team…</option>
                  <For
                    each={detail()?.members.filter(
                      (m) => !team()?.members.some((t) => t.user_id === m.user_id),
                    )}
                  >
                    {(member) => (
                      <option value={member.user_id}>
                        {member.display_name ?? member.email}
                      </option>
                    )}
                  </For>
                </select>
                <button
                  type="submit"
                  class="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                >
                  Add
                </button>
              </form>
            </Show>
          </Show>
        </section>

        {/* Boards the team can reach */}
        <section class="mt-8">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-neutral-400">
            Board access · {boards().length}
          </h2>
          <p class="mb-3 mt-1 text-xs text-neutral-400">
            Managed from each board's settings (⚙ → Team access).
          </p>
          <Show
            when={boards().length > 0}
            fallback={<p class="text-sm text-neutral-400">No boards yet.</p>}
          >
            <ul class="flex flex-col gap-1.5">
              <For each={boards()}>
                {(grant) => (
                    <li class="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-2.5 text-sm dark:border-neutral-800">
                      <a href={`/b/${grant.boardId}`} class="min-w-0 flex-1 truncate font-medium hover:text-indigo-600 dark:hover:text-indigo-400">
                        {grant.boardName}
                      </a>
                      <span
                        class={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          grant.access === 'edit'
                            ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                            : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                        }`}
                      >
                        {grant.access === 'edit' ? 'Write' : 'View'}
                      </span>
                    </li>
              )}</For>
            </ul>
          </Show>
        </section>
      </Show>
    </main>
  );
}


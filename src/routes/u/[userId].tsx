// A user's public profile — the people counterpart of the team page:
// identity, live status, the teams you share, and the agent/docs links.
import { Title } from '@solidjs/meta';
import { useNavigate, type RouteProps } from '@solidjs/router';
import { For, Show, createSignal, onSettled } from 'solid-js';

import { Avatar } from '../../components/Avatar';
import { MembershipWatch } from '../../components/MembershipWatch';
import { userProfile, type PublicProfile } from '../../lib/profile-view';

const TEAM_ROLE_STYLE: Record<string, string> = {
  admin: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  member: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
};

export default function UserProfilePage(props: RouteProps<'/u/:userId'>) {
  const navigate = useNavigate();
  const [profile, setProfile] = createSignal<PublicProfile | null | undefined>(undefined);

  onSettled(() => {
    void userProfile(props.params.userId)
      .then(setProfile)
      .catch(() => setProfile(null));
  });

  return (
    <main class="mx-auto max-w-2xl px-4 py-10">
      <MembershipWatch />
      <Title>Profile — Flowdeck</Title>
      <Show
        when={profile()}
        fallback={
          <Show
            when={profile() === undefined}
            fallback={
              <div class="rounded-2xl border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
                No visible profile for that person — you don't share a workspace with them.
              </div>
            }
          >
            <p class="animate-pulse text-sm text-neutral-400">Loading profile…</p>
          </Show>
        }
      >
        {(person) => (
          <>
            <div class="flex items-center gap-4">
              <Avatar src={person().avatar_url} name={person().display_name} email={person().email} size="lg" />
              <div class="min-w-0">
                <h1 class="truncate text-xl font-bold tracking-tight">
                  {person().display_name ?? person().email ?? 'Someone'}
                </h1>
                <Show when={person().email}>
                  <p class="truncate text-sm text-neutral-400">{person().email}</p>
                </Show>
                <Show when={person().status}>
                  {(status) => (
                    <p class="mt-1 inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                      <span>{status().emoji ?? '💬'}</span>
                      <span>{status().label ?? 'Set a status'}</span>
                      <Show when={status().dnd}>
                        <span title="Do not disturb — notifications silenced">· 🔕 DND</span>
                      </Show>
                    </p>
                  )}
                </Show>
              </div>
            </div>

            <section class="mt-8">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-neutral-400">Teams you share</h2>
              <Show
                when={person().teams.length > 0}
                fallback={<p class="mt-2 text-sm text-neutral-400">No shared teams in your workspaces.</p>}
              >
                <ul class="mt-3 divide-y divide-neutral-200 rounded-2xl border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900">
                  <For each={person().teams}>
                    {(team) => (
                      <li class="flex items-center gap-3 px-4 py-3">
                        <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 text-sm dark:bg-emerald-500/15">
                          👥
                        </span>
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-sm font-medium">{team.teamName}</span>
                          <span class="block truncate text-xs text-neutral-400">{team.workspaceName}</span>
                        </span>
                        <span class={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TEAM_ROLE_STYLE[team.role] ?? TEAM_ROLE_STYLE.member}`}>
                          {team.role === 'admin' ? 'team admin' : 'member'}
                        </span>
                        <a
                          href={`/w/${team.workspaceId}/t/${team.teamId}`}
                          class="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          Open →
                        </a>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
          </>
        )}
      </Show>

      <section class="mt-10 rounded-2xl border border-dashed border-neutral-300 p-5 dark:border-neutral-700">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-neutral-400">Work with agents</h2>
        <p class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          Connect Claude, Cursor, or your own AI agents to this workspace — they act with your permissions,
          nothing more.
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <a
            href="/docs/mcp"
            class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
          >
            MCP connection docs
          </a>
          <button
            type="button"
            class="text-xs font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            onClick={() => navigate(-1)}
          >
            ← Back
          </button>
        </div>
      </section>
    </main>
  );
}

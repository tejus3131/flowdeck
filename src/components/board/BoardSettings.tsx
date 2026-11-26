// Extracted from the board route (phase 6): a panel is its own module
// so the route stays a wiring file (L5 rule 6).
import { For, Show, createSignal, onCleanup } from 'solid-js';

import { Avatar } from '../Avatar';
import { type CardView, type ListRow } from '../../lib/boards';

import { type Member, type WorkspaceDetail } from '../../lib/workspaces';
import { setBoardTeamAccess } from '../../lib/teams';
import { errorMessage } from '../../lib/error-message';

/**
 * Board settings drawer — the board's own management surface:
 *  * name + description (editors)
 *  * per-member access to THIS board (workspace admins): none / view /
 *    write. Grants flip the affected viewer's page instantly (relay) and
 *    are confirmed by the echo — the same pattern as every other op.
 *  * delete (board owner or workspace owner/admin).
 * Members with the plain role start at "no access" and are granted per
 * board; owners/admins and the board owner always hold write (their
 * selector renders as a fixed badge, mirroring user_board_access()).
 */
export function BoardSettings(props: {
  boardId: string;
  board: { name: string; description: string; owner_id: string };
  canEdit: boolean;
  isWsAdmin: boolean;
  canDelete: boolean;
  /** May editors grant board access themselves (the mention flow)? */
  accessDelegation: boolean;
  onToggleDelegation: (on: boolean) => void;
  detail: WorkspaceDetail;
  meId: string | null;
  deleting: boolean;
  error: string | null;
  /** Surface a failed server write in the drawer's error strip. */
  onError: (message: string) => void;
  /** A team's access changed — mirror on the workspace relay. */
  onTeamAccessChanged: (teamId: string, access: 'edit' | 'view' | null) => void;
  onRename: (name: string) => void;
  onDescribe: (description: string) => void;
  onEffectiveAccess: (member: Member) => 'edit' | 'view' | null;
  onIsGrantable: (member: Member) => boolean;
  onChangeAccess: (userId: string, access: 'edit' | 'view' | null) => void;
  /** Deletes the board; purge=true takes the destructive path (0061). */
  onDelete: (purge: boolean) => void;
  onClose: () => void;
  /** Every card on the board (resolved too) — the purge confirm's stakes. */
  cardCount: number;
  /** The board's resolved (hidden) cards — the time capsule's view (0059). */
  resolvedCards: CardView[];
  /** List names for the resolved rows (the frozen list each came from). */
  lists: ListRow[];
  /** Bring a resolved card back (the RPC heals position + logs it). */
  onUnresolve: (cardId: string) => void;
}) {
  const [nameDraft, setNameDraft] = createSignal(props.board.name);
  const [descriptionDraft, setDescriptionDraft] = createSignal<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);
  /** How many resolved rows show at once — "Show more" grows the slice. */
  const [resolvedShown, setResolvedShown] = createSignal(20);
  /** The purge confirm's typed board name (0061's deliberate path). */
  const [typedConfirm, setTypedConfirm] = createSignal('');

  // Escape closes (same affordance as the card drawer).
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') props.onClose();
  };
  document.addEventListener('keydown', onKey);
  onCleanup(() => document.removeEventListener('keydown', onKey));

  // The description textarea starts as a mirror of the server value; null
  // means "not editing" (the rendered markdown shows instead).
  const description = () => descriptionDraft() ?? props.board.description;
  const saveDescription = () => {
    if (descriptionDraft() !== null && descriptionDraft() !== props.board.description) {
      props.onDescribe(descriptionDraft()!);
    }
    setDescriptionDraft(null);
  };

  const ACCESS_OPTIONS: { value: 'edit' | 'view' | null; label: string; hint: string }[] = [
    { value: null, label: 'None', hint: 'No access to this board' },
    { value: 'view', label: 'View', hint: 'See the board, no editing' },
    { value: 'edit', label: 'Write', hint: 'Full editing' },
  ];

  const accessOf = (member: Member) => props.onEffectiveAccess(member);

  return (
    <div class="min-h-0 flex-1 overflow-y-auto p-5">
      <Show when={props.error} fallback={null}>
        {(error) => (
          <p class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950 dark:text-red-400">
            {error()}
          </p>
        )}
      </Show>

      {/* ── name + description ───────────────────────────────────────── */}
      <section class="mt-5">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">Details</h3>
        <label class="mt-2 block text-xs text-neutral-400">Name</label>
        <Show
          when={props.canEdit}
          fallback={<p class="mt-1 text-sm font-medium">{props.board.name}</p>}
        >
          <form
            class="mt-1 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const name = nameDraft().trim();
              if (name && name !== props.board.name) props.onRename(name);
            }}
          >
            <input
              class="flex-1"
              value={nameDraft()}
              maxlength="80"
              onInput={(event) => setNameDraft(event.currentTarget.value)}
            />
            <button
              type="submit"
              disabled={nameDraft().trim() === props.board.name}
              class="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              Save
            </button>
          </form>
        </Show>

        <label class="mt-3 block text-xs text-neutral-400">
          Description <span class="text-neutral-300">(markdown — shown on this board)</span>
        </label>
        <Show
          when={descriptionDraft() !== null || props.canEdit}
          fallback={
            <p class="prose-card mt-1 text-sm text-neutral-600 dark:text-neutral-300">
              {props.board.description || <span class="text-neutral-400">No description</span>}
            </p>
          }
        >
          <Show
            when={descriptionDraft() !== null}
            fallback={
              <button
                type="button"
                class="mt-1 w-full rounded-lg border border-dashed border-neutral-300 px-3 py-2 text-left text-xs text-neutral-500 hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-600"
                onClick={() => setDescriptionDraft(props.board.description)}
              >
                {props.board.description ? 'Edit description…' : '+ Add a description…'}
              </button>
            }
          >
            <form
              class="mt-1 space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                saveDescription();
              }}
            >
              <textarea
                class="w-full"
                rows={4}
                maxlength={4000}
                placeholder="What is this board for? Scope, goals, links…"
                value={description()}
                onInput={(event) => setDescriptionDraft(event.currentTarget.value)}
              />
              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  class="rounded-lg px-3 py-1.5 text-xs font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  onClick={() => setDescriptionDraft(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                >
                  Save
                </button>
              </div>
            </form>
          </Show>
        </Show>
      </section>

      {/* ── per-member access to this board ──────────────────────────── */}
      <section class="mt-6">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Access on this board
        </h3>
        <Show
          when={props.isWsAdmin}
          fallback={
            <p class="mt-2 text-xs text-neutral-400">
              Only workspace owners and admins can change board access.
            </p>
          }
        >
          <p class="mt-1 text-xs text-neutral-400">
            Members start with no access — grant view or write per board. Changes reach everyone on
            this board instantly.
          </p>
        </Show>
        <ul class="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
          <For each={props.detail.members}>
            {(member) => {
              const current = () => accessOf(member);
              const grantable = () => props.onIsGrantable(member);
              return (
                <li class="flex items-center gap-3 py-2.5">
                  <Avatar
                    src={member.avatar_url}
                    name={member.display_name}
                    email={member.email}
                    size="sm"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium">
                      {member.display_name ?? member.email}
                      <Show when={member.user_id === props.meId}>
                        <span class="ml-1 text-xs font-normal text-neutral-400">(you)</span>
                      </Show>
                    </span>
                    <span class="block truncate text-xs text-neutral-400">
                      {member.role} · workspace member
                    </span>
                  </span>
                  <Show
                    when={grantable() && props.isWsAdmin}
                    fallback={
                      <span
                        title={
                          current() === 'edit'
                            ? 'Always write via their workspace role or board ownership'
                            : 'No access yet'
                        }
                        class={`rounded-full px-2.5 py-1 text-xs font-medium ${
                          current() === 'edit'
                            ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                            : current() === 'view'
                              ? 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                              : 'bg-neutral-100 text-neutral-400 dark:bg-neutral-800'
                        }`}
                      >
                        {current() === 'edit' ? 'Write' : current() === 'view' ? 'View' : 'None'}
                      </span>
                    }
                  >
                    <div class="flex rounded-lg border border-neutral-200 p-0.5 dark:border-neutral-700">
                      <For each={ACCESS_OPTIONS}>
                        {(option) => (
                          <button
                            type="button"
                            title={option.hint}
                            class={`rounded-md px-2.5 py-1 text-xs font-medium ${
                              current() === option.value
                                ? 'bg-indigo-600 text-white'
                                : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                            }`}
                            onClick={() => props.onChangeAccess(member.user_id, option.value)}
                          >
                            {option.label}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </section>

      {/* ── mention access: who may let people in ────────────────────── */}
      <section class="mt-6">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Mention access
        </h3>
        <div class="mt-2 flex items-start gap-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
          <button
            type="button"
            role="switch"
            aria-checked={props.accessDelegation ? 'true' : 'false'}
            disabled={!props.isWsAdmin}
            title={
              props.isWsAdmin
                ? 'Toggle who may grant access when someone is mentioned without it'
                : 'Only workspace owners and admins can change this'
            }
            class={`relative h-6 w-11 shrink-0 rounded-full transition ${
              props.accessDelegation ? 'bg-indigo-600' : 'bg-neutral-300 dark:bg-neutral-700'
            } ${props.isWsAdmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
            onClick={() => props.onToggleDelegation(!props.accessDelegation)}
          >
            <span
              class={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                props.accessDelegation ? 'left-[1.375rem]' : 'left-0.5'
              }`}
            />
          </button>
          <div class="min-w-0">
            <p class="text-sm font-medium">Anyone with access can grant board access</p>
            <p class="mt-0.5 text-xs leading-relaxed text-neutral-400">
              When someone is mentioned but can’t see this board:{' '}
              <span class={props.accessDelegation ? 'text-indigo-600 dark:text-indigo-400' : ''}>
                {props.accessDelegation
                  ? 'the author can let them in directly and notify them.'
                  : 'the author can only ask the workspace owners/admins to grant access.'}
              </span>{' '}
              Owners and admins can always grant, either way.
            </p>
          </div>
        </div>
      </section>

      {/* ── teams: grant the whole team access to this board ──────── */}
      <section class="mt-6">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">Team access</h3>
        <Show
          when={(props.detail.teams.length ?? 0) > 0}
          fallback={
            <p class="mt-2 text-xs text-neutral-400">
              No teams yet — create them from the workspace members page.
            </p>
          }
        >
          <p class="mt-1 text-xs text-neutral-400">
            Granting a team access gives every member that access (individuals can still be tuned
            above).
          </p>
          <ul class="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
            <For each={props.detail.teams}>
              {(team) => {
                const current = () =>
                  (props.detail.teamAccess[props.boardId] ?? []).find(
                    (grant) => grant.teamId === team.id,
                  )?.access ?? null;
                const canManage = () =>
                  props.isWsAdmin ||
                  team.members.some(
                    (member) => member.user_id === props.meId && member.role === 'admin',
                  );
                return (
                  <li class="flex items-center gap-3 py-2.5">
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm font-medium">
                        @{team.name}
                        <Show when={team.members.some((m) => m.role === 'admin')}>
                          <span class="ml-1 text-[10px] font-normal text-neutral-400">
                            · {team.members.filter((m) => m.role === 'admin').length} admin
                            {team.members.filter((m) => m.role === 'admin').length === 1 ? '' : 's'}
                          </span>
                        </Show>
                      </span>
                      <span class="block truncate text-xs text-neutral-400">
                        {team.members.length} member{team.members.length === 1 ? '' : 's'}
                      </span>
                    </span>
                    <Show
                      when={canManage()}
                      fallback={
                        <span
                          class={`rounded-full px-2.5 py-1 text-xs font-medium ${
                            current() === 'edit'
                              ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                              : current() === 'view'
                                ? 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                                : 'bg-neutral-100 text-neutral-400 dark:bg-neutral-800'
                          }`}
                        >
                          {current() === 'edit' ? 'Write' : current() === 'view' ? 'View' : 'None'}
                        </span>
                      }
                    >
                      <div class="flex rounded-lg border border-neutral-200 p-0.5 dark:border-neutral-700">
                        <For each={[null, 'view', 'edit'] as const}>
                          {(option) => (
                            <button
                              type="button"
                              class={`rounded-md px-2.5 py-1 text-xs font-medium ${
                                current() === option
                                  ? 'bg-indigo-600 text-white'
                                  : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                              }`}
                              onClick={() =>
                                void setBoardTeamAccess({
                                  boardId: props.boardId,
                                  teamId: team.id,
                                  access: option,
                                })
                                  .then(() => props.onTeamAccessChanged(team.id, option))
                                  .catch((error: unknown) => {
                                    props.onError(
                                      errorMessage(error, 'Could not change team access'),
                                    );
                                  })
                              }
                            >
                              {option === null ? 'None' : option === 'view' ? 'View' : 'Write'}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </section>

      {/* ── resolved cards: the time capsule's shelf (0059) ───────────── */}
      <section class="mt-6 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <h3 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
          <span>Resolved cards · {props.resolvedCards.length}</span>
          <a
            href={`/search?board=${props.boardId}&resolved=resolved`}
            class="rounded-md px-1.5 py-0.5 font-medium normal-case tracking-normal text-indigo-500 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950"
            title="Search this board's resolved cards — the search page's resolved view, board pre-filtered"
          >
            🔍 Search these
          </a>
        </h3>
        <p class="mt-1 text-xs text-neutral-400">
          Nothing is ever deleted — resolved cards hide from the board and stay fully editable.
          Unresolving returns them to their list.
        </p>
        <Show
          when={props.resolvedCards.length > 0}
          fallback={<p class="mt-2 text-xs text-neutral-400">No resolved cards on this board.</p>}
        >
          <ul class="mt-2 flex flex-col gap-1.5">
            <For each={props.resolvedCards.slice(0, resolvedShown())}>
              {(card) => (
                <li class="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-xs dark:border-neutral-700">
                  <span class="min-w-0 flex-1">
                    <span class="rounded bg-neutral-100 px-1 font-mono text-[10px] text-neutral-500 dark:bg-neutral-800">
                      #{card.number ?? '–'}
                    </span>{' '}
                    <span class="font-medium">{card.title}</span>
                    <span class="ml-2 text-neutral-400">
                      in {props.lists.find((l) => l.id === card.list_id)?.name ?? 'a deleted list'}
                    </span>
                  </span>
                  <span class="shrink-0 text-neutral-400">
                    {new Date(card.resolved_at!).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                  <button
                    type="button"
                    class="shrink-0 rounded-md px-2 py-1 font-semibold text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
                    onClick={() => props.onUnresolve(card.id)}
                  >
                    Unresolve
                  </button>
                </li>
              )}
            </For>
          </ul>
          <Show when={props.resolvedCards.length > resolvedShown()}>
            <button
              type="button"
              class="mt-2 w-full rounded-lg px-3 py-1.5 text-xs font-medium text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              onClick={() => setResolvedShown(resolvedShown() + 20)}
            >
              Show more ({props.resolvedCards.length - resolvedShown()} left)
            </button>
          </Show>
        </Show>
      </section>

      {/* ── danger zone ──────────────────────────────────────────────── */}
      <Show when={props.canDelete}>
        <section class="mt-6 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-red-500">Danger zone</h3>
          <p class="mt-1 text-xs text-neutral-400">
            Deleting removes the board, its lists, cards, and comments for everyone.
            <Show when={props.cardCount > 0}>
              {' '}
              Cards can never be deleted on their own — a board that holds them deletes only through
              this deliberate, typed confirmation.
            </Show>
          </p>
          <Show
            when={confirmingDelete()}
            fallback={
              <button
                type="button"
                class="mt-2 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950"
                onClick={() => {
                  setTypedConfirm('');
                  setConfirmingDelete(true);
                }}
              >
                Delete this board{props.cardCount > 0 ? ` (${props.cardCount} cards)` : ''}…
              </button>
            }
          >
            <Show
              when={props.cardCount === 0}
              fallback={
                <span class="mt-2 flex flex-col gap-2">
                  <span class="text-xs text-neutral-500 dark:text-neutral-400">
                    Type <span class="font-semibold">{props.board.name}</span> to permanently delete
                    this board and its {props.cardCount} card
                    {props.cardCount === 1 ? '' : 's'} (cards included — this is the capsule's one
                    sanctioned purge):
                  </span>
                  <input
                    class="max-w-xs"
                    value={typedConfirm()}
                    onInput={(event) => setTypedConfirm(event.currentTarget.value)}
                    placeholder={props.board.name}
                  />
                  <span class="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={props.deleting || typedConfirm() !== props.board.name}
                      class="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                      onClick={() => props.onDelete(true)}
                    >
                      {props.deleting ? 'Deleting…' : 'Purge everything permanently'}
                    </button>
                    <button
                      type="button"
                      class="text-xs font-medium text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                      onClick={() => setConfirmingDelete(false)}
                    >
                      Cancel
                    </button>
                  </span>
                </span>
              }
            >
              <span class="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  disabled={props.deleting}
                  class="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                  onClick={() => props.onDelete(false)}
                >
                  {props.deleting ? 'Deleting…' : 'Really delete everything?'}
                </button>
                <button
                  type="button"
                  class="text-xs font-medium text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </button>
              </span>
            </Show>
          </Show>
        </section>
      </Show>
    </div>
  );
}

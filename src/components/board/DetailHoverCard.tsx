// Extracted from the board route (phase 6): a panel is its own module
// so the route stays a wiring file (L5 rule 6).
import { For, Show, createEffect, createSignal } from 'solid-js';

import { Avatar } from '../Avatar';
import { TagChip } from '../TagChip';
import { statusOf, type PublicStatus } from '../../lib/status';
import { type CardView, type CrossCard, type ListRow } from '../../lib/boards';

import { type Member, type TeamView } from '../../lib/workspaces';

/** The floating detail card over @mentions and #citations: who a chip
 *  points at (person, card, tag, or team), rendered at the chip's
 *  rect — pure display, data via props. */
export function DetailHoverCard(props: {
  hover: { kind: 'user' | 'card' | 'tag' | 'team'; id: string; rect: DOMRect } | null;
  members: Member[];
  cards: CardView[];
  lists: ListRow[];
  crossCards: CrossCard[];
  /** The workspace's boards — the # menu offers cross-board citations
   *  (chips serialize as [name](board:<uuid>) → board backlinks). */
  workspaceBoards?: { id: string; name: string }[];
  workspaceTags: { id: string; name: string }[];
  teams: TeamView[];
  onOpenCard: (cardId: string, clientOp: string | null) => void;
}) {
  // Position: below-left of the target; when space runs short, anchor to
  // the viewport BOTTOM above the target (no guessed heights — the card
  // grows upward from the anchor edge).
  const position = () => {
    const h = props.hover;
    if (!h) return { left: '-9999px', top: '0px' } as const;
    const left = Math.min(Math.max(8, h.rect.left), Math.max(8, window.innerWidth - 288));
    if (h.rect.bottom + 240 <= window.innerHeight) {
      return { left: `${left}px`, top: `${h.rect.bottom + 8}px` } as const;
    }
    // Flip up: anchor the card's BOTTOM above the target.
    const bottom = Math.max(8, window.innerHeight - h.rect.top + 8);
    return { left: `${left}px`, bottom: `${bottom}px` } as const;
  };

  const member = () => props.members.find((m) => m.user_id === props.hover?.id);
  // The hovered user's live status (fetched per hover — statuses are
  // slow-moving; a fresh fetch per hover stays cheap).
  const [status, setStatus] = createSignal<PublicStatus | null>(null);
  createEffect(
    () => (props.hover?.kind === 'user' ? props.hover.id : null),
    (userId) => {
      setStatus(null);
      if (userId)
        void statusOf(userId)
          .then(setStatus)
          .catch(() => {});
    },
  );
  const crossCard = () => props.crossCards.find((c) => c.id === props.hover?.id);
  const card = () =>
    props.cards.find((c) => c.number === Number(props.hover?.id) || c.id === props.hover?.id);
  const tag = () => props.workspaceTags.find((t) => t.id === props.hover?.id);
  const list = () => props.lists.find((l) => l.id === card()?.list_id);
  const team = () => props.teams.find((t) => t.id === props.hover?.id);

  return (
    <Show when={props.hover}>
      <div
        class="pointer-events-none fixed z-[60] w-72 rounded-xl border border-neutral-200 bg-white p-3 text-left shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
        style={position()}
      >
        <Show
          when={props.hover!.kind === 'user' && member()}
          fallback={
            <Show
              when={props.hover!.kind === 'tag' && tag()}
              fallback={
                <Show
                  when={props.hover!.kind === 'card' && crossCard()}
                  fallback={
                    <Show
                      when={card()}
                      fallback={
                        <Show
                          when={team()}
                          fallback={<p class="text-xs text-neutral-400">Unknown reference</p>}
                        >
                          {(t) => (
                            <>
                              <div class="flex items-center gap-2">
                                <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-sm dark:bg-emerald-500/15">
                                  👥
                                </span>
                                <div class="min-w-0">
                                  <p class="truncate text-sm font-semibold">{t().name}</p>
                                  <p class="text-[10px] font-medium uppercase tracking-wider text-neutral-400">
                                    Team · {t().members.length} member
                                    {t().members.length === 1 ? '' : 's'}
                                  </p>
                                </div>
                              </div>
                              <Show when={t().description}>
                                <p class="mt-2 line-clamp-3 text-xs text-neutral-500 dark:text-neutral-400">
                                  {t().description}
                                </p>
                              </Show>
                              <Show when={t().members.length > 0}>
                                <div class="mt-2 flex items-center gap-1.5">
                                  <span class="flex -space-x-1.5">
                                    <For each={t().members.slice(0, 6)}>
                                      {(entry) => {
                                        const person = () =>
                                          props.members.find((m) => m.user_id === entry.user_id);
                                        return (
                                          <span class="rounded-full ring-2 ring-white dark:ring-neutral-900">
                                            <Avatar
                                              src={person()?.avatar_url}
                                              name={person()?.display_name}
                                              email={person()?.email}
                                              size="xs"
                                            />
                                          </span>
                                        );
                                      }}
                                    </For>
                                  </span>
                                  <Show when={t().members.length > 6}>
                                    <span class="text-[10px] text-neutral-400">
                                      +{t().members.length - 6}
                                    </span>
                                  </Show>
                                </div>
                              </Show>
                              <p class="mt-2 text-[10px] text-neutral-400">
                                Click to open the team page
                              </p>
                            </>
                          )}
                        </Show>
                      }
                    >
                      {(target) => (
                        <>
                          <div class="flex items-start gap-2">
                            <span class="rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                              #{target().number}
                            </span>
                            <p class="min-w-0 flex-1 break-words text-sm font-semibold">
                              {target().title}
                            </p>
                          </div>
                          <p class="mt-1 text-xs text-neutral-400">
                            in{' '}
                            <span class="font-medium text-neutral-500 dark:text-neutral-300">
                              {list()?.name ?? '…'}
                            </span>
                            <Show when={target().priority}> · {target().priority}</Show>
                          </p>
                          <Show when={(target().assignees ?? []).length > 0}>
                            <div class="mt-2 flex items-center gap-1.5">
                              <span class="flex -space-x-1.5">
                                <For each={target().assignees}>
                                  {(userId) => {
                                    const person = () =>
                                      props.members.find((m) => m.user_id === userId);
                                    return (
                                      <Avatar
                                        src={person()?.avatar_url}
                                        name={person()?.display_name}
                                        email={person()?.email}
                                        size="sm"
                                      />
                                    );
                                  }}
                                </For>
                              </span>
                              <span class="text-xs text-neutral-400">
                                {target().assignees.length} assigned
                              </span>
                            </div>
                          </Show>
                          <Show when={(target().tags ?? []).length > 0}>
                            <div class="mt-2 flex flex-wrap gap-1">
                              <For each={target().tags}>
                                {(cardTag) => (
                                  <TagChip tagId={cardTag.id} fallbackName={cardTag.name} />
                                )}
                              </For>
                            </div>
                          </Show>
                          <p class="mt-2 text-[10px] text-neutral-400">Click to open this card</p>
                        </>
                      )}
                    </Show>
                  }
                >
                  {(cross) => (
                    <>
                      <p class="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                        {cross().board_name}
                      </p>
                      <div class="mt-1 flex items-start gap-2">
                        <span class="rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                          #{cross().number}
                        </span>
                        <p class="min-w-0 flex-1 break-words text-sm font-semibold">
                          {cross().title}
                        </p>
                      </div>
                      <p class="mt-2 text-[10px] text-neutral-400">Click to open it on its board</p>
                    </>
                  )}
                </Show>
              }
            >
              {(t) => (
                <>
                  <p class="text-sm font-semibold text-sky-700 dark:text-sky-300">#{t().name}</p>
                  <p class="mt-1 text-xs text-neutral-400">
                    A tag shared across this workspace's cards.
                  </p>
                  <p class="mt-2 text-[10px] text-neutral-400">
                    Click to search cards with this tag
                  </p>
                </>
              )}
            </Show>
          }
        >
          {(person) => (
            <div class="flex items-center gap-2.5">
              <Avatar
                src={person().avatar_url}
                name={person().display_name}
                email={person().email}
                size="md"
              />
              <div class="min-w-0">
                <p class="truncate text-sm font-semibold">
                  {person().display_name ?? person().email}
                </p>
                <Show when={person().username}>
                  <p class="truncate text-xs text-neutral-400">@{person().username}</p>
                </Show>
                <Show when={person().email}>
                  <p class="truncate text-xs text-neutral-400">{person().email}</p>
                </Show>
                <Show when={status()}>
                  {(current) => (
                    <p class="mt-0.5 truncate text-xs font-medium text-indigo-600 dark:text-indigo-400">
                      {current().emoji ?? ''} {current().label ?? ''}
                      {current().dnd ? ' · 🔕 do not disturb' : ''}
                    </p>
                  )}
                </Show>
                <p class="mt-0.5 text-[10px] text-neutral-400">{person().role} of this workspace</p>
              </div>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}

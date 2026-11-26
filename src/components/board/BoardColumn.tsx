// Extracted from the board route (phase 6): a panel is its own module
// so the route stays a wiring file (L5 rule 6).
import { For, Show, createEffect, createSignal } from 'solid-js';

import { CardFace } from './CardFace';
import { type RemoteDrag } from '../../lib/presence';
import { type CardView, type ListRow } from '../../lib/boards';

import { type Member } from '../../lib/workspaces';

/** A card's full rendered content — everything a non-hovered card shows
 *  (title, meta row, description indicator, unseen badge). Shared by the
 *  real card article and the drag previews, so a preview IS the card it
 *  stands for: same content, same height, just inert — previews pass no
 *  onOpenDetails and sit inside pointer-events-none. */
export function BoardColumn(props: {
  list: ListRow;
  cards: CardView[];
  members: Member[];
  dragging: string | null;
  remoteDrag: RemoteDrag | null;
  dropHint: number | null;
  /** The dragged card's height — the ghost opens exactly that much space. */
  dragHeight: number | null;
  /** Another viewer's hover slot in this column (their ghost, live). */
  remoteDropHint: number | null;
  /** The dragged card itself — the ghost renders it as a live preview. */
  draggedCard: CardView | null;
  /** The remote-dragged card, when this board's view has it. */
  remoteDragCard: CardView | null;
  isTemp: boolean;
  canEdit: boolean;
  adding: boolean;
  onDragStart: (cardId: string, height: number) => void;
  onDragEnd: () => void;
  onDrop: (index: number, cardId: string | null) => void;
  onHover: (index: number) => void;
  onAdd: () => void;
  onCancelAdd: () => void;
  onSubmitAdd: (title: string) => void;
  onAddAnother: () => void;
  onRemove: () => void;
  onRename: (name: string) => void;
  onOpenCard: (cardId: string, clientOp: string | null) => void;
  /** Resolve (hide) the card — the time capsule's delete (0059). */
  onResolveCard: (cardId: string) => void;
  /** Per-device collapse state (a preference — "hide the done pile"). */
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const [renaming, setRenaming] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [keepOpen, setKeepOpen] = createSignal(false);

  // The glide: when the ghost placeholder opens, moves or closes, the
  // cards around it shift — FLIP-animating them makes the space open
  // smoothly instead of snapping, and the dropped card rides the same
  // animation from its old spot into the opened one. Measured with
  // offsetTop — LAYOUT position, immune to CSS transforms — because
  // getBoundingClientRect reflects an in-flight glide, and feeding that
  // back in compounds garbage deltas (the vanish glitch). The dropHint
  // setter dedupes identical indexes, so passes run only on real moves.
  const lastTops = new Map<string, number>();
  // Cards that left layout (the dragged source hides while its ghost
  // represents it) — measured tops would be garbage (offsetTop 0), and
  // the pre-hide top must survive so the reappearing card settles into
  // the ghost's slot instead of flying in from its old position.
  const hiddenIds = new Set<string>();
  createEffect(
    () => (props.dropHint, props.remoteDropHint, props.cards, props.dragging),
    () => {
      const els = document.querySelectorAll<HTMLElement>(
        `[data-column="${props.list.id}"] [data-card-id]`,
      );
      const seen = new Set<string>();
      for (const el of els) {
        const id = el.dataset.cardId!;
        seen.add(id);
        // Hidden (display:none): no layout, nothing to animate — remember
        // it was hidden so its return lands without a phantom glide.
        if (el.offsetHeight === 0) {
          hiddenIds.add(id);
          continue;
        }
        const top = el.offsetTop;
        if (hiddenIds.has(id)) {
          // Reappeared: the ghost already held this slot — settle in place.
          hiddenIds.delete(id);
          lastTops.set(id, top);
          continue;
        }
        const prev = lastTops.get(id);
        lastTops.set(id, top);
        if (prev === undefined || prev === top) continue;
        el.style.transition = 'none';
        el.style.transform = `translateY(${prev - top}px)`;
        void el.offsetHeight; // reflow — the inverted position commits
        el.style.transition = 'transform 160ms ease-out';
        el.style.transform = '';
        // Clear the inline transition once the glide lands: an inline
        // style beats the Tailwind transition class, and a lingering one
        // makes this card's hover border/shadow animate instantly.
        el.addEventListener(
          'transitionend',
          () => {
            el.style.transition = '';
          },
          { once: true },
        );
      }
      // Prune cards gone from the column (deleted, moved away) — the map
      // stays column-sized over a long session.
      for (const id of lastTops.keys()) if (!seen.has(id)) lastTops.delete(id);
      for (const id of hiddenIds.keys()) if (!seen.has(id)) hiddenIds.delete(id);
    },
  );

  // Where in this column a pointer sits: the index the dropped card takes.
  // Measured in LAYOUT space (offsetTop, immune to the FLIP's in-flight
  // glide transforms) with the ghost's footprint subtracted from every
  // card at or below its slot — the pointer's own placeholder can never
  // move the goalposts it is measured against, and a mid-glide dragover
  // reads the settled position, not the animating one.
  const indexAt = (clientY: number): number => {
    const container = document.querySelector<HTMLElement>(
      `[data-column="${props.list.id}"] [data-cards-scroll]`,
    );
    if (!container) return 0;
    const els = container.querySelectorAll<HTMLElement>('[data-card]');
    // The dragged source hides (display:none) but stays counted here: the
    // slot space must stay the full list planDrop indexes into. Its
    // degenerate midpoint (anchor + 0 + 0) can never win a comparison for
    // a pointer inside the column, so its slot is skipped naturally and
    // the hidden card never corrupts the measurement.
    // Viewport anchor of the container's content — transform-immune (the
    // container itself never glides; only cards do).
    const anchor =
      container.getBoundingClientRect().top - container.scrollTop - container.offsetTop;
    const ghost = container.querySelector<HTMLElement>('[data-drop-placeholder]');
    // Single-drag design: only the FIRST placeholder is compensated — a
    // concurrent peer ghost in this column can skew slots near it by one
    // (self-corrects as ghosts move). If multi-drag ever becomes real,
    // sum every placeholder's height instead.
    const shift = ghost ? ghost.offsetHeight + 8 : 0; // + the flex gap-2
    const ghostAt = props.dropHint ?? -1;
    let index = els.length;
    for (let i = 0; i < els.length; i++) {
      const el = els[i]!;
      const mid = anchor + el.offsetTop + el.offsetHeight / 2;
      if (clientY < (i >= ghostAt ? mid - shift : mid)) {
        index = i;
        break;
      }
    }
    return index;
  };

  return (
    <section
      data-column={props.list.id}
      class={[
        'flex shrink-0 flex-col rounded-2xl border border-neutral-200/80 bg-neutral-100/60 dark:border-neutral-800 dark:bg-neutral-900/70',
        props.collapsed ? 'w-56' : 'w-72',
        { 'animate-pulse': props.isTemp },
      ]}
      onDragOver={(event) => {
        if (!props.dragging) return;
        event.preventDefault();
        props.onHover(indexAt(event.clientY));
      }}
      onDrop={(event) => {
        event.preventDefault();
        props.onDrop(indexAt(event.clientY), props.dragging);
      }}
    >
      <header class="flex items-center justify-between gap-2 px-3 pt-3">
        <Show
          when={!renaming()}
          fallback={
            <form
              class="flex-1"
              onSubmit={(event) => {
                event.preventDefault();
                const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
                if (name) props.onRename(name);
                setRenaming(false);
              }}
            >
              <input
                name="name"
                value={props.list.name}
                class="w-full px-2 py-0.5 text-sm font-semibold"
                onBlur={() => setRenaming(false)}
              />
            </form>
          }
        >
          <Show
            when={props.canEdit}
            fallback={
              <span class="rounded-md px-1.5 py-0.5 text-sm font-semibold">{props.list.name}</span>
            }
          >
            <button
              type="button"
              class="rounded-md px-1.5 py-0.5 text-sm font-semibold hover:bg-neutral-200/70 dark:hover:bg-neutral-800"
              title="Rename list"
              onClick={() => setRenaming(true)}
            >
              {props.list.name}
            </button>
          </Show>
        </Show>
        <div class="flex items-center gap-1.5 text-xs text-neutral-400">
          <button
            type="button"
            title={props.collapsed ? 'Expand list' : 'Collapse list'}
            class="rounded-md px-1 hover:text-neutral-700 dark:hover:text-neutral-200"
            onClick={props.onToggleCollapse}
          >
            {props.collapsed ? '▸' : '▾'}
          </button>
          <span class="rounded-full bg-neutral-200/80 px-1.5 py-0.5 font-medium dark:bg-neutral-800">
            {props.cards.length}
          </span>
          <Show
            when={!confirming()}
            fallback={
              <button
                type="button"
                class="rounded-md bg-red-100 px-1.5 py-0.5 text-red-600 dark:bg-red-950 dark:text-red-400"
                onClick={() => props.onRemove()}
              >
                Sure?
              </button>
            }
          >
            <Show when={props.canEdit}>
              <button
                type="button"
                title="Delete list"
                class="rounded-md px-1 hover:text-red-500"
                onClick={() => setConfirming(true)}
              >
                ×
              </button>
            </Show>
          </Show>
        </div>
      </header>

      <Show when={!props.collapsed}>
        <div data-cards-scroll class="flex flex-1 flex-col gap-2 overflow-y-auto p-2.5">
          <For each={props.cards}>
            {(card, index) => (
              <>
                <Show when={props.dropHint === index()}>
                  {/* The ghost is the card itself: a faded, inert clone of
                    the dragged card (Trello's placeholder) gliding where
                    the drop would land — hover the original spot and the
                    card appears to never have left. Fixed height = the
                    real card's measured height, so the drop handoff is a
                    1:1 swap. shrink-0: a scrolling column is over-full
                    and flex compresses contentless children to their
                    border — without it the ghost collapses to a line. */}
                  <Show
                    when={props.draggedCard}
                    fallback={
                      <div
                        data-drop-placeholder
                        class="shrink-0 rounded-xl border-2 border-dashed border-indigo-400/70 bg-indigo-50/60 dark:border-indigo-500/50 dark:bg-indigo-500/10"
                        style={{ height: `${props.dragHeight ?? 72}px` }}
                      />
                    }
                  >
                    {(card) => (
                      <div
                        data-drop-placeholder
                        class="pointer-events-none shrink-0 rounded-xl border border-neutral-200/80 bg-white p-3 text-sm opacity-70 shadow-xs dark:border-neutral-700/80 dark:bg-neutral-900"
                        style={{ height: `${props.dragHeight ?? 72}px` }}
                      >
                        <CardFace card={card()} members={props.members} />
                      </div>
                    )}
                  </Show>
                </Show>
                <Show
                  when={props.remoteDropHint === index() && props.remoteDropHint !== props.dropHint}
                >
                  {/* A peer's card in flight: their live preview clone —
                    amber-ringed with the mover's name, so viewers watch
                    the card itself move. Dashed fallback when this view
                    can't see the card (e.g. a still-materializing temp).
                    Skipped when the local ghost already occupies the slot. */}
                  <Show
                    when={props.remoteDragCard}
                    fallback={
                      <div
                        data-drop-placeholder
                        class="flex shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-amber-400/70 bg-amber-50/60 dark:border-amber-500/50 dark:bg-amber-500/10"
                        style={{ height: `${props.remoteDrag?.height ?? 72}px` }}
                      >
                        <span class="truncate px-2 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                          {props.remoteDrag?.name} moving…
                        </span>
                      </div>
                    }
                  >
                    {(card) => (
                      <div
                        data-drop-placeholder
                        class="pointer-events-none relative shrink-0 rounded-xl border-2 border-amber-400/80 bg-white p-3 text-sm shadow-xs dark:border-amber-500/70 dark:bg-neutral-900"
                        style={{ height: `${props.remoteDrag?.height ?? 72}px` }}
                      >
                        <span class="absolute -top-2 left-2 rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-semibold text-amber-950">
                          {props.remoteDrag?.name} moving…
                        </span>
                        <CardFace card={card()} members={props.members} />
                      </div>
                    )}
                  </Show>
                </Show>
                <article
                  data-card
                  data-card-id={card.id}
                  draggable={props.canEdit ? 'true' : undefined}
                  onDragStart={(event) => {
                    if (!props.canEdit) return;
                    const transfer = event.dataTransfer;
                    if (transfer) {
                      transfer.effectAllowed = 'move';
                      transfer.setData('text/plain', card.id);
                    }
                    props.onDragStart(card.id, event.currentTarget.getBoundingClientRect().height);
                  }}
                  onDragEnd={props.onDragEnd}
                  onClick={() => props.onOpenCard(card.id, card.client_op)}
                  class={[
                    'group relative cursor-pointer rounded-xl border border-neutral-200/80 bg-white p-3 text-sm shadow-xs transition hover:border-indigo-300 hover:shadow-sm active:cursor-grabbing dark:border-neutral-700/80 dark:bg-neutral-900 dark:hover:border-indigo-700',
                    // Trello model: while dragged, the source card leaves the
                    // list (display:none — zero space) so the ghost is its ONLY
                    // representation; hover the original spot and the ghost is
                    // the one placeholder there, never shadow + ghost both.
                    // The element stays in the DOM so dragend always fires,
                    // and indexAt/planDrop keep their shared full-list index
                    // space (the hidden card's degenerate midpoint can never
                    // win a comparison for a pointer inside the column).
                    // …and for peers the whole drag through: the dragstart
                    // broadcast carries the card's home slot, so its preview
                    // appears at the original spot from the first message —
                    // the card hides for the ENTIRE drag, never reappearing
                    // "at home" while the hover travels other lists.
                    {
                      hidden: props.dragging === card.id || props.remoteDrag?.cardId === card.id,
                    },
                  ]}
                >
                  <CardFace
                    card={card}
                    members={props.members}
                    onOpenDetails={() => props.onOpenCard(card.id, card.client_op)}
                  />
                  <Show when={props.canEdit}>
                    <button
                      type="button"
                      title="Resolve card — hides it from the board, nothing is deleted"
                      class="absolute right-2 top-2 hidden rounded px-1 text-neutral-300 hover:text-neutral-600 group-hover:block dark:text-neutral-600 dark:hover:text-neutral-300"
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onResolveCard(card.id);
                      }}
                    >
                      ✓
                    </button>
                  </Show>
                </article>
              </>
            )}
          </For>
          <Show when={props.dropHint === props.cards.length && props.cards.length > 0}>
            <Show
              when={props.draggedCard}
              fallback={
                <div
                  data-drop-placeholder
                  class="shrink-0 rounded-xl border-2 border-dashed border-indigo-400/70 bg-indigo-50/60 dark:border-indigo-500/50 dark:bg-indigo-500/10"
                  style={{ height: `${props.dragHeight ?? 72}px` }}
                />
              }
            >
              {(card) => (
                <div
                  data-drop-placeholder
                  class="pointer-events-none shrink-0 rounded-xl border border-neutral-200/80 bg-white p-3 text-sm opacity-70 shadow-xs dark:border-neutral-700/80 dark:bg-neutral-900"
                  style={{ height: `${props.dragHeight ?? 72}px` }}
                >
                  <CardFace card={card()} members={props.members} />
                </div>
              )}
            </Show>
          </Show>
          <Show
            when={
              props.remoteDropHint === props.cards.length && props.remoteDropHint !== props.dropHint
            }
          >
            {/* A peer hovering past the last card — no length guard, unlike
              the local site: an empty column has no ringed source card to
              signal the drag, so the preview is the only thing peers see. */}
            <Show
              when={props.remoteDragCard}
              fallback={
                <div
                  data-drop-placeholder
                  class="flex shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-amber-400/70 bg-amber-50/60 dark:border-amber-500/50 dark:bg-amber-500/10"
                  style={{ height: `${props.remoteDrag?.height ?? 72}px` }}
                >
                  <span class="truncate px-2 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                    {props.remoteDrag?.name} moving…
                  </span>
                </div>
              }
            >
              {(card) => (
                <div
                  data-drop-placeholder
                  class="pointer-events-none relative shrink-0 rounded-xl border-2 border-amber-400/80 bg-white p-3 text-sm shadow-xs dark:border-amber-500/70 dark:bg-neutral-900"
                  style={{ height: `${props.remoteDrag?.height ?? 72}px` }}
                >
                  <span class="absolute -top-2 left-2 rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-semibold text-amber-950">
                    {props.remoteDrag?.name} moving…
                  </span>
                  <CardFace card={card()} members={props.members} />
                </div>
              )}
            </Show>
          </Show>

          {/* Add-card (editors only): the input ALWAYS clears instantly on
            submit (the card appears immediately via the engine) — optionally
            stays open for the next card ("add another"), never blocked by
            the server. Viewers see no editing surface at all. */}
          <Show when={props.canEdit}>
            <Show
              when={props.adding || keepOpen()}
              fallback={
                <button
                  type="button"
                  class="rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                  onClick={() => {
                    setKeepOpen(true);
                    props.onAdd();
                  }}
                >
                  + Add card
                </button>
              }
            >
              <form
                class="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const title = String(new FormData(form).get('title') ?? '').trim();
                  if (title) {
                    props.onSubmitAdd(title);
                    if (keepOpen()) {
                      form.reset();
                      form.querySelector('textarea')?.focus();
                    }
                  }
                }}
              >
                <textarea name="title" rows={2} placeholder="Card title…" autofocus />
                <div class="flex items-center gap-2">
                  <button
                    type="submit"
                    class="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
                  >
                    Add
                  </button>
                  <Show
                    when={keepOpen()}
                    fallback={
                      <button
                        type="button"
                        class="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                        title="Keep the form open to add several cards"
                        onClick={() => setKeepOpen(true)}
                      >
                        Add another ↵
                      </button>
                    }
                  >
                    <button
                      type="button"
                      class="text-xs font-medium text-indigo-600 dark:text-indigo-400"
                      title="Close the form"
                      onClick={() => {
                        setKeepOpen(false);
                        props.onCancelAdd();
                      }}
                    >
                      Done
                    </button>
                  </Show>
                </div>
              </form>
            </Show>
          </Show>
        </div>
      </Show>
    </section>
  );
}

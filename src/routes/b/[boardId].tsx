import { Title } from '@solidjs/meta';
import type { RouteProps } from '@solidjs/router';
import { For, Loading, Show, createEffect, createMemo, createSignal } from 'solid-js';

import { createBoardStore } from '../../lib/board-store';
import { addComment, getCardComments, type CardRow, type ListRow } from '../../lib/boards';

export default function Board(props: RouteProps<'/b/:boardId'>) {
  // One store, one live connection for the whole page.
  const { board, actions, status } = createBoardStore(() => props.params.boardId);
  const [dragging, setDragging] = createSignal<string | null>(null);
  const [dropHint, setDropHint] = createSignal<{ listId: string; index: number } | null>(null);
  const [openCardId, setOpenCardId] = createSignal<string | null>(null);
  const [addingIn, setAddingIn] = createSignal<string | null>(null);
  const [renaming, setRenaming] = createSignal(false);

  return (
    <>
      <Title>{board.board.name} - Flowdeck</Title>
      <main class="flex h-[calc(100vh-3rem)] flex-col overflow-hidden">
        <header class="flex items-center gap-3 border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
          <a
            href="/"
            class="rounded-md px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
            title="All boards"
          >
            ←
          </a>

          <Show
            when={!renaming()}
            fallback={
              <form
                class="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
                  if (name) actions.renameBoard(name);
                  setRenaming(false);
                }}
              >
                <input
                  name="name"
                  value={board.board.name}
                  class="max-w-64 py-1 text-base font-semibold"
                  autofocus
                  onBlur={() => setRenaming(false)}
                />
              </form>
            }
          >
            <button
              type="button"
              class="rounded-md px-2 py-1 text-base font-semibold tracking-tight hover:bg-neutral-100 dark:hover:bg-neutral-800"
              title="Rename board"
              onClick={() => setRenaming(true)}
            >
              {board.board.name}
            </button>
          </Show>

          <span class="ml-auto flex items-center gap-3 text-xs text-neutral-400">
            <Show when={status() === 'reconnecting'}>
              <span class="flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-amber-600 dark:bg-amber-950 dark:text-amber-400">
                <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                Reconnecting…
              </span>
            </Show>
            <Show when={status() === 'closed'}>
              <span class="rounded-full bg-red-50 px-2 py-0.5 text-red-600 dark:bg-red-950 dark:text-red-400">
                Offline
              </span>
            </Show>
            <span>
              {board.lists.length} lists · {board.cards.length} cards
            </span>
          </span>
        </header>

        <div class="flex flex-1 gap-4 overflow-x-auto p-4">
          <For each={board.lists}>
            {(list) => (
              <BoardColumn
                list={list}
                cards={board.cards.filter((card) => card.list_id === list.id)}
                dragging={dragging()}
                dropHint={dropHint()?.listId === list.id ? dropHint()!.index : null}
                onDragStart={(cardId) => setDragging(cardId)}
                onDragEnd={() => {
                  setDragging(null);
                  setDropHint(null);
                }}
                onDrop={(index) => {
                  const cardId = dragging();
                  setDragging(null);
                  setDropHint(null);
                  if (cardId) actions.moveCard(cardId, list.id, index);
                }}
                onHover={(index) => setDropHint({ listId: list.id, index })}
                adding={addingIn() === list.id}
                onAdd={() => setAddingIn(list.id)}
                onCancelAdd={() => setAddingIn(null)}
                onSubmitAdd={(title) => {
                  setAddingIn(null);
                  actions.addCard(list.id, title);
                }}
                onRemove={() => actions.removeList(list.id)}
                onRename={(name) => actions.renameList(list.id, name)}
                onOpenCard={(cardId) => setOpenCardId(cardId)}
                onRemoveCard={(cardId) => actions.removeCard(cardId)}
              />)}
          </For>

          <AddList onAdd={(name) => actions.addList(name)} />
        </div>
      </main>

      <Show when={openCardId()}>
        {(cardId) => (
          <CardDrawer
            board={board}
            cardId={cardId()}
            onClose={() => setOpenCardId(null)}
            onDelete={() => {
              actions.removeCard(cardId());
              setOpenCardId(null);
            }}
            onUpdate={(patch) => actions.updateCard(cardId(), patch)}
          />
        )}
      </Show>
    </>
  );
}

function BoardColumn(props: {
  list: ListRow;
  cards: CardRow[];
  dragging: string | null;
  dropHint: number | null;
  adding: boolean;
  onDragStart: (cardId: string) => void;
  onDragEnd: () => void;
  onDrop: (index: number) => void;
  onHover: (index: number) => void;
  onAdd: () => void;
  onCancelAdd: () => void;
  onSubmitAdd: (title: string) => void;
  onRemove: () => void;
  onRename: (name: string) => void;
  onOpenCard: (cardId: string) => void;
  onRemoveCard: (cardId: string) => void;
}) {
  const [renaming, setRenaming] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);

  // Where in this column a pointer sits: the index the dropped card takes.
  const indexAt = (clientY: number): number => {
    const elements = document.querySelectorAll<HTMLDivElement>(
      `[data-column="${props.list.id}"] [data-card]`,
    );
    let index = elements.length;
    for (let i = 0; i < elements.length; i++) {
      const rect = elements[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        index = i;
        break;
      }
    }
    return index;
  };

  return (
    <section
      data-column={props.list.id}
      class="flex w-72 shrink-0 flex-col rounded-2xl border border-neutral-200/80 bg-neutral-100/60 dark:border-neutral-800 dark:bg-neutral-900/70"
      onDragOver={(event) => {
        if (!props.dragging) return;
        event.preventDefault();
        props.onHover(indexAt(event.clientY));
      }}
      onDrop={(event) => {
        event.preventDefault();
        props.onDrop(indexAt(event.clientY));
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
          <button
            type="button"
            class="rounded-md px-1.5 py-0.5 text-sm font-semibold hover:bg-neutral-200/70 dark:hover:bg-neutral-800"
            title="Rename list"
            onClick={() => setRenaming(true)}
          >
            {props.list.name}
          </button>
        </Show>
        <div class="flex items-center gap-1.5 text-xs text-neutral-400">
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
            <button
              type="button"
              title="Delete list"
              class="rounded-md px-1 hover:text-red-500"
              onClick={() => setConfirming(true)}
            >
              ×
            </button>
          </Show>
        </div>
      </header>

      <div class="flex flex-1 flex-col gap-2 overflow-y-auto p-2.5">
        <For each={props.cards}>
          {(card, index) => (
            <>
              <Show when={props.dropHint === index() && props.dragging !== card.id}>
                <div class="h-1 rounded-full bg-indigo-500/60" />
              </Show>
              <article
                data-card
                draggable="true"
                onDragStart={(event) => {
                  const transfer = event.dataTransfer;
                  if (transfer) {
                    transfer.effectAllowed = 'move';
                    transfer.setData('text/plain', card.id);
                  }
                  props.onDragStart(card.id);
                }}
                onDragEnd={props.onDragEnd}
                onClick={() => props.onOpenCard(card.id)}
                class={[
                  'group relative cursor-pointer rounded-xl border border-neutral-200/80 bg-white p-3 text-sm shadow-xs transition hover:border-indigo-300 hover:shadow-sm active:cursor-grabbing dark:border-neutral-700/80 dark:bg-neutral-900 dark:hover:border-indigo-700',
                  { 'opacity-40': props.dragging === card.id },
                ]}
              >
                <p class="pr-5">{card.title}</p>
                <Show when={card.description}>
                  <p class="mt-1 line-clamp-2 text-xs text-neutral-400">{card.description}</p>
                </Show>
                <button
                  type="button"
                  title="Delete card"
                  class="absolute right-2 top-2 hidden rounded px-1 text-neutral-300 hover:text-red-500 group-hover:block dark:text-neutral-600"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onDragEnd();
                    // Optimistic remove via the store action wired by parent.
                    props.onRemoveCard(card.id);
                  }}
                >
                  ×
                </button>
              </article>
            </>
          )}
        </For>
        <Show when={props.dropHint === props.cards.length && props.cards.length > 0}>
          <div class="h-1 rounded-full bg-indigo-500/60" />
        </Show>

        <Show
          when={props.adding}
          fallback={
            <button
              type="button"
              class="rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              onClick={props.onAdd}
            >
              + Add card
            </button>
          }
        >
          <form
            class="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const title = String(new FormData(event.currentTarget).get('title') ?? '').trim();
              if (title) props.onSubmitAdd(title);
            }}
          >
            <textarea name="title" rows={2} placeholder="Card title…" autofocus />
            <div class="flex gap-2">
              <button
                type="submit"
                class="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                Add
              </button>
              <button
                type="button"
                class="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                onClick={props.onCancelAdd}
              >
                Cancel
              </button>
            </div>
          </form>
        </Show>
      </div>
    </section>
  );
}

function AddList(props: { onAdd: (name: string) => void }) {
  const [open, setOpen] = createSignal(false);
  return (
    <Show
      when={open()}
      fallback={
        <button
          type="button"
          class="h-10 w-72 shrink-0 rounded-2xl border border-dashed border-neutral-300 text-sm font-medium text-neutral-500 hover:border-neutral-400 hover:bg-neutral-100/60 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:bg-neutral-900/70"
          onClick={() => setOpen(true)}
        >
          + Add list
        </button>
      }
    >
      <form
        class="flex w-72 shrink-0 flex-col gap-2 rounded-2xl border border-neutral-200/80 bg-neutral-100/60 p-3 dark:border-neutral-800 dark:bg-neutral-900/70"
        onSubmit={(event) => {
          event.preventDefault();
          const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
          if (name) props.onAdd(name);
          setOpen(false);
        }}
      >
        <input name="name" placeholder="List name…" autofocus />
        <div class="flex gap-2">
          <button
            type="submit"
            class="rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
          >
            Add list
          </button>
          <button
            type="button"
            class="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
        </div>
      </form>
    </Show>
  );
}

/** The card detail drawer: edit title/description, comments, delete. */
function CardDrawer(props: {
  board: ReturnType<typeof createBoardStore>['board'];
  cardId: string;
  onClose: () => void;
  onDelete: () => void;
  onUpdate: (patch: { title?: string; description?: string }) => void;
}) {
  const card = createMemo(() => props.board.cards.find((c) => c.id === props.cardId));

  // Draft fields seed from the card once, then save on demand.
  const [titleDraft, setTitleDraft] = createSignal(card()?.title ?? '');
  const [descriptionDraft, setDescriptionDraft] = createSignal('');
  createEffect(() => card()?.title, (title) => {
    if (title !== undefined && !titleDraft()) setTitleDraft(title);
  });
  createEffect(() => card()?.description, (description) => {
    if (description !== undefined && !descriptionDraft()) setDescriptionDraft(description);
  });

  const comments = createMemo(() => getCardComments(props.cardId));
  const [commentDraft, setCommentDraft] = createSignal('');

  const saveTitle = () => {
    const title = titleDraft().trim();
    if (title && title !== card()?.title) props.onUpdate({ title });
  };
  const saveDescription = () => {
    const description = descriptionDraft();
    if (description !== card()?.description) props.onUpdate({ description });
  };

  return (
    <div
      class="fixed inset-0 z-50 flex justify-end bg-neutral-950/30 backdrop-blur-[1px]"
      onClick={props.onClose}
    >
      <aside
        class="flex h-full w-96 max-w-full flex-col gap-5 overflow-y-auto border-l border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
        onClick={(event) => event.stopPropagation()}
      >
        <div class="flex items-start justify-between gap-2">
          <input
            value={titleDraft()}
            class="flex-1 border-0 bg-transparent px-0 py-0 text-lg font-semibold focus:border-0 focus:ring-0 dark:bg-transparent"
            onInput={(event) => setTitleDraft(event.currentTarget.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              }
            }}
          />
          <button
            type="button"
            class="rounded-md px-2 py-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            onClick={props.onClose}
          >
            ×
          </button>
        </div>

        <label class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Description
        </label>
        <textarea
          rows={4}
          placeholder="Add a description…"
          value={descriptionDraft()}
          onInput={(event) => setDescriptionDraft(event.currentTarget.value)}
          onBlur={saveDescription}
        />

        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Comments
          </span>
          <button
            type="button"
            class="text-xs font-medium text-red-500 hover:text-red-600"
            onClick={props.onDelete}
          >
            Delete card
          </button>
        </div>

        <Loading fallback={<p class="text-xs text-neutral-400">Loading comments…</p>}>
          <ul class="flex flex-col gap-3">
            <For each={comments()}>
              {(comment) => (
                <li class="rounded-lg bg-neutral-100 p-2.5 text-sm dark:bg-neutral-800/60">
                  <div class="flex items-baseline justify-between gap-2">
                    <span class="text-xs font-semibold">{comment.author}</span>
                    <time class="text-[11px] text-neutral-400">
                      {new Date(comment.created_at).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                  <p class="mt-0.5 whitespace-pre-wrap">{comment.body}</p>
                </li>
              )}
            </For>
          </ul>
        </Loading>

        <form
          class="mt-auto flex flex-col gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            const body = commentDraft().trim();
            if (!body) return;
            setCommentDraft('');
            await addComment(props.cardId, body);
          }}
        >
          <textarea
            rows={2}
            placeholder="Write a comment…"
            value={commentDraft()}
            onInput={(event) => setCommentDraft(event.currentTarget.value)}
          />
          <button
            type="submit"
            class="self-start rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
          >
            Comment
          </button>
        </form>
      </aside>
    </div>
  );
}

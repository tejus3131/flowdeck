import { Title } from '@solidjs/meta';
import type { RouteProps } from '@solidjs/router';
import { For, Loading, Show, createMemo, createSignal } from 'solid-js';

import { createBoardStore } from '../../lib/board-store';
import type { CardRow, ListRow } from '../../lib/boards';

// Drop-target bookkeeping shared by the columns during a drag.
type DragState = { cardId: string } | null;

export default function Board(props: RouteProps<'/b/:boardId'>) {
  // One store, one live connection for the whole page.
  const { board, actions } = createBoardStore(() => props.params.boardId);
  const [dragging, setDragging] = createSignal<DragState>(null);
  const [dropHint, setDropHint] = createSignal<{ listId: string; index: number } | null>(null);
  const [addingIn, setAddingIn] = createSignal<string | null>(null);

  return (
    <Loading fallback={<div class="p-6 text-sm text-neutral-500">Loading board…</div>}>
      <Title>{board.board.name} - Flowdeck</Title>
      <main class="flex h-[calc(100vh-49px)] flex-col overflow-hidden">
        <header class="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <h1 class="text-lg font-semibold tracking-tight">{board.board.name}</h1>
          <span class="text-xs text-neutral-400">
            {board.lists.length} lists · {board.cards.length} cards
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
                onDragStart={(cardId) => setDragging({ cardId })}
                onDragEnd={() => {
                  setDragging(null);
                  setDropHint(null);
                }}
                onDrop={(index) => {
                  const cardId = dragging()?.cardId;
                  setDragging(null);
                  setDropHint(null);
                  if (cardId) actions.moveCard(cardId, list.id, index);
                }}
                onHover={(index) => setDropHint({ listId: list.id, index })}
                onAdd={() => setAddingIn(list.id)}
                onCancelAdd={() => setAddingIn(null)}
                adding={addingIn() === list.id}
                onSubmitAdd={(title) => {
                  setAddingIn(null);
                  actions.addCard(list.id, title);
                }}
                onRemove={() => actions.removeList(list.id)}
              />
            )}
          </For>

          <AddList onAdd={(name) => actions.addList(name)} />
        </div>
      </main>
    </Loading>
  );
}

function BoardColumn(props: {
  list: ListRow;
  cards: CardRow[];
  dragging: DragState;
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
}) {
  let addForm: HTMLFormElement | undefined;

  // Where in this column a pointer sits: -1 (above all), 0..n-1 (between
  // cards i-1 and i), n (below all).
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
      class="flex w-72 shrink-0 flex-col rounded-xl border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/60"
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
      <header class="flex items-center justify-between px-3 pt-3">
        <h2 class="text-sm font-semibold">{props.list.name}</h2>
        <div class="flex items-center gap-2 text-xs text-neutral-400">
          <span>{props.cards.length}</span>
          <button
            type="button"
            title="Delete list"
            class="hover:text-red-500"
            onClick={() => props.onRemove()}
          >
            ×
          </button>
        </div>
      </header>

      <div class="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
        <For each={props.cards}>
          {(card, index) => (
            <>
              <Show when={props.dropHint === index()}>
                <div class="h-0.5 rounded bg-neutral-400 dark:bg-neutral-500" />
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
                class="cursor-grab rounded-lg border border-neutral-200 bg-white p-3 text-sm shadow-sm hover:border-neutral-300 active:cursor-grabbing dark:border-neutral-800 dark:bg-neutral-900"
              >
                <p>{card.title}</p>
              </article>
            </>
          )}
        </For>
        <Show when={props.dropHint === props.cards.length}>
          <div class="h-0.5 rounded bg-neutral-400 dark:bg-neutral-500" />
        </Show>

        <Show
          when={props.adding}
          fallback={
            <button
              type="button"
              class="rounded-lg border border-dashed border-neutral-300 px-3 py-2 text-left text-xs text-neutral-500 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
              onClick={props.onAdd}
            >
              + Add card
            </button>
          }
        >
          <form
            ref={addForm}
            class="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const title = new FormData(event.currentTarget).get('title');
              if (String(title ?? '').trim()) props.onSubmitAdd(String(title).trim());
            }}
          >
            <textarea
              name="title"
              rows={2}
              placeholder="Card title…"
              class="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <div class="flex gap-2">
              <button
                type="submit"
                class="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-white dark:text-neutral-900"
              >
                Add
              </button>
              <button
                type="button"
                class="text-xs text-neutral-500 hover:text-neutral-700"
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
          class="h-10 w-72 shrink-0 rounded-xl border border-dashed border-neutral-300 text-sm text-neutral-500 hover:border-neutral-400 dark:border-neutral-700"
          onClick={() => setOpen(true)}
        >
          + Add list
        </button>
      }
    >
      <form
        class="flex w-72 shrink-0 flex-col gap-2 rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900/60"
        onSubmit={(event) => {
          event.preventDefault();
          const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
          if (name) props.onAdd(name);
          setOpen(false);
        }}
      >
        <input
          name="name"
          placeholder="List name…"
          class="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          class="rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          Add list
        </button>
      </form>
    </Show>
  );
}

import { Title } from '@solidjs/meta';
import type { RouteProps } from '@solidjs/router';
import { liveQuery } from '@solidjs/router';
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';

import { createBoardEngine, BOARD_ENTITY } from '../../lib/sync';
import { createBoardPresence, presenceColor, type RemoteDrag } from '../../lib/presence';
import { getMe } from '../../lib/auth';
import {
  addComment,
  boardStream,
  createBoard,
  createCard,
  createList,
  deleteCard,
  deleteList,
  getCardComments,
  moveCard as moveCardServer,
  renameBoard as renameBoardServer,
  renameList as renameListServer,
  updateCard as updateCardServer,
  type BoardSnapshot,
  type CardRow,
  type ListRow,
} from '../../lib/boards';

const EMPTY: BoardSnapshot = {
  board: { id: '', name: '', owner_id: '', workspace_id: null, created_at: '', updated_at: '' },
  lists: [],
  cards: [],
  revision: 0,
  myAccess: null,
};

/** Fractional position for a card dropped at display index `toIndex`. */
function positionAt(cards: CardRow[], listId: string, toIndex: number): number {
  const positions = cards
    .filter((card) => card.list_id === listId)
    .map((card) => card.position)
    .sort((a, b) => a - b);
  const prev = positions[toIndex - 1];
  const next = positions[toIndex];
  if (prev === undefined && next === undefined) return 1;
  if (prev === undefined) return next / 2;
  if (next === undefined) return prev + 1;
  return (prev + next) / 2;
}

const OP_LABELS: Record<string, string> = {
  addCard: 'Couldn\u2019t add that card',
  moveCard: 'Couldn\u2019t move that card',
  deleteCard: 'Couldn\u2019t delete that card',
  updateCard: 'Couldn\u2019t save that card',
  addList: 'Couldn\u2019t add that list',
  deleteList: 'Couldn\u2019t delete that list',
  renameList: 'Couldn\u2019t rename that list',
  renameBoard: 'Couldn\u2019t rename the board',
};

export default function Board(props: RouteProps<'/b/:boardId'>) {
  // liveQuery: one shared channel per board, request-scoped on the server
  // (SSR renders the first value and closes), reconnecting on the client.
  const boardLive = liveQuery(boardStream, 'board');
  const engine = createBoardEngine(
    (boardId) => boardLive(boardId),
    () => props.params.boardId,
    EMPTY,
    () => boardLive.status(props.params.boardId),
  );
  const view = engine.view;
  const me = createMemo(() => getMe());
  const presence = createBoardPresence(props.params.boardId, () => me());

  const [dragging, setDragging] = createSignal<string | null>(null);
  const [dropHint, setDropHint] = createSignal<{ listId: string; index: number } | null>(null);
  const [openCardId, setOpenCardId] = createSignal<string | null>(null);
  const [addingIn, setAddingIn] = createSignal<string | null>(null);
  const [renamingBoard, setRenamingBoard] = createSignal(false);

  // ── engine ops: instant local apply, server ACK, echo retirement ──────
  const addCard = (listId: string, title: string) => {
    const tempId = crypto.randomUUID();
    const position =
      (view().cards.filter((c) => c.list_id === listId).reduce((max, c) => Math.max(max, c.position), 0) || 0) + 1;
    engine.mutate({
      kind: 'addCard',
      guards: [tempId],
      tempIds: [tempId],
      apply: (draft) => {
        draft.cards.push({
          id: tempId,
          board_id: draft.board.id,
          list_id: listId,
          title,
          description: '',
          position,
          assignee_id: null,
          created_by: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      },
      send: () => createCard(listId, title),
      echo: (d) => d.cards.some((c) => c.list_id === listId && c.title === title),
    });
  };

  const moveCard = (cardId: string, toListId: string, toIndex: number) => {
    const position = positionAt(view().cards, toListId, toIndex);
    engine.mutate({
      kind: 'moveCard',
      guards: [cardId],
      apply: (draft) => {
        const card = draft.cards.find((c) => c.id === cardId);
        if (!card) return;
        card.list_id = toListId;
        card.position = position;
      },
      send: () => moveCardServer(cardId, toListId, position),
      echo: (d) => {
        const card = d.cards.find((c) => c.id === cardId);
        return !!card && card.list_id === toListId && card.position === position;
      },
    });
  };

  const removeCard = (cardId: string) => {
    engine.mutate({
      kind: 'deleteCard',
      guards: [cardId],
      apply: (draft) => {
        draft.cards = draft.cards.filter((c) => c.id !== cardId);
      },
      send: () => deleteCard(cardId),
      echo: (d) => !d.cards.some((c) => c.id === cardId),
    });
  };

  const addList = (name: string) => {
    const tempId = crypto.randomUUID();
    const position = (view().lists.reduce((max, l) => Math.max(max, l.position), 0) || 0) + 1;
    engine.mutate({
      kind: 'addList',
      guards: [tempId],
      tempIds: [tempId],
      apply: (draft) => {
        draft.lists.push({
          id: tempId,
          board_id: draft.board.id,
          name,
          position,
          created_at: new Date().toISOString(),
        });
      },
      send: () => createList(props.params.boardId, name),
      echo: (d) => d.lists.some((l) => l.name === name),
    });
  };

  const removeList = (listId: string) => {
    engine.mutate({
      kind: 'deleteList',
      guards: [listId],
      apply: (draft) => {
        draft.lists = draft.lists.filter((l) => l.id !== listId);
        draft.cards = draft.cards.filter((c) => c.list_id !== listId);
      },
      send: () => deleteList(listId),
      echo: (d) => !d.lists.some((l) => l.id === listId),
    });
  };

  const renameList = (listId: string, name: string) => {
    engine.mutate({
      kind: 'renameList',
      guards: [listId],
      apply: (draft) => {
        const list = draft.lists.find((l) => l.id === listId);
        if (list) list.name = name;
      },
      send: () => renameListServer(listId, name),
      echo: (d) => d.lists.some((l) => l.id === listId && l.name === name),
    });
  };

  const renameBoard = (name: string) => {
    engine.mutate({
      kind: 'renameBoard',
      guards: [BOARD_ENTITY],
      apply: (draft) => {
        draft.board.name = name;
      },
      send: () => renameBoardServer(props.params.boardId, name),
      echo: (d) => d.board.name === name,
    });
  };

  const updateCard = (
    cardId: string,
    patch: { title?: string; description?: string },
  ) => {
    engine.mutate({
      kind: 'updateCard',
      guards: [cardId],
      apply: (draft) => {
        const card = draft.cards.find((c) => c.id === cardId);
        if (!card) return;
        if (patch.title !== undefined) card.title = patch.title;
        if (patch.description !== undefined) card.description = patch.description;
      },
      send: () => updateCardServer(cardId, patch),
      echo: (d) => {
        const card = d.cards.find((c) => c.id === cardId);
        if (!card) return false;
        if (patch.title !== undefined && card.title !== patch.title) return false;
        if (patch.description !== undefined && card.description !== patch.description) return false;
        return true;
      },
    });
  };

  const syncing = () => engine.ops().some((op) => op.status === 'inFlight');
  // Viewers see the board without the editing surface: no mutation UI, no
  // drag; their effective access comes with every snapshot.
  const canEdit = () => view().myAccess === 'edit';

  return (
    <>
      <Title>{view().board.name || 'Board'} - Flowdeck</Title>
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
            when={!renamingBoard()}
            fallback={
              <form
                class="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
                  if (name) renameBoard(name);
                  setRenamingBoard(false);
                }}
              >
                <input
                  name="name"
                  value={view().board.name}
                  class="max-w-64 py-1 text-base font-semibold"
                  autofocus
                  onBlur={() => setRenamingBoard(false)}
                />
              </form>
            }
          >
            <Show
              when={canEdit()}
              fallback={<span class="rounded-md px-2 py-1 text-base font-semibold tracking-tight">{view().board.name || '…'}</span>}
            >
              <button
                type="button"
                class="rounded-md px-2 py-1 text-base font-semibold tracking-tight hover:bg-neutral-100 dark:hover:bg-neutral-800"
                title="Rename board"
                onClick={() => setRenamingBoard(true)}
              >
                {view().board.name || '…'}
              </button>
            </Show>
          </Show>

          <Show when={!canEdit()}>
            <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300" title="An admin limited your access on this board">
              👁 View only
            </span>
          </Show>

          <span class="ml-auto flex items-center gap-2 text-xs text-neutral-400">
            <Show when={presence.others().length > 0}>
              <span class="flex -space-x-2">
                <For each={presence.others()}>
                  {(other) => (
                    <span
                      title={other.name}
                      class="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border-2 border-white text-[10px] font-semibold text-white dark:border-neutral-950"
                      style={{ 'background-color': presenceColor(other.userId) }}
                    >
                      <Show when={other.avatarUrl} fallback={other.name.slice(0, 2).toUpperCase()}>
                        <img src={other.avatarUrl!} alt={other.name} class="h-full w-full object-cover" />
                      </Show>
                    </span>
                  )}
                </For>
              </span>
            </Show>
            <Show when={syncing()}>
              <span class="flex items-center gap-1.5 rounded-full bg-neutral-100 px-2 py-0.5 dark:bg-neutral-800">
                <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" />
                Syncing
              </span>
            </Show>
            <Show when={engine.status() === 'reconnecting'}>
              <span class="flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-amber-600 dark:bg-amber-950 dark:text-amber-400">
                <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                Reconnecting…
              </span>
            </Show>
            <Show when={engine.status() === 'offline'}>
              <span class="rounded-full bg-red-50 px-2 py-0.5 text-red-600 dark:bg-red-950 dark:text-red-400">
                Offline
              </span>
            </Show>
            <Show when={view().lists.length > 0 || view().cards.length > 0}>
              <span>
                {view().lists.length} lists · {view().cards.length} cards
              </span>
            </Show>
          </span>
        </header>

        <div class="flex flex-1 gap-4 overflow-x-auto p-4">
          <For each={view().lists}>
            {(list) => (
              <BoardColumn
                list={list}
                cards={view().cards.filter((card) => card.list_id === list.id)}
                dragging={dragging()}
                remoteDrag={presence.remoteDrag()?.cardId === undefined ? null : presence.remoteDrag()}
                dropHint={dropHint()?.listId === list.id ? dropHint()!.index : null}
                isTemp={engine.isTemp(list.id)}
                canEdit={canEdit()}
                onDragStart={(cardId) => {
                  setDragging(cardId);
                  presence.broadcastDrag(cardId, me()?.display_name || 'Someone');
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDropHint(null);
                  presence.broadcastDrag(null, '');
                }}
                onDrop={(index, cardId) => {
                  setDragging(null);
                  setDropHint(null);
                  // Cards still materializing can't be dragged yet (their
                  // real id hasn't been echoed) — the drop is a no-op.
                  if (cardId && canEdit() && !engine.isTemp(cardId)) moveCard(cardId, list.id, index);
                }}                onHover={(index) => setDropHint({ listId: list.id, index })}
                adding={addingIn() === list.id}
                onAdd={() => setAddingIn(list.id)}
                onCancelAdd={() => setAddingIn(null)}
                onSubmitAdd={(title) => {
                  setAddingIn(null);
                  addCard(list.id, title);
                }}
                onAddAnother={() => setAddingIn(list.id)}
                onRemove={() => removeList(list.id)}
                onRename={(name) => renameList(list.id, name)}
                onOpenCard={(cardId) => setOpenCardId(cardId)}
                onRemoveCard={(cardId) => removeCard(cardId)}
              />
            )}
          </For>

          <Show when={canEdit()}>
            <AddList onAdd={addList} />
          </Show>
        </div>
      </main>

      <Show when={openCardId()}>
        {(cardId) => (
          <CardDrawer
            cardId={cardId()}
            cards={view().cards}
            canEdit={canEdit()}
            onClose={() => setOpenCardId(null)}
            onDelete={() => {
              removeCard(cardId());
              setOpenCardId(null);
            }}
            onUpdate={(patch) => updateCard(cardId(), patch)}
          />
        )}
      </Show>

      <FailureToasts
        failures={engine.failed()}
        onRetry={engine.retry}
        onDismiss={engine.dismiss}
      />
    </>
  );
}

function BoardColumn(props: {
  list: ListRow;
  cards: CardRow[];
  dragging: string | null;
  remoteDrag: RemoteDrag | null;
  dropHint: number | null;
  isTemp: boolean;
  canEdit: boolean;
  adding: boolean;
  onDragStart: (cardId: string) => void;
  onDragEnd: () => void;
  onDrop: (index: number, cardId: string | null) => void;
  onHover: (index: number) => void;
  onAdd: () => void;
  onCancelAdd: () => void;
  onSubmitAdd: (title: string) => void;
  onAddAnother: () => void;
  onRemove: () => void;
  onRename: (name: string) => void;
  onOpenCard: (cardId: string) => void;
  onRemoveCard: (cardId: string) => void;
}) {
  const [renaming, setRenaming] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [keepOpen, setKeepOpen] = createSignal(false);

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
      class={[
        'flex w-72 shrink-0 flex-col rounded-2xl border border-neutral-200/80 bg-neutral-100/60 dark:border-neutral-800 dark:bg-neutral-900/70',
        { 'animate-pulse': props.isTemp },
      ]}      onDragOver={(event) => {
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

      <div class="flex flex-1 flex-col gap-2 overflow-y-auto p-2.5">
        <For each={props.cards}>
          {(card, index) => (
            <>
              <Show when={props.dropHint === index() && props.dragging !== card.id}>
                <div class="h-1 rounded-full bg-indigo-500/60" />
              </Show>
              <article
                data-card
                draggable={props.canEdit ? 'true' : undefined}
                onDragStart={(event) => {
                  if (!props.canEdit) return;
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
                  { 'ring-2 ring-amber-400': props.remoteDrag?.cardId === card.id },
                ]}
              >
                <Show when={props.remoteDrag?.cardId === card.id}>
                  <span class="absolute -top-2 left-2 rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-semibold text-amber-950">
                    {props.remoteDrag!.name} moving…
                  </span>
                </Show>
                <p class="pr-5">{card.title}</p>
                <Show when={card.description}>
                  <p class="mt-1 line-clamp-2 text-xs text-neutral-400">{card.description}</p>
                </Show>
                <Show when={props.canEdit}>
                  <button
                    type="button"
                    title="Delete card"
                    class="absolute right-2 top-2 hidden rounded px-1 text-neutral-300 hover:text-red-500 group-hover:block dark:text-neutral-600"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onRemoveCard(card.id);
                    }}
                  >
                    ×
                  </button>
                </Show>
              </article>
            </>
          )}
        </For>
        <Show when={props.dropHint === props.cards.length && props.cards.length > 0}>
          <div class="h-1 rounded-full bg-indigo-500/60" />
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
          const form = event.currentTarget;
          const name = String(new FormData(form).get('name') ?? '').trim();
          if (name) props.onAdd(name);
          form.reset();
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
  cardId: string;
  cards: CardRow[];
  canEdit: boolean;
  onClose: () => void;
  onDelete: () => void;
  onUpdate: (patch: { title?: string; description?: string }) => void;
}) {
  const card = createMemo(() => props.cards.find((c) => c.id === props.cardId));

  // Draft fields seed from the card, then save on demand.
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
            readonly={props.canEdit ? undefined : true}
            class="flex-1 border-0 bg-transparent px-0 py-0 text-lg font-semibold focus:border-0 focus:ring-0 dark:bg-transparent"
            onInput={(event) => {
              if (props.canEdit) setTitleDraft(event.currentTarget.value);
            }}
            onBlur={() => {
              if (props.canEdit) saveTitle();
            }}
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
          placeholder={props.canEdit ? 'Add a description…' : ''}
          readonly={props.canEdit ? undefined : true}
          value={descriptionDraft()}
          onInput={(event) => {
            if (props.canEdit) setDescriptionDraft(event.currentTarget.value);
          }}
          onBlur={() => {
            if (props.canEdit) saveDescription();
          }}
        />

        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Comments
          </span>
          <Show when={props.canEdit}>
            <button
              type="button"
              class="text-xs font-medium text-red-500 hover:text-red-600"
              onClick={props.onDelete}
            >
              Delete card
            </button>
          </Show>
        </div>

        <Show
          when={comments()}
          fallback={<p class="text-xs text-neutral-400">Loading comments…</p>}
        >
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
        </Show>

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

/** Bottom-right stack of retryable failures — the engine's error surface. */
function FailureToasts(props: {
  failures: { id: string; kind: string; error?: string }[];
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <div class="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      <For each={props.failures}>
        {(failure) => (
          <div class="flex items-start gap-3 rounded-xl border border-red-200 bg-white p-3 text-sm shadow-lg dark:border-red-900 dark:bg-neutral-900">
            <div class="flex-1">
              <p class="font-medium">{OP_LABELS[failure.kind] ?? 'Something went wrong'}</p>
              <p class="mt-0.5 text-xs text-neutral-400">{failure.error}</p>
            </div>
            <button
              type="button"
              class="rounded-md bg-indigo-600 px-2 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
              onClick={() => props.onRetry(failure.id)}
            >
              Retry
            </button>
            <button
              type="button"
              class="rounded-md px-1.5 py-1 text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
              title="Dismiss"
              onClick={() => props.onDismiss(failure.id)}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

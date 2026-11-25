// The notification bell: a small button near the profile menu with a dot
// when something's unread, opening the inbox as a side panel — searchable,
// unread-only (checked rows disappear), one-click mark-read everywhere
// (optimistic, instant), and Grant/Deny right on access requests.
import { For, Show, createMemo, createSignal, onSettled } from 'solid-js';
import { liveQuery, useNavigate } from '@solidjs/router';

import { Avatar } from './Avatar';
import {
  markInboxSeen,
  markNotificationSeen,
  notificationsStream,
  type NotificationRow,
} from '../lib/notifications';
import { isChatRow, hrefToPath, notificationHref, notificationLine } from '../lib/notification-text';
import { isRowSeen, markSeenOptimistic } from '../lib/inbox-seen';
import { stampBoardChatSeen } from '../lib/board-chat-seen';
import { markSeen } from '../lib/seen';
import { getMe } from '../lib/auth';
import { AccessRequestActions, InviteActions, inviteTokenOf } from './AccessRequestActions';

export function NotificationBell() {
  const navigate = useNavigate();
  const me = createMemo(() => getMe());
  const inboxLive = liveQuery(notificationsStream, 'inbox');
  const [rows, setRows] = createSignal<NotificationRow[]>([]);
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [showRead, setShowRead] = createSignal(false);
  const [showChat, setShowChat] = createSignal(false);
  // Answers given from the panel, by notification id — an invite stays
  // locked in its answered state even across bell re-opens (the invite
  // itself and the workspace membership live server-side).
  const [inviteAnswers, setInviteAnswers] = createSignal<Record<string, 'accepted' | 'declined'>>({});
  let root: HTMLDivElement | undefined;

  // The inbox is live; rows land here once (shared liveQuery channel).
  onSettled(() => {
    void (async () => {
      try {
        for await (const next of await inboxLive()) {
          setRows(next);
        }
      } catch {
        // best effort — the bell still opens with whatever it has
      }
    })();
    const onPointerDown = (event: MouseEvent) => {
      if (open() && root && !root.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open()) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  });

  const nonChat = () => rows().filter((row) => !isChatRow(row));
  const unread = () => nonChat().filter((row) => !isRowSeen(row));
  const shown = () => {
    const q = query().trim().toLowerCase();
    const list = (showRead() ? nonChat() : unread()).filter(
      (row) => !q || JSON.stringify(row).toLowerCase().includes(q),
    );
    return list.slice(0, 40);
  };
  const chatRows = () => rows().filter((row) => isChatRow(row) && !isRowSeen(row));
  const chatCount = () => chatRows().length;

  const openRow = (row: NotificationRow) => {
    markSeenOptimistic(row.id);
    clearIndicators(row);
    void markNotificationSeen(row.id).catch(() => {});
    navigate(hrefToPath(notificationHref(row)));
    setOpen(false);
  };

  /** Reading a chat/mention row clears its on-screen indicator too:
   *  the board chat's dot and the card's unseen-comments badge. */
  const clearIndicators = (row: NotificationRow) => {
    if (row.kind !== 'chat' && row.kind !== 'mention' && row.kind !== 'comment') return;
    if (row.card_id) markSeen(row.card_id, Number.MAX_SAFE_INTEGER);
    // The board stamp advances to the notification's instant (server
    // clock) — never the client's wall clock, which could run fast and
    // permanently swallow future messages into "seen".
    else if (row.board_id) stampBoardChatSeen(row.board_id, +new Date(row.created_at));
  };

  const readOne = (row: NotificationRow) => {
    markSeenOptimistic(row.id);
    clearIndicators(row);
    void markNotificationSeen(row.id).catch(() => {});
  };

  const readAll = () => {
    for (const row of unread()) clearIndicators(row);
    markSeenOptimistic(...unread().map((row) => row.id));
    void markInboxSeen().catch(() => {});
  };

  return (
    <div ref={root} class="relative">
      <button
        type="button"
        title="Notifications"
        aria-label={`Notifications${unread().length > 0 ? ` (${unread().length} unread)` : ''}`}
        class="relative rounded-lg px-2 py-1 text-lg text-neutral-500 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        onClick={() => setOpen(!open())}
      >
        🔔
        <Show when={unread().length > 0}>
          <span class="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-indigo-600 px-1 text-[9px] font-bold text-white">
            {unread().length > 9 ? '9+' : unread().length}
          </span>
        </Show>
      </button>

      <Show when={open()}>
        <aside
          class="fixed right-0 top-12 z-[60] flex h-[calc(100vh-3rem)] w-full max-w-sm flex-col border-l border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
          onClick={(event) => event.stopPropagation()}
        >
          <header class="flex items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
            <h2 class="text-sm font-semibold tracking-tight">
              Notifications
              <Show when={unread().length > 0}>
                <span class="ml-1.5 rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  {unread().length}
                </span>
              </Show>
            </h2>
            <div class="flex items-center gap-2 text-xs">
              <Show when={unread().length > 0}>
                <button
                  type="button"
                  class="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                  onClick={readAll}
                >
                  Mark all read
                </button>
              </Show>
              <button
                type="button"
                class={`font-medium ${
                  showRead()
                    ? 'text-indigo-600 dark:text-indigo-400'
                    : 'text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300'
                }`}
                onClick={() => setShowRead(!showRead())}
              >
                {showRead() ? 'Unread only' : 'Show read'}
              </button>
              <button
                type="button"
                title="Close"
                class="rounded-md px-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
          </header>

          <div class="border-b border-neutral-100 px-4 py-2 dark:border-neutral-800">
            <input
              type="search"
              placeholder="Search notifications…"
              class="w-full text-sm"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto">
            <Show
              when={shown().length > 0}
              fallback={
                <p class="px-4 py-10 text-center text-sm text-neutral-400">
                  {unread().length === 0 && !showRead() ? 'All caught up 🎉' : 'Nothing matches that search.'}
                </p>
              }
            >
              <ul class="divide-y divide-neutral-100 dark:divide-neutral-800">
                <For each={shown()}>
                  {(row) => {
                    const line = () => notificationLine(row, me()?.id ?? null);
                    return (
                      <li class="flex items-start gap-2.5 px-4 py-3">
                        <Show
                          when={row.actor_name}
                          fallback={<span class="mt-0.5 h-7 w-7 shrink-0 rounded-full bg-neutral-200 dark:bg-neutral-700" />}
                        >
                          <Avatar name={row.actor_name} size="sm" />
                        </Show>
                        <button
                          type="button"
                          class="min-w-0 flex-1 text-left"
                          onClick={() => openRow(row)}
                        >
                          <span class="block text-sm leading-snug">{line().text}</span>
                          <Show when={line().detail}>
                            <span class="block truncate text-xs text-neutral-400">{line().detail}</span>
                          </Show>
                          <span class="mt-0.5 block text-[11px] text-neutral-400">
                            {new Date(row.created_at).toLocaleString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </span>
                        </button>
                        <Show
                          when={row.kind === 'access_request'}
                          fallback={
                            <Show when={row.kind === 'invite' && inviteTokenOf(row)}>
                              <InviteActions
                                row={row}
                                done={inviteAnswers()[row.id] ?? null}
                                onDone={(state) => {
                                  // Lock THIS row and every sibling row
                                  // carrying the same invite token (a
                                  // re-invite made multiple notifications).
                                  const token = inviteTokenOf(row);
                                  setInviteAnswers((current) => {
                                    const next = { ...current, [row.id]: state };
                                    for (const other of rows()) {
                                      if (other.id !== row.id && inviteTokenOf(other) === token) {
                                        next[other.id] = state;
                                      }
                                    }
                                    return next;
                                  });
                                  // A decline shouldn't keep begging for
                                  // attention — read it too.
                                  if (state === 'declined') void markNotificationSeen(row.id).catch(() => {});
                                  markSeenOptimistic(row.id);
                                }}
                              />
                            </Show>
                          }
                        >
                          <AccessRequestActions row={row} />
                        </Show>
                        {/* No action buttons → the plain mark-read affordance
                            (only while unread). */}
                        <Show when={row.kind !== 'access_request' && row.kind !== 'invite'}>
                          <Show when={!isRowSeen(row)}>
                            <button
                              type="button"
                              title="Mark as read"
                              class="shrink-0 rounded-md px-1.5 py-1 text-xs text-neutral-300 hover:bg-neutral-100 hover:text-indigo-600 dark:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-indigo-400"
                              onClick={() => readOne(row)}
                            >
                              ✓
                            </button>
                          </Show>
                        </Show>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Show>

            {/* The quiet chat section — hidden by default (Slack-style:
                no sound, not in the badge), one toggle away. */}
            <Show when={chatCount() > 0}>
              <div class="border-t border-neutral-100 px-4 py-2 dark:border-neutral-800">
                <button
                  type="button"
                  class="flex w-full items-center justify-between rounded-lg px-1 py-1 text-xs font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                  onClick={() => setShowChat(!showChat())}
                >
                  <span>
                    💬 Chat activity{chatCount() > 0 ? ` · ${chatCount()} new` : ''}
                  </span>
                  <span>{showChat() ? '▴' : '▾'}</span>
                </button>
                <Show when={showChat()}>
                  <ul class="mt-1 divide-y divide-neutral-100 dark:divide-neutral-800">
                    <For each={chatRows().slice(0, 20)}>
                      {(row) => {
                        const line = () => notificationLine(row, me()?.id ?? null);
                        return (
                          <li class="flex items-start gap-2 py-2">
                            <Avatar name={row.actor_name} size="sm" />
                            <button
                              type="button"
                              class="min-w-0 flex-1 text-left"
                              onClick={() => openRow(row)}
                            >
                              <span class="block truncate text-xs text-neutral-500 dark:text-neutral-300">
                                {line().text}
                              </span>
                              <Show when={line().detail}>
                                <span class="block truncate text-[11px] text-neutral-400">
                                  {line().detail}
                                </span>
                              </Show>
                            </button>
                            <button
                              type="button"
                              title="Mark as read"
                              class="shrink-0 rounded-md px-1 text-[11px] text-neutral-300 hover:text-indigo-600 dark:text-neutral-600"
                              onClick={() => readOne(row)}
                            >
                              ✓
                            </button>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </Show>
              </div>
            </Show>
          </div>
        </aside>
      </Show>
    </div>
  );
}

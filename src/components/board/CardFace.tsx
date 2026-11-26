// Extracted from the board route (phase 6): a panel is its own module
// so the route stays a wiring file (L5 rule 6).
import { For, Show } from 'solid-js';

import { Avatar } from '../Avatar';
import { PriorityPill } from '../PriorityPill';
import { TagChip } from '../TagChip';
import { unseenCount } from '../../lib/seen';
import type { CardView } from '../../lib/boards';
import type { Member } from '../../lib/workspaces';

export function CardFace(props: { card: CardView; members: Member[]; onOpenDetails?: () => void }) {
  return (
    <>
      <p class="pr-5">{props.card.title}</p>
      <div class="mt-1 flex flex-wrap items-center gap-1">
        <Show when={props.card.priority}>
          {(priority) => <PriorityPill priority={priority()} />}
        </Show>
        <For each={props.card.tags.slice(0, 3)}>
          {(tag) => <TagChip tagId={tag.id} fallbackName={tag.name} />}
        </For>
        <span class="flex -space-x-1.5">
          <For each={props.card.assignees.slice(0, 4)}>
            {(userId) => {
              const member = () => props.members.find((m) => m.user_id === userId);
              return (
                <span
                  class="rounded-full ring-1 ring-white dark:ring-neutral-900"
                  title={`Assigned to ${member()?.display_name ?? userId}`}
                >
                  <Avatar
                    src={member()?.avatar_url}
                    name={member()?.display_name}
                    email={member()?.email}
                    size="sm"
                  />
                </span>
              );
            }}
          </For>
          <Show when={props.card.assignees.length > 4}>
            <span class="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-200 text-[10px] font-semibold text-neutral-600 ring-1 ring-white dark:bg-neutral-700 dark:text-neutral-200 dark:ring-neutral-900">
              +{props.card.assignees.length - 4}
            </span>
          </Show>
        </span>
      </div>
      <Show when={props.card.description}>
        <button
          type="button"
          class="mt-1 text-[11px] font-medium text-neutral-400 hover:text-indigo-500 dark:hover:text-indigo-400"
          onClick={(event) => {
            event.stopPropagation();
            props.onOpenDetails?.();
          }}
        >
          ☰ Details
        </button>
      </Show>
      <Show when={unseenCount(props.card) > 0}>
        <span
          title="New comments — open the card to clear"
          class="mt-1.5 inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
        >
          💬 {unseenCount(props.card)} new
        </span>
      </Show>
    </>
  );
}

// The org → entity → action permission picker, shared by the OAuth
// consent page and the connections page. This is the main permissions
// UX: orgs and entities are collapsible; every collapsible carries a
// tri-state checkbox (empty = nothing, ✓ = everything offered, – = some);
// actions react to dependencies both ways (enabling a write switches its
// read on; disabling a read switches dependents off); and each org shows
// only what the user's own role there allows — admins see member + admin
// actions, owners see everything, and board creation appears only where
// that workspace's policy permits it for this user.
import { For, Show, createSignal } from 'solid-js';

import {
  ACCOUNT_ENTITIES,
  WORKSPACE_ENTITIES,
  actionOffered,
  capFromChoice,
  offeredActions,
  toggleActionInSelection,
  toggleEntityInSelection,
  toggleWorkspaceInSelection,
  type PermissionAction,
  type PermissionSelection,
  type WorkspaceSelection,
} from '../lib/mcp-permissions';

type WsChoice = {
  id: string;
  name: string;
  role: 'member' | 'admin' | 'owner';
  board_creation: string;
  is_team_admin: boolean;
};

/** Tri-state indicator: null unchecked, true checked, false indeterminate. */
function TriState(props: { state: boolean | null; onChange: () => void; label?: string }) {
  return (
    <button
      type="button"
      aria-label={props.label ?? 'toggle all'}
      onClick={(event) => {
        event.stopPropagation();
        props.onChange();
      }}
      class={[
        'flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border text-[10px] font-bold leading-none',
        props.state === null
          ? 'border-neutral-300 bg-white text-transparent hover:border-indigo-400 dark:border-neutral-600 dark:bg-neutral-900'
          : 'border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500',
      ]}
    >
      {props.state === false ? '–' : props.state === true ? '✓' : ''}
    </button>
  );
}

export function PermissionPicker(props: {
  selection: PermissionSelection;
  workspaces: WsChoice[];
  onChange: (next: PermissionSelection) => void;
}) {
  // The first org starts expanded — via the signal's lazy initializer,
  // never a write during render.
  const [openOrgs, setOpenOrgs] = createSignal<Set<string>>(
    () => new Set(props.workspaces.slice(0, 1).map((ws) => ws.id)),
  );
  const [openEntities, setOpenEntities] = createSignal<Set<string>>(new Set());

  const capOf = (ws: WsChoice) => capFromChoice(ws);

  const toggleIn = (set: () => Set<string>, key: string) =>
    set().has(key)
      ? new Set([...set()].filter((k) => k !== key))
      : new Set([...set(), key]);

  /** Entity tri-state inside a bucket. */
  const entityState = (
    bucket: 'workspaces' | 'account',
    bucketId: string | null,
    entityId: string,
    cap: ReturnType<typeof capOf> | null,
  ): boolean | null => {
    const entities = bucket === 'workspaces' ? WORKSPACE_ENTITIES : ACCOUNT_ENTITIES;
    const entity = entities.find((e) => e.id === entityId);
    if (!entity) return null;
    const sel =
      bucket === 'workspaces'
        ? props.selection.workspaces[bucketId ?? '']?.[entityId] ?? []
        : props.selection.account[entityId] ?? [];
    const offered = offeredActions(entity, cap).map((a) => a.id);
    if (offered.length === 0) return null;
    if (sel.length === 0) return null;
    if (offered.every((id) => sel.includes(id))) return true;
    return false;
  };

  /** Org tri-state. */
  const orgState = (ws: WsChoice): boolean | null => {
    const cap = capOf(ws);
    const sel = props.selection.workspaces[ws.id] ?? {};
    let some = false;
    for (const entity of WORKSPACE_ENTITIES) {
      const offered = offeredActions(entity, cap);
      if (offered.length === 0) continue;
      const ids = sel[entity.id] ?? [];
      if (ids.length > 0) some = true;
      if (!offered.every((a) => ids.includes(a.id))) return some ? false : null;
    }
    return some ? true : null;
  };

  const orgRow = (ws: WsChoice) => {
    const cap = capOf(ws);
    const key = ws.id;
    const expanded = () => openOrgs().has(key);
    return (
      <div class="rounded-xl border border-neutral-200 dark:border-neutral-800">
        <div class="flex items-center gap-2 px-3 py-2.5">
          <TriState
            state={orgState(ws)}
            label={`toggle everything in ${ws.name}`}
            onChange={() =>
              props.onChange(toggleWorkspaceInSelection(props.selection, ws.id, cap))
            }
          />
          <button
            type="button"
            class="flex flex-1 items-center justify-between text-left"
            onClick={() => setOpenOrgs(toggleIn(openOrgs, key))}
          >
            <span class="text-sm font-medium">{ws.name}</span>
            <span class="text-xs text-neutral-400">{expanded() ? '▲' : '▼'}</span>
          </button>
        </div>
        <Show when={expanded()}>
          {/* An unselected org grants nothing (its key is gone from the
              selection), so there is nothing to expand into — show a hint
              instead of the entity list. This is also what keeps an
              entity from being opened while its org is off. */}
          <Show
            when={props.selection.workspaces[ws.id]}
            fallback={
              <p class="border-t border-neutral-200 px-3 py-2.5 text-xs text-neutral-400 dark:border-neutral-800">
                No access granted — turn this workspace on to choose what the agent may do in it.
              </p>
            }
          >
            <div class="border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <For each={WORKSPACE_ENTITIES}>
                {(entity) => (
                  <Show when={offeredActions(entity, cap).length > 0}>
                    {entityRow('workspaces', ws.id, entity.id, cap)}
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    );
  };

  const entityRow = (
    bucket: 'workspaces' | 'account',
    bucketId: string | null,
    entityId: string,
    cap: ReturnType<typeof capOf> | null,
  ) => {
    const entities = bucket === 'workspaces' ? WORKSPACE_ENTITIES : ACCOUNT_ENTITIES;
    const entity = entities.find((e) => e.id === entityId)!;
    const key = `${bucket === 'workspaces' ? bucketId : '*'}:${entityId}`;
    const expanded = () => openEntities().has(key);
    const bucketSel = () =>
      bucket === 'workspaces'
        ? // An unselected org has no key in the selection — never read
          // through undefined (expanding an entity while its org is off
          // used to crash here).
          props.selection.workspaces[bucketId ?? ''] ?? {}
        : props.selection.account;
    /** One checkbox row for an action. */
    const actionCheckbox = (action: PermissionAction) => (
      <label class="flex items-start gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
        <input
          type="checkbox"
          class="mt-0.5"
          checked={(bucketSel()[entityId] ?? []).includes(action.id)}
          onChange={(event) =>
            props.onChange(
              toggleActionInSelection(
                props.selection,
                bucket,
                bucketId,
                entityId,
                action.id,
                event.currentTarget.checked,
              ),
            )
          }
        />
        <span>
          {action.label}
          <Show when={action.hint}>
            <span class="block text-[10px] text-neutral-400">{action.hint}</span>
          </Show>
        </span>
      </label>
    );
    return (
      <div class="mb-1.5 rounded-lg bg-neutral-50 dark:bg-neutral-900/50">
        <div class="flex items-center gap-2 px-2.5 py-2">
          <TriState
            state={entityState(bucket, bucketId, entityId, cap)}
            label={`toggle all ${entity.label}`}
            onChange={() =>
              props.onChange(toggleEntityInSelection(props.selection, bucket, bucketId, entityId, cap))
            }
          />
          <button
            type="button"
            class="flex flex-1 items-center justify-between text-left"
            onClick={() => setOpenEntities(toggleIn(openEntities, key))}
          >
            <span class="text-sm font-medium">{entity.label}</span>
            <span class="text-xs text-neutral-400">{expanded() ? '▲' : '▼'}</span>
          </button>
        </div>
        <Show when={expanded()}>
          <div class="grid grid-cols-1 gap-1.5 border-t border-neutral-200 px-3 py-2 sm:grid-cols-2 dark:border-neutral-700">
            <For each={offeredActions(entity, cap)}>
              {(action) => actionCheckbox(action)}
            </For>
          </div>
        </Show>
      </div>
    );
  };

  return (
    <div class="flex flex-col gap-2">
      <For each={props.workspaces}>{(ws) => orgRow(ws)}</For>

      <div class="rounded-xl border border-neutral-200 dark:border-neutral-800">
        <div class="flex items-center justify-between px-3 py-2.5 text-sm font-medium">
          <span>Across your account</span>
          <span class="text-xs font-normal text-neutral-400">outside any single workspace</span>
        </div>
        <div class="border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <For each={ACCOUNT_ENTITIES}>
            {(entity) => entityRow('account', null, entity.id, null)}
          </For>
        </div>
      </div>

      <p class="text-xs text-neutral-400">
        Writes switch their reads on automatically, and switching a read off switches every
        dependent write off — a write without its read can't be granted.
      </p>
    </div>
  );
}

// Re-export for callers that need the raw helpers (tests, prose).
export { actionOffered };
export type { WorkspaceSelection };

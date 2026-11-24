// The org → entity → action permission picker, shared by the OAuth
// consent page and the connections page. Writes imply reads; every
// workspace starts with the read-only default; the account bucket holds
// the actions that live outside any single workspace.
import { For, Show } from 'solid-js';

import {
  ACCOUNT_ENTITIES,
  WORKSPACE_ENTITIES,
  defaultWorkspaceSelection,
  type PermissionSelection,
  type WorkspaceSelection,
} from '../lib/mcp-permissions';

export function PermissionPicker(props: {
  selection: PermissionSelection;
  workspaces: { id: string; name: string; role: string }[];
  onChange: (next: PermissionSelection) => void;
}) {
  const workspaceOn = (wsId: string) => Object.keys(props.selection.workspaces).includes(wsId);
  const toggleWorkspace = (wsId: string, on: boolean) => {
    const next: PermissionSelection = { ...props.selection, workspaces: { ...props.selection.workspaces } };
    if (on) next.workspaces[wsId] = defaultWorkspaceSelection();
    else delete next.workspaces[wsId];
    props.onChange(next);
  };
  /** Toggling a write on pulls its implied read along (no write-without-read). */
  const toggleAction = (
    bucket: 'workspaces' | 'account',
    bucketId: string,
    entityId: string,
    actionId: string,
    implies: string | undefined,
    on: boolean,
  ) => {
    const bucketSel = { ...props.selection[bucket] } as Record<string, WorkspaceSelection>;
    const sel: WorkspaceSelection = { ...bucketSel[bucketId] };
    const ids = new Set<string>(sel[entityId] ?? []);
    if (on) {
      ids.add(actionId);
      if (implies) ids.add(implies);
    } else {
      ids.delete(actionId);
    }
    if (ids.size > 0) sel[entityId] = [...ids];
    else delete sel[entityId];
    bucketSel[bucketId] = sel;
    props.onChange({ ...props.selection, [bucket]: bucketSel } as PermissionSelection);
  };

  return (
    <div>
      <For each={props.workspaces}>
        {(ws) => (
          <div class="mb-3 rounded-xl border border-neutral-200 dark:border-neutral-800">
            <label class="flex items-center justify-between px-3 py-2 text-sm font-medium">
              <span class="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={workspaceOn(ws.id)}
                  onChange={(event) => toggleWorkspace(ws.id, event.currentTarget.checked)}
                />
                {ws.name}
                <span class="text-xs font-normal text-neutral-400">({ws.role})</span>
              </span>
              <span class="text-xs font-normal text-neutral-400">
                {workspaceOn(ws.id) ? 'granted' : 'no access'}
              </span>
            </label>
            <Show when={workspaceOn(ws.id)}>
              <div class="flex flex-col gap-2 border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <For each={WORKSPACE_ENTITIES}>
                  {(entity) => (
                    <div>
                      <p class="text-xs font-semibold text-neutral-500 dark:text-neutral-300">
                        {entity.label}
                      </p>
                      <div class="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
                        <For each={entity.actions}>
                          {(action) => {
                            const checked = () =>
                              (props.selection.workspaces[ws.id]?.[entity.id] ?? []).includes(action.id);
                            return (
                              <label class="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
                                <input
                                  type="checkbox"
                                  checked={checked()}
                                  onChange={(event) =>
                                    toggleAction(
                                      'workspaces',
                                      ws.id,
                                      entity.id,
                                      action.id,
                                      action.implies,
                                      event.currentTarget.checked,
                                    )
                                  }
                                />
                                {action.label}
                              </label>
                            );
                          }}
                        </For>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>
      <div class="mb-3 rounded-xl border border-neutral-200 dark:border-neutral-800">
        <div class="flex items-center justify-between px-3 py-2 text-sm font-medium">
          <span>Across your account</span>
          <span class="text-xs font-normal text-neutral-400">outside any single workspace</span>
        </div>
        <div class="flex flex-col gap-2 border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <For each={ACCOUNT_ENTITIES}>
            {(entity) => (
              <div>
                <p class="text-xs font-semibold text-neutral-500 dark:text-neutral-300">
                  {entity.label}
                </p>
                <div class="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
                  <For each={entity.actions}>
                    {(action) => {
                      const checked = () =>
                        (props.selection.account[entity.id] ?? []).includes(action.id);
                      return (
                        <label class="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
                          <input
                            type="checkbox"
                            checked={checked()}
                            onChange={(event) =>
                              toggleAction(
                                'account',
                                '*',
                                entity.id,
                                action.id,
                                action.implies,
                                event.currentTarget.checked,
                              )
                            }
                          />
                          {action.label}
                        </label>
                      );
                    }}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
      <p class="text-xs text-neutral-400">
        Writes imply reads — enabling an action also enables the reading it needs. Nothing can be
        granted without seeing it first.
      </p>
    </div>
  );
}

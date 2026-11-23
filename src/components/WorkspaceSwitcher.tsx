// The workspace switcher: shows the current workspace, switches between the
// ones you're in, and links to member management for admins/owners.
import { revalidate, useNavigate } from '@solidjs/router';
import { For, Show, createMemo, createSignal, onSettled } from 'solid-js';

import { createWorkspace, getMyWorkspaces, switchWorkspaceOrdered } from '../lib/workspaces';

export function WorkspaceSwitcher() {
  const workspaces = createMemo(() => getMyWorkspaces());
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [switchError, setSwitchError] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [newName, setNewName] = createSignal('');
  const [createError, setCreateError] = createSignal<string | null>(null);
  let root: HTMLDivElement | undefined;

  onSettled(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (open() && root && !root.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open()) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  });

  const current = () => workspaces().find((w) => w.current) ?? workspaces()[0];
  const canManage = () => current()?.role === 'owner' || current()?.role === 'admin';
  const navigate = useNavigate();

  const pick = async (id: string) => {
    if (id === current()?.id) {
      setOpen(false);
      return;
    }
    setBusy(id);
    setSwitchError(null);
    try {
      await switchWorkspaceOrdered(id);
      // Refetch everything workspace-scoped: the list itself and boards.
      revalidate('workspaces');
      revalidate('boards');
      setOpen(false);
      // Deep pages of the OLD workspace (members, team pages) must not
      // linger under a new active choice — land on the dashboard instead.
      navigate('/');
    } catch (cause) {
      setSwitchError(
        cause instanceof Error ? cause.message : 'Could not switch workspace',
      );
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!newName().trim() || busy()) return;
    setBusy('create');
    setCreateError(null);
    try {
      await createWorkspace(newName());
      revalidate('workspaces');
      revalidate('boards');
      setCreating(false);
      setNewName('');
      setOpen(false);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : 'Could not create the workspace');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={root} class="relative">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open() ? 'true' : 'false'}
          title="Switch workspace"
          class="flex max-w-44 items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          onClick={() => setOpen(!open())}
        >
          <span class="truncate">{current()?.name ?? (workspaces().length > 0 ? 'Workspace' : 'Create workspace')}</span>
          <span class="text-[10px] text-neutral-400">▼</span>
        </button>

        <Show when={open()}>
          <div
            role="menu"
            class="absolute left-0 top-full z-50 mt-2 w-64 rounded-2xl border border-neutral-200 bg-white p-2 shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
          >
            <p class="px-2 pb-1 pt-0.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
              Workspaces
            </p>
            <Show when={switchError()}>
              <p class="px-2 pb-1 text-xs text-red-500">{switchError()}</p>
            </Show>
            <For each={workspaces()}>
              {(workspace) => (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy() !== null}
                  class="flex w-full items-center justify-between gap-2 rounded-xl px-2 py-2 text-left text-sm hover:bg-neutral-100 disabled:opacity-60 dark:hover:bg-neutral-800"
                  onClick={() => void pick(workspace.id)}
                >
                  <span class="min-w-0">
                    <span class="block truncate font-medium">{workspace.name}</span>
                    <span class="block text-xs capitalize text-neutral-400">
                      {workspace.role}
                      {workspace.current ? ' · current' : ''}
                    </span>
                  </span>
                  <Show when={workspace.current}>
                    <span class="text-xs text-indigo-500">●</span>
                  </Show>
                </button>
              )}
            </For>
            <Show
              when={current() && canManage()}
              fallback={
                <Show when={current()}>
                  <a
                    role="menuitem"
                    href={`/w/${current()?.id}/members`}
                    class="mt-1 block rounded-xl px-2 py-2 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    onClick={() => setOpen(false)}
                  >
                    View members
                  </a>
                </Show>
              }
            >
              <div class="my-1 h-px bg-neutral-200 dark:bg-neutral-800" />
              <a
                role="menuitem"
                href={`/w/${current()?.id}/members`}
                class="block rounded-xl px-2 py-2 text-sm font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950"
                onClick={() => setOpen(false)}
              >
                Members &amp; invites
              </a>
            </Show>
            <div class="my-1 h-px bg-neutral-200 dark:bg-neutral-800" />
            <Show
              when={!creating()}
              fallback={
                <form
                  class="px-1 py-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                  }}
                >
                  <input
                    class="w-full text-sm"
                    placeholder="Workspace name…"
                    value={newName()}
                    onInput={(event) => setNewName(event.currentTarget.value)}
                    autofocus
                  />
                  <Show when={createError()}>
                    <p class="mt-1 text-xs text-red-500">{createError()}</p>
                  </Show>
                  <div class="mt-1.5 flex gap-2">
                    <button
                      type="submit"
                      disabled={!newName().trim() || busy() !== null}
                      class="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {busy() === 'create' ? 'Creating…' : 'Create'}
                    </button>
                    <button
                      type="button"
                      class="text-xs font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                      onClick={() => {
                        setCreating(false);
                        setCreateError(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              }
            >
              <button
                type="button"
                role="menuitem"
                class="block w-full rounded-xl px-2 py-2 text-left text-sm font-medium text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                onClick={() => setCreating(true)}
              >
                + New workspace
              </button>
            </Show>
          </div>
        </Show>
      </div>
  );
}

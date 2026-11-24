// PermissionPicker DOM tests — the live bugs from the first real users of
// the consent flow, pinned so they can't return:
//   * expanding an entity while its org is unselected used to crash
//     ("Cannot read properties of undefined (reading 'cards'…)") — the
//     org's key is gone from the selection when off, so the entity list
//     must not read through it, and there is nothing to expand into;
//   * the org row used to carry a "you are <role>" label — the picker
//     just shows what the user can do, the role is never mentioned.
import { describe, expect, it } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from '@solidjs/testing-library';
import { flush } from 'solid-js';

import { PermissionPicker } from './PermissionPicker';
import {
  toggleWorkspaceInSelection,
  type PermissionSelection,
} from '../lib/mcp-permissions';

// ── fixtures ──────────────────────────────────────────────────────────────

const ws = {
  id: 'ws1',
  name: 'Acme',
  role: 'admin' as const,
  board_creation: 'admins',
  is_team_admin: false,
};

const empty: PermissionSelection = { workspaces: {}, account: {} };

/** Render the picker around a signal so re-renders flow like in the app. */
const harness = (initial: PermissionSelection) => {
  const [selection, setSelection] = createSignal(initial);
  const changes: PermissionSelection[] = [];
  const utils = render(() => (
    <PermissionPicker
      selection={selection()}
      workspaces={[ws]}
      onChange={(next) => {
        changes.push(next);
        setSelection(next);
      }}
    />
  ));
  return { utils, changes, selection };
};

// ── the crash regression ───────────────────────────────────────────────────

describe('PermissionPicker with an unselected org', () => {
  it('shows a hint instead of the entity list — nothing to expand into', () => {
    // The first org starts expanded; its key is absent (tri-state off).
    const { utils } = harness(empty);
    flush();

    // Before the fix this rendered the entity rows and expanding one read
    // selection.workspaces.ws1.cards of undefined → TypeError. Now the
    // org expands into a hint, and no entity row exists to open.
    expect(utils.getByText('Acme')).toBeInTheDocument();
    expect(
      utils.getByText(/no access granted — turn this workspace on/i),
    ).toBeInTheDocument();
    expect(utils.queryByText('Boards')).not.toBeInTheDocument();
    expect(utils.queryByLabelText('toggle all Boards')).not.toBeInTheDocument();
  });

  it('does not crash when an org is turned off while an entity is expanded', () => {
    // Build the fully-on state through the picker's own cycle (off →
    // reads → everything) so the next org click is everything → off.
    // The cap mirrors what the picker derives for an admin of Acme.
    const cap = { role: 'admin' as const, canCreateBoards: true };
    const everything = toggleWorkspaceInSelection(
      toggleWorkspaceInSelection(empty, ws.id, cap),
      ws.id,
      cap,
    );
    const { utils, changes } = harness(everything);
    flush();

    // Open the Boards entity while the org is on.
    utils.getByText('Boards').closest('button')!.click();
    flush();
    expect(utils.getByText('Read boards')).toBeInTheDocument();

    // Turn the org off: everything → off deletes the workspace key. The
    // entity list (including the open Boards row) must disappear without
    // ever reading the deleted key — the crash the live build had.
    utils.getByLabelText('toggle everything in Acme').click();
    flush();
    expect(changes).toHaveLength(1);
    expect(changes[0].workspaces.ws1).toBeUndefined();
    expect(
      utils.getByText(/no access granted — turn this workspace on/i),
    ).toBeInTheDocument();
    expect(utils.queryByText('Read boards')).not.toBeInTheDocument();
  });
});

// ── the role label removal ─────────────────────────────────────────────────

describe('PermissionPicker org rows', () => {
  it('never mentions the user’s role', () => {
    const { utils } = harness({
      workspaces: { ws1: { boards: ['read'] } },
      account: {},
    });
    flush();
    expect(utils.getByText('Acme')).toBeInTheDocument();
    expect(utils.container.textContent).not.toMatch(/you are|owner|admin|member/);
  });

  it('still toggles actions with their requirements pulled in', () => {
    const { utils, changes } = harness({
      workspaces: { ws1: { boards: ['read'] } },
      account: {},
    });
    flush();

    // Open Boards and switch "Create boards" on: its requirement
    // (boards.read) must come along even though it was already there.
    utils.getByText('Boards').closest('button')!.click();
    flush();
    const box = utils
      .getByText('Create boards')
      .closest('label')!
      .querySelector('input') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    flush();

    expect(changes).toHaveLength(1);
    expect(changes[0].workspaces.ws1.boards).toContain('create');
    expect(changes[0].workspaces.ws1.boards).toContain('read');
  });
});

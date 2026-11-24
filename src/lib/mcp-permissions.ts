// The MCP permission taxonomy: ORG → ENTITY → ACTION, shared by the
// consent page, the connections page, and the server-side minting code.
// It maps human-named actions onto the flat op list the token carries
// (the edge function only ever sees ops).
//
// Rules baked in:
// - Every entity's read action is granted by default; writes are opt-in.
// - Writes imply reads: enabling "create/update/delete" auto-grants the
//   entity's read action (normalized client- and server-side) — there is
//   no "update without read" combination.
// - Actions use names people understand ("Move cards", "Mark as read"),
//   not protocol verbs.

/** One selectable action inside an entity. */
export type PermissionAction = {
  id: string;
  label: string;
  /** Flat ops this action grants. */
  ops: string[];
  /** The action id that comes along when this one is enabled (read
   *  accompanies every write). */
  implies?: string;
  /** Shown for the read action that every entity has. */
  description?: string;
};

/** One entity inside a workspace (or the account bucket). */
export type PermissionEntity = {
  id: string;
  label: string;
  description: string;
  actions: PermissionAction[];
};

const read = (id: string, label: string, ops: string[], description = ''): PermissionAction => ({
  id,
  label,
  ops,
  description,
});

const write = (
  id: string,
  label: string,
  ops: string[],
  implies: string,
  description = '',
): PermissionAction => ({ id, label, ops, implies, description });

/** Entities granted PER WORKSPACE. */
export const WORKSPACE_ENTITIES: PermissionEntity[] = [
  {
    id: 'boards',
    label: 'Boards & lists',
    description: 'The boards of this workspace and their lists.',
    actions: [
      read('read', 'Read boards', ['list_boards', 'get_board', 'get_board_full'], 'See boards and their lists'),
      write('create', 'Create boards & lists', ['create_board', 'create_list'], 'read'),
      write('update', 'Edit & rename boards & lists', ['rename_board', 'update_board', 'rename_list', 'update_list'], 'read'),
      write('delete', 'Delete boards & lists', ['delete_board', 'delete_list'], 'read'),
    ],
  },
  {
    id: 'cards',
    label: 'Cards',
    description: 'Cards on this workspace\u2019s boards.',
    actions: [
      read('read', 'Read cards', ['get_cards', 'get_card_events'], 'See cards and their activity'),
      write('create', 'Create cards', ['create_card'], 'read'),
      write('update', 'Update & move cards', ['update_card', 'move_card'], 'read'),
      write('delete', 'Delete cards', ['delete_card'], 'read'),
    ],
  },
  {
    id: 'chat',
    label: 'Chat & comments',
    description: 'Board chat messages and card comments.',
    actions: [
      read('read', 'Read chat', ['list_comments', 'list_board_messages'], 'See messages and comments'),
      write('post', 'Post messages & comments', ['post_board_message', 'add_comment'], 'read'),
      write('edit', 'Edit own messages', ['edit_board_message', 'edit_comment'], 'read'),
      write('delete', 'Delete own messages', ['delete_board_message', 'delete_comment'], 'read'),
    ],
  },
  {
    id: 'tags',
    label: 'Tags',
    description: 'The workspace\u2019s shared tag set.',
    actions: [
      read('read', 'Read tags', ['list_tags'], 'See the tag list'),
      write('create', 'Create tags', ['create_tag'], 'read'),
      write('rename', 'Rename tags', ['rename_tag'], 'read'),
      write('delete', 'Delete & merge tags', ['delete_tag', 'merge_tags'], 'read'),
    ],
  },
  {
    id: 'teams',
    label: 'Teams',
    description: 'Teams and their members.',
    actions: [
      read('read', 'Read teams', ['list_teams'], 'See teams and members'),
      write('manage', 'Create & manage teams', ['create_team', 'update_team', 'add_team_member', 'remove_team_member'], 'read'),
    ],
  },
  {
    id: 'directory',
    label: 'Member directory',
    description: 'Workspace members and invitees (includes email addresses).',
    actions: [
      read('read', 'Read members', ['list_workspace_members', 'get_user', 'list_pending_invites'], 'See who is in the workspace'),
    ],
  },
  {
    id: 'access',
    label: 'Board access',
    description: 'Granting and requesting board access for mentions.',
    actions: [
      read('check', 'Check mention reach', ['check_mention_access'], 'See who a mention reaches'),
      write('manage', 'Grant & resolve access', ['grant_board_access', 'request_board_access', 'resolve_access_request'], 'check'),
    ],
  },
];

/** Actions granted at ACCOUNT level (no single workspace). */
export const ACCOUNT_ENTITIES: PermissionEntity[] = [
  {
    id: 'profile',
    label: 'Your profile & status',
    description: 'Display name and presence status.',
    actions: [
      read('read', 'Read your profile', ['get_me'], 'See your own profile'),
      write('update', 'Update name & status', ['update_me', 'set_status'], 'read'),
    ],
  },
  {
    id: 'notifications',
    label: 'Your notifications',
    description: 'The notification inbox.',
    actions: [
      read('read', 'Read notifications', ['list_notifications'], 'See your notifications'),
      write('update', 'Mark as read', ['mark_notification_read', 'mark_notification_unread', 'mark_all_notifications_read'], 'read'),
    ],
  },
  {
    id: 'workspaces',
    label: 'Workspaces',
    description: 'Creating workspaces and inviting people.',
    actions: [
      read('read', 'List workspaces', ['list_workspaces'], 'See your workspaces'),
      write('create', 'Create workspaces & invite', ['create_workspace', 'invite_member'], 'read'),
    ],
  },
  {
    id: 'search',
    label: 'Search',
    description: 'Search across your boards.',
    actions: [read('read', 'Search', ['search'], 'Find cards, comments, messages')],
  },
];

/** Every op the taxonomy can grant (for validation + "*" grants). */
export const ALL_OPS: string[] = [
  ...new Set([
    ...WORKSPACE_ENTITIES.flatMap((entity) => entity.actions.flatMap((action) => action.ops)),
    ...ACCOUNT_ENTITIES.flatMap((entity) => entity.actions.flatMap((action) => action.ops)),
    'list_workspaces', // always granted alongside any workspace (see below)
  ]),
].sort();

/**
 * The always-on ops every connection gets regardless of selection: the
 * identity pair (get_me is required for the agent to know who it acts
 * as) and the workspace listing needed to operate the picker. Grants of
 * nothing still mean these.
 */
export const BASELINE_OPS: string[] = ['get_me', 'list_workspaces'];

/** One workspace's selection: entity id → set of action ids. */
export type WorkspaceSelection = Record<string, string[]>;

/** The whole permission choice: per-workspace selections + account actions. */
export type PermissionSelection = {
  /** ws id → entity actions ('*' for the account bucket). */
  workspaces: Record<string, WorkspaceSelection>;
  /** Account-level actions: entity id → action ids. */
  account: WorkspaceSelection;
};

/** An empty selection (nothing opted in). */
export const emptySelection = (): PermissionSelection => ({ workspaces: {}, account: {} });

/** Normalize one entity's action list: write implies read, dedup,
 *  and only known action ids survive. */
function normalizeEntity(entity: PermissionEntity, actionIds: string[]): string[] {
  const known = new Set(actionIds.filter((id) => entity.actions.some((a) => a.id === id)));
  for (const action of entity.actions) {
    if (known.has(action.id) && action.implies) known.add(action.implies);
  }
  return [...known];
}

/** Normalize a full selection: unknown ids dropped, writes imply reads. */
export function normalizeSelection(selection: PermissionSelection): PermissionSelection {
  const workspaces: Record<string, WorkspaceSelection> = {};
  for (const [wsId, entities] of Object.entries(selection.workspaces ?? {})) {
    const out: WorkspaceSelection = {};
    for (const entity of WORKSPACE_ENTITIES) {
      const ids = normalizeEntity(entity, entities[entity.id] ?? []);
      if (ids.length > 0) out[entity.id] = ids;
    }
    workspaces[wsId] = out;
  }
  const account: WorkspaceSelection = {};
  for (const entity of ACCOUNT_ENTITIES) {
    const ids = normalizeEntity(entity, selection.account?.[entity.id] ?? []);
    if (ids.length > 0) account[entity.id] = ids;
  }
  return { workspaces, account };
}

/** The default per-workspace selection: every entity's read actions. */
export const defaultWorkspaceSelection = (): WorkspaceSelection =>
  Object.fromEntries(
    WORKSPACE_ENTITIES.filter((entity) => entity.actions.some((a) => a.id === 'read' || a.id === 'check'))
      .map((entity) => [
        entity.id,
        entity.actions.filter((a) => a.id === 'read' || a.id === 'check').map((a) => a.id),
      ]),
  );

/** Selection → flat op list for ONE workspace (baseline included). */
export function workspaceOps(entitySelection: WorkspaceSelection): string[] {
  const ops = new Set<string>(BASELINE_OPS);
  for (const entity of WORKSPACE_ENTITIES) {
    const ids = entitySelection[entity.id] ?? [];
    for (const action of entity.actions) {
      if (ids.includes(action.id)) action.ops.forEach((op) => ops.add(op));
    }
  }
  return [...ops];
}

/** Selection → the account bucket's op list ("*" key in workspace_ops). */
export function accountOps(account: WorkspaceSelection): string[] {
  const ops = new Set<string>(BASELINE_OPS);
  for (const entity of ACCOUNT_ENTITIES) {
    const ids = account[entity.id] ?? [];
    for (const action of entity.actions) {
      if (ids.includes(action.id)) action.ops.forEach((op) => ops.add(op));
    }
  }
  return [...ops];
}

/**
 * Selection → the workspace_ops jsonb stored on the token:
 * { "<ws_id>": [ops], "*": [account ops] } — null when nothing is granted.
 */
export function selectionToWorkspaceOps(selection: PermissionSelection): Record<string, string[]> | null {
  const normalized = normalizeSelection(selection);
  const map: Record<string, string[]> = {};
  for (const [wsId, entities] of Object.entries(normalized.workspaces)) {
    const ops = workspaceOps(entities);
    if (ops.length > 0) map[wsId] = ops;
  }
  const acc = accountOps(normalized.account);
  if (acc.length > 0) map['*'] = acc;
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * workspace_ops jsonb → the flat op list the edge's tools/list shows
 * (the union across workspaces + account ops).
 */
export function workspaceOpsUnion(workspaceOps: Record<string, string[]> | null): string[] {
  if (!workspaceOps) return ALL_OPS;
  return [...new Set(Object.values(workspaceOps).flat())].sort();
}

/**
 * Flat ops → the picker's selection shape (the reverse of
 * workspaceOps): an action is "on" when every op it grants is held.
 */
export function opsToWorkspaceSelection(ops: string[]): WorkspaceSelection {
  const out: WorkspaceSelection = {};
  for (const entity of WORKSPACE_ENTITIES) {
    const ids = entity.actions
      .filter((action) => action.ops.every((op) => ops.includes(op)))
      .map((action) => action.id);
    if (ids.length > 0) out[entity.id] = ids;
  }
  return out;
}

/** Flat ops → the account bucket's selection. */
export function opsToAccountSelection(ops: string[]): WorkspaceSelection {
  const out: WorkspaceSelection = {};
  for (const entity of ACCOUNT_ENTITIES) {
    const ids = entity.actions
      .filter((action) => action.ops.every((op) => ops.includes(op)))
      .map((action) => action.id);
    if (ids.length > 0) out[entity.id] = ids;
  }
  return out;
}

/**
 * workspace_ops jsonb → the picker's selection (for editing an existing
 * connection). Legacy tokens (null) convert as account-wide: the caller
 * applies the same flat op list to every workspace the user is in.
 */
export function workspaceOpsToSelection(
  workspaceOps: Record<string, string[]> | null | undefined,
  legacyOps: string[] | null = null,
  legacyWorkspaceIds: string[] = [],
): PermissionSelection {
  if (workspaceOps) {
    const workspaces: Record<string, WorkspaceSelection> = {};
    for (const [key, ops] of Object.entries(workspaceOps)) {
      if (key === '*') continue;
      workspaces[key] = opsToWorkspaceSelection(ops);
    }
    return { workspaces, account: opsToAccountSelection(workspaceOps['*'] ?? []) };
  }
  return {
    workspaces: Object.fromEntries(
      legacyWorkspaceIds.map((id) => [id, opsToWorkspaceSelection(legacyOps ?? [])]),
    ),
    account: opsToAccountSelection(legacyOps ?? []),
  };
}

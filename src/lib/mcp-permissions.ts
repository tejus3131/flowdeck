// The MCP permission taxonomy: ORG → ENTITY → ACTION, shared by the
// consent page, the connections page, and the server-side minting code.
// It maps human-named actions onto the flat op list the token carries
// (the edge function only ever sees ops).
//
// Rules baked in:
// - Role-aware: an action carries the workspace role needed to use it in
//   the web app ('member' < 'admin' < 'owner'). The picker shows a user
//   only what their role in that workspace allows; admins see member
//   actions plus admin ones; owners see everything. Additive, never a
//   separate "admin permissions" section.
// - Workspace-gated actions (board creation) show only when that
//   workspace's own settings allow it for this user.
// - Writes imply reads, and dependencies resolve reactively in BOTH
//   directions: enabling "Update cards" switches "Read cards" on;
//   disabling "Read cards" switches every dependent write off. A
//   write-without-read grant is impossible to express.
// - Actions use names people understand ("Move cards", "Mark as read").

/** One selectable action inside an entity. */
export type PermissionAction = {
  id: string;
  label: string;
  /** Flat ops this action grants. */
  ops: string[];
  /** Same-entity action that comes along when this one is enabled. */
  implies?: string;
  /** Cross-entity requirement: '<entity>.<action>' — enabled together,
   *  and disabling the requirement disables this action. */
  requires?: string;
  /** The workspace role the web app needs for this action. Default member. */
  role?: 'member' | 'admin' | 'owner';
  /** The workspace-level gate: only offered when the workspace allows
   *  this user to do it (board creation policy). */
  gate?: 'board_create';
  /** One-line explanation under the label. */
  hint?: string;
};

/** One entity inside a workspace (or the account bucket). */
export type PermissionEntity = {
  id: string;
  label: string;
  description: string;
  actions: PermissionAction[];
};

/** A plain read action (id 'read'). */
const R = (label: string, ops: string[], hint = ''): PermissionAction => ({
  id: 'read',
  label,
  ops,
  hint,
});

/** Read action with a custom id ('check', 'read'...). */
const read = (id: string, label: string, ops: string[], hint = ''): PermissionAction => ({
  id,
  label,
  ops,
  hint,
});

const write = (
  id: string,
  label: string,
  ops: string[],
  extra: Partial<Pick<PermissionAction, 'implies' | 'requires' | 'role' | 'gate' | 'hint'>> = {},
): PermissionAction => ({ id, label, ops, ...extra });

/** Entities granted PER WORKSPACE, in display order. */
export const WORKSPACE_ENTITIES: PermissionEntity[] = [
  {
    id: 'boards',
    label: 'Boards',
    description: 'The boards of this workspace.',
    actions: [
      R('Read boards', ['list_boards', 'get_board', 'get_board_full'], 'See boards and their lists'),
      write('create', 'Create boards', ['create_board'], {
        gate: 'board_create',
        requires: 'boards.read',
        hint: 'Only offered when this workspace allows you to create boards',
      }),
      write('edit', 'Edit & rename boards', ['rename_board', 'update_board'], {
        requires: 'boards.read',
        role: 'member',
      }),
      write('delete', 'Delete boards', ['delete_board'], {
        requires: 'boards.read',
        role: 'admin',
      }),
    ],
  },
  {
    id: 'cards',
    label: 'Cards',
    description: 'Cards on this workspace\u2019s boards.',
    actions: [
      { id: 'read', label: 'Read cards', ops: ['get_cards', 'get_card_events'], hint: 'See cards and their activity', requires: 'boards.read' },
      write('create', 'Create cards', ['create_card'], {
        implies: 'read',
        requires: 'boards.read',
      }),
      write('update', 'Update & move cards', ['update_card', 'move_card'], {
        implies: 'read',
        requires: 'boards.read',
      }),
      write('delete', 'Delete cards', ['delete_card'], { implies: 'read', requires: 'boards.read' }),
    ],
  },
  {
    id: 'lists',
    label: 'Lists',
    description: 'The lists on this workspace\u2019s boards.',
    actions: [
      write('create', 'Create lists', ['create_list'], { requires: 'boards.read' }),
      write('edit', 'Rename & edit lists', ['rename_list', 'update_list'], { requires: 'boards.read' }),
      write('delete', 'Delete lists', ['delete_list'], { requires: 'boards.read', role: 'admin' }),
    ],
  },
  {
    id: 'chat',
    label: 'Chat & comments',
    description: 'Board chat messages and card comments.',
    actions: [
      { id: 'read', label: 'Read chat', ops: ['list_comments', 'list_board_messages'], hint: 'See messages and comments', requires: 'boards.read' },
      write('post', 'Post messages & comments', ['post_board_message', 'add_comment'], {
        implies: 'read',
        requires: 'boards.read',
      }),
      write('edit', 'Edit own messages', ['edit_board_message', 'edit_comment'], {
        implies: 'read',
        requires: 'boards.read',
      }),
      write('delete', 'Delete own messages', ['delete_board_message', 'delete_comment'], {
        implies: 'read',
        requires: 'boards.read',
      }),
    ],
  },
  {
    id: 'search',
    label: 'Search',
    description: 'Search across this workspace\u2019s boards.',
    actions: [{ id: 'read', label: 'Search this workspace', ops: ['search'], hint: 'Find cards, comments, messages', requires: 'boards.read' }],
  },
  {
    id: 'tags',
    label: 'Tags',
    description: 'The workspace\u2019s shared tag set.',
    actions: [
      read('read', 'Read tags', ['list_tags'], 'See the tag list'),
      write('create', 'Create tags', ['create_tag'], { implies: 'read', role: 'admin' }),
      write('rename', 'Rename tags', ['rename_tag'], { implies: 'read', role: 'admin' }),
      write('delete', 'Delete & merge tags', ['delete_tag', 'merge_tags'], { implies: 'read', role: 'admin' }),
    ],
  },
  {
    id: 'teams',
    label: 'Teams',
    description: 'Teams and their members.',
    actions: [
      read('read', 'Read teams', ['list_teams'], 'See teams and their members'),
      write('manage', 'Create & manage teams', [
        'create_team',
        'update_team',
        'add_team_member',
        'remove_team_member',
      ], { implies: 'read', role: 'admin' }),
    ],
  },
  {
    id: 'people',
    label: 'People & invites',
    description: 'The workspace roster and invites.',
    actions: [
      read('read', 'Read members', ['list_workspace_members', 'get_user'], 'See who is in the workspace'),
      write('invite', 'Invite & manage people', ['invite_member', 'list_pending_invites'], {
        implies: 'read',
        role: 'admin',
      }),
    ],
  },
  {
    id: 'access',
    label: 'Board access & mentions',
    description: 'Granting board access so mentions reach people.',
    actions: [
      { id: 'check', label: 'Check mention reach', ops: ['check_mention_access'], hint: 'See who a mention reaches', requires: 'boards.read' },
      write('request', 'Ask admins for access', ['request_board_access'], {
        implies: 'check',
        requires: 'boards.read',
      }),
      write('grant', 'Grant board access', ['grant_board_access'], {
        implies: 'check',
        requires: 'boards.read',
        role: 'admin',
      }),
      write('resolve', 'Resolve access requests', ['resolve_access_request'], {
        implies: 'check',
        requires: 'boards.read',
        role: 'admin',
      }),
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
      write('update', 'Update name & status', ['update_me', 'set_status'], { implies: 'read' }),
    ],
  },
  {
    id: 'notifications',
    label: 'Your notifications',
    description: 'The notification inbox.',
    actions: [
      read('read', 'Read notifications', ['list_notifications'], 'See your notifications'),
      write('mark', 'Mark as read', [
        'mark_notification_read',
        'mark_notification_unread',
        'mark_all_notifications_read',
      ], { implies: 'read' }),
    ],
  },
  {
    id: 'workspaces',
    label: 'Workspaces',
    description: 'Creating workspaces.',
    actions: [
      read('read', 'List workspaces', ['list_workspaces'], 'See your workspaces'),
      write('create', 'Create workspaces', ['create_workspace'], { implies: 'read' }),
    ],
  },
];

/** Every op the taxonomy can grant (for validation + "*" grants). */
export const ALL_OPS: string[] = [
  ...new Set([
    ...WORKSPACE_ENTITIES.flatMap((entity) => entity.actions.flatMap((action) => action.ops)),
    ...ACCOUNT_ENTITIES.flatMap((entity) => entity.actions.flatMap((action) => action.ops)),
  ]),
].sort();

/**
 * The always-on ops every connection gets regardless of selection: the
 * identity pair the agent needs to operate at all.
 */
export const BASELINE_OPS: string[] = ['get_me', 'list_workspaces'];

/** One workspace's selection: entity id → set of action ids. */
export type WorkspaceSelection = Record<string, string[]>;

/** The whole permission choice: per-workspace selections + account actions. */
export type PermissionSelection = {
  /** ws id → entity actions. */
  workspaces: Record<string, WorkspaceSelection>;
  /** Account-level actions: entity id → action ids. */
  account: WorkspaceSelection;
};

/** An empty selection (nothing opted in). */
export const emptySelection = (): PermissionSelection => ({ workspaces: {}, account: {} });

/** What a user may be offered in one workspace: their role plus the
 *  workspace-level gate (board creation policy resolved for them). */
export type WorkspaceCap = {
  role: 'member' | 'admin' | 'owner';
  /** True when this workspace allows THIS user to create boards. */
  canCreateBoards: boolean;
};

/** The cap for one workspace choice row (the shape both the consent and
 *  connection pages load): role + board-creation policy + team-admin
 *  seat, resolved for THIS user. One derivation, shared by the picker,
 *  the connection page's live clamp, and the server's cap code paths. */
export function capFromChoice(ws: {
  role: 'member' | 'admin' | 'owner';
  board_creation: string;
  is_team_admin: boolean;
}): WorkspaceCap {
  return {
    role: ws.role,
    canCreateBoards:
      ws.role === 'owner' ||
      ws.role === 'admin' ||
      ws.board_creation === 'everyone' ||
      (ws.board_creation === 'team_admins' && ws.is_team_admin),
  };
}

/** Role rank for comparing caps. */
const ROLE_RANK: Record<WorkspaceCap['role'], number> = { member: 0, admin: 1, owner: 2 };

/** True when the user's cap covers an action's role and gate. */
export function actionOffered(action: PermissionAction, cap: WorkspaceCap | null): boolean {
  // account-level entities have no cap — everything is offered
  if (cap === null) return true;
  if (action.role && ROLE_RANK[cap.role] < ROLE_RANK[action.role]) return false;
  if (action.gate === 'board_create' && !cap.canCreateBoards) return false;
  return true;
}

/** The actions of an entity a user can be offered, in display order. */
export function offeredActions(entity: PermissionEntity, cap: WorkspaceCap | null): PermissionAction[] {
  return entity.actions.filter((action) => actionOffered(action, cap));
}

// ── dependency resolution ─────────────────────────────────────────────────
// implies (same entity) and requires (cross entity, '<entity>.<action>')
// resolve in both directions: enabling a dependent pulls its requirement
// on; disabling a requirement pushes every dependent off.

/** Find an entity/action by '<entity>.<action>' key across both buckets. */
function findAction(key: string): { entity: PermissionEntity; action: PermissionAction } | null {
  const [entityId, actionId] = key.split('.');
  for (const entity of [...WORKSPACE_ENTITIES, ...ACCOUNT_ENTITIES]) {
    if (entity.id === entityId) {
      const action = entity.actions.find((a) => a.id === actionId);
      if (action) return { entity, action };
    }
  }
  return null;
}

/** Everything that depends on the given action (transitively): any action
 *  whose implies/requires chain includes it. */
function dependentsOf(key: string): Set<string> {
  const all = [
    ...WORKSPACE_ENTITIES.flatMap((e) => e.actions.map((a) => ({ e, a }))),
    ...ACCOUNT_ENTITIES.flatMap((e) => e.actions.map((a) => ({ e, a }))),
  ];
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const { e, a } of all) {
      const self = `${e.id}.${a.id}`;
      if (out.has(self)) continue;
      const deps = [a.implies && `${e.id}.${a.implies}`, a.requires].filter(Boolean) as string[];
      if (deps.some((dep) => dep === key || out.has(dep))) {
        out.add(self);
        grew = true;
      }
    }
  }
  return out;
}

/** Toggle one action in a bucket with full dependency resolution.
 *  Pure: returns the next selection. */
export function toggleActionInSelection(
  selection: PermissionSelection,
  bucket: 'workspaces' | 'account',
  bucketId: string | null,
  entityId: string,
  actionId: string,
  on: boolean,
): PermissionSelection {
  const entities = bucket === 'workspaces' ? WORKSPACE_ENTITIES : ACCOUNT_ENTITIES;
  const entity = entities.find((e) => e.id === entityId);
  const action = entity?.actions.find((a) => a.id === actionId);
  if (!entity || !action) return selection;

  const setAction = (
    sel: WorkspaceSelection,
    entityId: string,
    actionId: string,
    on: boolean,
  ) => {
    const ids = new Set(sel[entityId] ?? []);
    if (on) ids.add(actionId);
    else ids.delete(actionId);
    if (ids.size > 0) sel[entityId] = [...ids];
    else delete sel[entityId];
  };

  const next: PermissionSelection = { ...selection };
  const sel: WorkspaceSelection =
    bucket === 'workspaces'
      ? { ...next.workspaces[bucketId ?? ''] }
      : { ...next.account };
  const sameBucketSel = sel;

  if (on) {
    // pull the requirement chain in (same bucket only — the deps live in
    // the same bucket by construction)
    setAction(sameBucketSel, entityId, actionId, true);
    let cur: PermissionAction | undefined = action;
    while (cur) {
      const impliedId = cur.implies;
      const reqKey = cur.requires;
      if (impliedId && entity.actions.some((a) => a.id === impliedId)) {
        setAction(sameBucketSel, entityId, impliedId, true);
      }
      if (reqKey) {
        const found = findAction(reqKey);
        if (found) {
          const [reqEntityId, reqActionId] = reqKey.split('.');
          const reqInThisBucket =
            (bucket === 'workspaces' && WORKSPACE_ENTITIES.some((e) => e.id === reqEntityId)) ||
            (bucket === 'account' && ACCOUNT_ENTITIES.some((e) => e.id === reqEntityId));
          if (reqInThisBucket) setAction(sameBucketSel, reqEntityId, reqActionId, true);
          cur = found.action;
          continue;
        }
      }
      break;
    }
  } else {
    setAction(sameBucketSel, entityId, actionId, false);
    // cascade: everything that transitively depends on this goes off
    for (const dep of dependentsOf(`${entityId}.${actionId}`)) {
      const [depEntity, depAction] = dep.split('.');
      const depInThisBucket = entities.some((e) => e.id === depEntity);
      if (depInThisBucket) setAction(sameBucketSel, depEntity, depAction, false);
    }
  }

  if (bucket === 'workspaces') {
    const ws = bucketId ?? '';
    next.workspaces = { ...next.workspaces, [ws]: sameBucketSel };
  } else {
    next.account = sameBucketSel;
  }
  return next;
}

/** Toggle a whole entity (tri-state): off → its default set (reads);
 *  anything else → everything offered; everything → nothing. */
export function toggleEntityInSelection(
  selection: PermissionSelection,
  bucket: 'workspaces' | 'account',
  bucketId: string | null,
  entityId: string,
  cap: WorkspaceCap | null,
): PermissionSelection {
  const entities = bucket === 'workspaces' ? WORKSPACE_ENTITIES : ACCOUNT_ENTITIES;
  const entity = entities.find((e) => e.id === entityId);
  if (!entity) return selection;
  const current = bucket === 'workspaces'
    ? selection.workspaces[bucketId ?? '']?.[entityId] ?? []
    : selection.account[entityId] ?? [];
  const offered = offeredActions(entity, cap).map((a) => a.id);
  const reads = offered.filter((id) => id === 'read' || id === 'check');
  const target =
    current.length === 0
      ? // empty: reads first when the entity has them (lists has none → all)
        reads.length > 0
          ? reads
          : offered
      : offered.every((id) => current.includes(id))
        ? []
        : offered;
  // Set the target directly — a remove-then-add rebuild would fire
  // cascades that wipe OTHER entities' selections mid-flight.
  const sel: WorkspaceSelection =
    bucket === 'workspaces'
      ? { ...selection.workspaces[bucketId ?? ''] }
      : { ...selection.account };
  if (target.length === 0) delete sel[entityId];
  else sel[entityId] = target;
  // Actions this toggle REMOVED cascade their dependents off — the same
  // rule the action-level toggle applies. Turning the Boards entity off
  // with Cards fully granted empties Cards too (their reads require
  // boards.read), instead of silently re-adding boards.read.
  const removed = current.filter((id) => !target.includes(id));
  for (const id of removed) {
    for (const dep of dependentsOf(`${entityId}.${id}`)) {
      const [depEntity, depAction] = dep.split('.');
      if (!entities.some((e) => e.id === depEntity)) continue;
      const ids = sel[depEntity];
      if (!ids) continue;
      const nextIds = ids.filter((x) => x !== depAction);
      if (nextIds.length === 0) delete sel[depEntity];
      else sel[depEntity] = nextIds;
    }
  }
  // Everything still selected gets its requirements pulled in.
  enforceRequirements(sel, entities);
  if (bucket === 'workspaces') {
    return {
      ...selection,
      workspaces: { ...selection.workspaces, [bucketId ?? '']: sel },
    };
  }
  return { ...selection, account: sel };
}

/** Toggle a whole workspace (tri-state): off → default read-only set;
 *  partial → everything offered; everything → nothing. */
export function toggleWorkspaceInSelection(
  selection: PermissionSelection,
  wsId: string,
  cap: WorkspaceCap,
): PermissionSelection {
  const current = selection.workspaces[wsId];
  const allOn = WORKSPACE_ENTITIES.every((entity) => {
    const offered = offeredActions(entity, cap);
    if (offered.length === 0) return true;
    const sel = current?.[entity.id] ?? [];
    return offered.every((a) => sel.includes(a.id));
  });
  let next = { ...selection, workspaces: { ...selection.workspaces } };
  if (!selection.workspaces[wsId] || Object.keys(current ?? {}).length === 0) {
    // off → default read-only set
    const sel: WorkspaceSelection = {};
    next.workspaces[wsId] = sel;
    for (const entity of WORKSPACE_ENTITIES) {
      const reads = entity.actions.filter((a) => (a.id === 'read' || a.id === 'check') && actionOffered(a, cap));
      for (const r of reads) {
        next = toggleActionInSelection(next, 'workspaces', wsId, entity.id, r.id, true);
      }
    }
  } else if (allOn) {
    delete next.workspaces[wsId];
    next.workspaces = { ...next.workspaces };
  } else {
    // partial → everything offered
    for (const entity of WORKSPACE_ENTITIES) {
      const offered = offeredActions(entity, cap).map((a) => a.id);
      const sel = current?.[entity.id] ?? [];
      if (!offered.every((id) => sel.includes(id))) {
        next = toggleEntityInSelection(next, 'workspaces', wsId, entity.id, cap);
      }
    }
  }
  return next;
}


/** Enforce cross-entity requirements across a whole bucket: any selected
 *  action pulls its `requires` chain in (same bucket). Iterates to a
 *  fixed point; unknown requirements are ignored (they'd be dropped by
 *  the entity loop anyway). */
function enforceRequirements(
  bucketSel: WorkspaceSelection,
  entities: PermissionEntity[],
): void {
  let grew = true;
  while (grew) {
    grew = false;
    for (const entity of entities) {
      for (const action of offeredActions(entity, null)) {
        if (!(bucketSel[entity.id] ?? []).includes(action.id)) continue;
        const reqKey = action.requires;
        if (!reqKey) continue;
        const [reqEntityId, reqActionId] = reqKey.split('.');
        if (!entities.some((e) => e.id === reqEntityId)) continue;
        const sel = bucketSel[reqEntityId] ?? [];
        if (!sel.includes(reqActionId)) {
          bucketSel[reqEntityId] = [...sel, reqActionId];
          grew = true;
        }
      }
    }
  }
}

/** Normalize one entity's action list: unknown ids dropped, writes imply
 *  reads (missing implies pulled in). */
function normalizeEntity(entity: PermissionEntity, actionIds: string[], cap: WorkspaceCap | null): string[] {
  const offered = offeredActions(entity, cap);
  const known = new Set(actionIds.filter((id) => offered.some((a) => a.id === id)));
  let grew = true;
  while (grew) {
    grew = false;
    for (const action of offered) {
      if (!known.has(action.id)) continue;
      if (action.implies && !known.has(action.implies)) {
        const implied = offered.find((a) => a.id === action.implies);
        if (implied) {
          known.add(action.implies);
          grew = true;
        }
      }
    }
  }
  return [...known];
}

/** Normalize a full selection: unknown ids dropped, writes imply reads. */
export function normalizeSelection(selection: PermissionSelection): PermissionSelection {
  const workspaces: Record<string, WorkspaceSelection> = {};
  for (const [wsId, entities] of Object.entries(selection.workspaces ?? {})) {
    const out: WorkspaceSelection = {};
    for (const entity of WORKSPACE_ENTITIES) {
      const ids = normalizeEntity(entity, entities[entity.id] ?? [], null);
      if (ids.length > 0) out[entity.id] = ids;
    }
    enforceRequirements(out, WORKSPACE_ENTITIES);
    workspaces[wsId] = out;
  }
  const account: WorkspaceSelection = {};
  for (const entity of ACCOUNT_ENTITIES) {
    const ids = normalizeEntity(entity, selection.account?.[entity.id] ?? [], null);
    if (ids.length > 0) account[entity.id] = ids;
  }
  enforceRequirements(account, ACCOUNT_ENTITIES);
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
 * workspace_ops jsonb → the union the edge's tools/list shows.
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

/**
 * Cap a selection to what the user can actually grant: strips actions
 * above their role or behind a workspace gate they don't pass. Applied
 * server-side after normalizeSelection so a crafted request can't grant
 * more than the user has.
 */
export function capSelection(
  selection: PermissionSelection,
  caps: Record<string, WorkspaceCap>,
): PermissionSelection {
  const workspaces: Record<string, WorkspaceSelection> = {};
  for (const [wsId, entities] of Object.entries(selection.workspaces ?? {})) {
    const cap = caps[wsId];
    if (!cap) continue; // not a member — cannot grant anything here
    const out: WorkspaceSelection = {};
    for (const entity of WORKSPACE_ENTITIES) {
      const ids = normalizeEntity(entity, entities[entity.id] ?? [], cap);
      if (ids.length > 0) out[entity.id] = ids;
    }
    enforceRequirements(out, WORKSPACE_ENTITIES);
    workspaces[wsId] = out;
  }
  const account: WorkspaceSelection = {};
  for (const entity of ACCOUNT_ENTITIES) {
    const ids = normalizeEntity(entity, selection.account?.[entity.id] ?? [], null);
    if (ids.length > 0) account[entity.id] = ids;
  }
  enforceRequirements(account, ACCOUNT_ENTITIES);
  return { workspaces, account };
}

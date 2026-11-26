// The workspace op registry: the same relay-and-reconcile pattern the
// board page uses (see board-ops.ts), applied to workspace life — invites
// sent/revoked, members joining/leaving/removed, role changes, per-board
// access overrides, and the dashboard's board create/delete.
//
// Two engines listen on the same workspace relay channel, each applying
// the kinds it knows (unknown kinds are ignored — a board page listener
// doesn't care about invites, and older/newer clients stay compatible):
//   * the MEMBERS page engine over WorkspaceDetail
//   * the DASHBOARD engine over BoardsSnapshot (board create/delete)
// plus the BOARD page, which listens for access-changed so a viewer↔editor
// flip lands instantly on an open board.
//
// Trust model: relays are display hints, never truth. A payload's author
// is not authenticated by the channel, so nothing here can grant anything —
// writes go through server functions under RLS, the echo retires ops the
// database confirms, and anything unconfirmed silently reverts.
import type { BoardsSnapshot, BoardSummary } from './boards';
import type { InviteRole, Member, WorkspaceDetail, WorkspaceRole } from './workspaces';

export type InviteCreatedOp = {
  kind: 'invite-created';
  id: string;
  email: string;
  role: InviteRole;
  token: string;
  createdAt: string;
};
export type InviteRevokedOp = { kind: 'invite-revoked'; inviteId: string };
export type MemberJoinedOp = {
  kind: 'member-joined';
  userId: string;
  role: WorkspaceRole;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
};
export type MemberRoleOp = { kind: 'member-role'; userId: string; role: WorkspaceRole };
export type MemberRemovedOp = { kind: 'member-removed'; userId: string };
export type AccessChangedOp = {
  kind: 'access-changed';
  boardId: string;
  userId: string;
  access: 'edit' | 'view' | null;
};
export type BoardCreatedOp = { kind: 'board-created'; board: BoardSummary };
export type BoardDeletedOp = { kind: 'board-deleted'; boardId: string };
export type TeamCreatedOp = {
  kind: 'team-created';
  teamId: string;
  name: string;
  description: string;
};
export type TeamDeletedOp = { kind: 'team-deleted'; teamId: string };
export type TeamMemberOp = {
  kind: 'team-member';
  teamId: string;
  userId: string;
  /** null = removed. */
  role: 'admin' | 'member' | null;
};
export type TeamAccessOp = {
  kind: 'team-access';
  boardId: string;
  teamId: string;
  access: 'edit' | 'view' | null;
};

/** A workspace-level policy the owner changed: who can create boards,
 *  and/or the invite domain allowlist. The members/settings surface
 *  applies it instantly; the dashboard revalidates its workspaces query
 *  so the create-board button follows the policy live. */
export type WsPolicyChangedOp = {
  kind: 'ws-policy-changed';
  boardCreation?: 'admins' | 'team_admins' | 'everyone';
  inviteDomains?: string[];
};

export type WorkspaceOpPayload =
  | InviteCreatedOp
  | InviteRevokedOp
  | MemberJoinedOp
  | MemberRoleOp
  | MemberRemovedOp
  | AccessChangedOp
  | BoardCreatedOp
  | BoardDeletedOp
  | TeamCreatedOp
  | TeamDeletedOp
  | TeamMemberOp
  | TeamAccessOp
  | WsPolicyChangedOp;

/** What travels over the workspace relay (ephemeral — never trusted). */
export type WorkspaceOp = { opId: string; payload: WorkspaceOpPayload };

/** The vocabulary — receivers ignore anything else (older/newer peers). */
export const WS_OPS_KNOWN: ReadonlySet<string> = new Set<WorkspaceOpPayload['kind']>([
  'invite-created',
  'invite-revoked',
  'member-joined',
  'member-role',
  'member-removed',
  'access-changed',
  'board-created',
  'board-deleted',
  'team-created',
  'team-deleted',
  'team-member',
  'team-access',
  'ws-policy-changed',
]);
/** Entity guard for "my own membership row / role" (the receiver's view of
 *  itself flips when the op targets them). */
export const ME_ENTITY = 'me';
export const accessKey = (boardId: string, userId: string) => `${boardId}:${userId}`;

// ── members page engine (WorkspaceDetail) ─────────────────────────────────

export function guardsForDetailOp(payload: WorkspaceOpPayload, meId: string | null): string[] {
  const selfHit =
    (payload.kind === 'member-role' || payload.kind === 'member-removed') &&
    payload.userId === meId;
  const base = (() => {
    switch (payload.kind) {
      case 'invite-created':
        return [payload.id];
      case 'invite-revoked':
        return [payload.inviteId];
      case 'member-joined':
        return [payload.userId];
      case 'member-role':
      case 'member-removed':
        return [payload.userId];
      case 'access-changed':
        return [accessKey(payload.boardId, payload.userId)];
      case 'team-created':
        return [`team:${payload.teamId}`];
      case 'team-deleted':
        return [`team:${payload.teamId}`];
      case 'team-member':
        return [`team:${payload.teamId}:${payload.userId}`];
      case 'team-access':
        return [`team-access:${payload.boardId}:${payload.teamId}`];
      case 'ws-policy-changed':
        return ['ws-policy'];
      default:
        return []; // board ops don't apply to this snapshot
    }
  })();
  return selfHit ? [...base, ME_ENTITY] : base;
}

export function tempIdsForDetailOp(payload: WorkspaceOpPayload): string[] {
  return payload.kind === 'invite-created' || payload.kind === 'member-joined'
    ? [payload.kind === 'invite-created' ? payload.id : payload.userId]
    : [];
}

export function applyDetailOp(
  draft: WorkspaceDetail,
  payload: WorkspaceOpPayload,
  meId: string | null,
  now: string,
): void {
  switch (payload.kind) {
    case 'invite-created': {
      if (!draft.invites.some((i) => i.id === payload.id)) {
        draft.invites = [
          ...draft.invites,
          {
            id: payload.id,
            email: payload.email,
            role: payload.role,
            token: payload.token,
            created_at: payload.createdAt,
          },
        ];
      }
      return;
    }
    case 'invite-revoked':
      draft.invites = draft.invites.filter((i) => i.id !== payload.inviteId);
      return;
    case 'member-joined': {
      if (!draft.members.some((m) => m.user_id === payload.userId)) {
        const member: Member = {
          user_id: payload.userId,
          role: payload.role,
          display_name: payload.displayName,
          username: null,
          email: payload.email,
          avatar_url: payload.avatarUrl,
          created_at: now,
        };
        draft.members = [...draft.members, member];
      }
      return;
    }
    case 'member-role': {
      draft.members = draft.members.map((m) =>
        m.user_id === payload.userId ? { ...m, role: payload.role } : m,
      );
      if (payload.userId === meId) draft.myRole = payload.role;
      return;
    }
    case 'member-removed': {
      draft.members = draft.members.filter((m) => m.user_id !== payload.userId);
      const next: Record<string, 'edit' | 'view'> = {};
      for (const [key, value] of Object.entries(draft.access)) {
        if (!key.endsWith(`:${payload.userId}`)) next[key] = value;
      }
      draft.access = next;
      return;
    }
    case 'access-changed': {
      const key = accessKey(payload.boardId, payload.userId);
      const next = { ...draft.access };
      if (payload.access === null) delete next[key];
      else next[key] = payload.access;
      draft.access = next;
      return;
    }
    case 'team-created': {
      if (!draft.teams.some((team) => team.id === payload.teamId)) {
        draft.teams = [
          ...draft.teams,
          { id: payload.teamId, name: payload.name, description: payload.description, members: [] },
        ].sort((a, b) => a.name.localeCompare(b.name));
      }
      return;
    }
    case 'team-deleted': {
      draft.teams = draft.teams.filter((team) => team.id !== payload.teamId);
      for (const key of Object.keys(draft.teamAccess)) {
        draft.teamAccess[key] = draft.teamAccess[key].filter((g) => g.teamId !== payload.teamId);
      }
      return;
    }
    case 'team-member': {
      const team = draft.teams.find((entry) => entry.id === payload.teamId);
      if (!team) return;
      const members = team.members.filter((member) => member.user_id !== payload.userId);
      if (payload.role !== null) {
        members.push({ user_id: payload.userId, role: payload.role });
      }
      team.members = members;
      return;
    }
    case 'team-access': {
      const next = { ...draft.teamAccess };
      const list = (next[payload.boardId] ?? []).filter((g) => g.teamId !== payload.teamId);
      if (payload.access !== null) list.push({ teamId: payload.teamId, access: payload.access });
      next[payload.boardId] = list;
      draft.teamAccess = next;
      return;
    }
    case 'ws-policy-changed': {
      if (payload.boardCreation !== undefined) {
        draft.workspace = { ...draft.workspace, board_creation: payload.boardCreation };
      }
      if (payload.inviteDomains !== undefined) {
        draft.workspace = { ...draft.workspace, invite_domains: payload.inviteDomains };
      }
      return;
    }
    default:
      return; // board ops live on the dashboard engine, not this snapshot
  }
}

export function echoDetailOp(
  durable: WorkspaceDetail,
  payload: WorkspaceOpPayload,
  meId: string | null,
): boolean {
  switch (payload.kind) {
    case 'invite-created':
      return durable.invites.some((i) => i.id === payload.id);
    case 'invite-revoked':
      return !durable.invites.some((i) => i.id === payload.inviteId);
    case 'member-joined':
      return durable.members.some((m) => m.user_id === payload.userId);
    case 'member-role': {
      const member = durable.members.find((m) => m.user_id === payload.userId);
      if (!member || member.role !== payload.role) return false;
      if (payload.userId === meId) return durable.myRole === payload.role;
      return true;
    }
    case 'member-removed': {
      if (durable.members.some((m) => m.user_id === payload.userId)) return false;
      if (payload.userId === meId) return durable.myRole === null;
      return true;
    }
    case 'access-changed':
      return (
        (durable.access[accessKey(payload.boardId, payload.userId)] ?? null) === payload.access
      );
    case 'team-created':
      return durable.teams.some((team) => team.id === payload.teamId);
    case 'team-deleted':
      return !durable.teams.some((team) => team.id === payload.teamId);
    case 'team-member': {
      const team = durable.teams.find((entry) => entry.id === payload.teamId);
      if (!team) return payload.role === null;
      const member = team.members.find((entry) => entry.user_id === payload.userId);
      return payload.role === null ? !member : member?.role === payload.role;
    }
    case 'team-access': {
      const grant = (durable.teamAccess[payload.boardId] ?? []).find(
        (entry) => entry.teamId === payload.teamId,
      );
      return (grant?.access ?? null) === payload.access;
    }
    case 'ws-policy-changed':
      return (
        (payload.boardCreation === undefined ||
          durable.workspace.board_creation === payload.boardCreation) &&
        (payload.inviteDomains === undefined ||
          JSON.stringify(durable.workspace.invite_domains) ===
            JSON.stringify(payload.inviteDomains))
      );
    default:
      return false;
  }
}

// ── workspace detail merge (members page + board settings drawer) ─────────

/** Merge two keyed row lists: server rows first, guarded locals appended,
 *  identity-stable, snapshot-isolated (rows entering the view are copies
 *  — see sync.ts for why in-place edits poison durable snapshots). */
export function keyedMerge<T extends Record<string, unknown>>(
  local: T[],
  server: T[],
  keep: ReadonlySet<string>,
  keyOf: (row: T) => string,
): T[] {
  const kept = local.filter((row) => keep.has(keyOf(row)));
  const keptIds = new Set(kept.map(keyOf));
  const prev = new Map(local.map((row) => [keyOf(row), row]));
  return [
    ...server
      .filter((row) => !keptIds.has(keyOf(row)))
      .map((row) => {
        const old = prev.get(keyOf(row));
        return old && JSON.stringify(old) === JSON.stringify(row) ? old : { ...row };
      }),
    ...kept,
  ];
}

/** Fold a durable workspace snapshot into the view: keyed rows keep their
 *  identity when unchanged (no churn), guarded entities hold their
 *  provisional state until the echo retires them, and the collections keep
 *  their sort order (members/invites by joined-at, boards by name). */
export function mergeWorkspaceDetail(
  draft: WorkspaceDetail,
  snapshot: WorkspaceDetail,
  keep: ReadonlySet<string>,
): void {
  const members = keyedMerge(draft.members, snapshot.members, keep, (m) => m.user_id).sort(
    (a, b) => +new Date(a.created_at) - +new Date(b.created_at),
  );
  const invites = keyedMerge(draft.invites, snapshot.invites, keep, (i) => i.id).sort(
    (a, b) => +new Date(a.created_at) - +new Date(b.created_at),
  );
  const boards = keyedMerge(draft.boards, snapshot.boards, keep, (b) => b.id).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const access: Record<string, 'edit' | 'view'> = {};
  for (const [key, value] of Object.entries(snapshot.access)) {
    access[key] = value;
  }
  for (const key of keep) {
    if (!key.includes(':')) continue;
    if (draft.access[key] !== undefined) access[key] = draft.access[key];
    else delete access[key];
  }
  // Tags: the workspace's shared vocabulary (keyed by id; rarely changes).
  const wsTags = keyedMerge(draft.tags, snapshot.tags, keep, (t) => t.id).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (draft.workspace.id === snapshot.workspace.id) {
    if (draft.workspace.name !== snapshot.workspace.name) {
      draft.workspace = { ...draft.workspace, name: snapshot.workspace.name };
    }
    if (
      JSON.stringify(draft.workspace.invite_domains) !==
      JSON.stringify(snapshot.workspace.invite_domains)
    ) {
      draft.workspace = { ...draft.workspace, invite_domains: snapshot.workspace.invite_domains };
    }
    if (draft.workspace.board_creation !== snapshot.workspace.board_creation) {
      draft.workspace = { ...draft.workspace, board_creation: snapshot.workspace.board_creation };
    }
  } else {
    draft.workspace = snapshot.workspace;
  }
  draft.myRole = keep.has(ME_ENTITY) ? draft.myRole : snapshot.myRole;
  draft.members = members;
  draft.invites = invites;
  draft.boards = boards;
  draft.access = access;
  draft.tags = wsTags;
  // Teams: keyed by id; the durable snapshot wins (no relay ops for teams
  // yet — realtime is fast enough for the management surface).
  const teams = keyedMerge(draft.teams, snapshot.teams, keep, (t) => t.id).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const teamAccess: Record<string, { teamId: string; access: 'edit' | 'view' }[]> = {};
  for (const [key, value] of Object.entries(snapshot.teamAccess)) {
    teamAccess[key] = value.slice();
  }
  draft.teams = teams;
  draft.deactivatedTeams = snapshot.deactivatedTeams.slice();
  draft.teamAccess = teamAccess;
}

// ── dashboard engine (BoardsSnapshot) ─────────────────────────────────────

export function guardsForBoardsOp(payload: WorkspaceOpPayload): string[] {
  switch (payload.kind) {
    case 'board-created':
      return [payload.board.id];
    case 'board-deleted':
      return [payload.boardId];
    default:
      return [];
  }
}

export function tempIdsForBoardsOp(payload: WorkspaceOpPayload): string[] {
  return payload.kind === 'board-created' ? [payload.board.id] : [];
}

export function applyBoardsOp(draft: BoardsSnapshot, payload: WorkspaceOpPayload): void {
  switch (payload.kind) {
    case 'board-created':
      if (!draft.boards.some((b) => b.id === payload.board.id)) {
        // Newest first — the merge's updated_at order.
        draft.boards = [payload.board, ...draft.boards];
      }
      return;
    case 'board-deleted':
      draft.boards = draft.boards.filter((b) => b.id !== payload.boardId);
      return;
    default:
      return;
  }
}

export function echoBoardsOp(durable: BoardsSnapshot, payload: WorkspaceOpPayload): boolean {
  switch (payload.kind) {
    case 'board-created':
      return durable.boards.some((b) => b.client_op === payload.board.client_op);
    case 'board-deleted':
      return !durable.boards.some((b) => b.id === payload.boardId);
    default:
      return false;
  }
}

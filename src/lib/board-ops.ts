// The board op registry: the canonical vocabulary every mutation is
// expressed in. The AUTHOR runs an op through the outbox (instant local
// apply, server write, echo retirement) AND relays it over the realtime
// channel so peers see it immediately. RECEIVERS apply the same op as a
// PROVISIONAL prediction: same apply, same guard, same echo retirement —
// the only difference is that the send lives on someone else's machine.
//
// This is the Figma-multiplayer pattern (relay-before-apply + provisional
// state superseded by the authoritative echo), which the sync engine
// already implements for local ops: guards keep intermediate durable
// snapshots from clobbering a change still in flight, the echo retires
// the op when the durable state contains its effect, and a dropped/failed
// op reverts to the durable state. The database stays the single source of
// truth; the broadcast only ever hides latency.
import { BOARD_ENTITY } from './sync';
import type { BoardSnapshot, CardView, ListRow } from './boards';

export type CreateCardOp = {
  kind: 'create-card';
  tempId: string;
  listId: string;
  title: string;
  position: number;
  /** Identity stamp persisted on the durable row — exact echo matching. */
  clientOp: string;
};
export type MoveCardOp = { kind: 'move-card'; cardId: string; listId: string; position: number };
export type UpdateCardOp = {
  kind: 'update-card';
  cardId: string;
  title?: string;
  description?: string;
  priority?: string | null;
  /** Linked tags as {id, name} — the id is the truth, the name displays. */
  tags?: { id: string; name: string }[];
  assignees?: string[];
};
export type DeleteCardOp = { kind: 'delete-card'; cardId: string };
/** A comment landing on a card — the board engine bumps the card's stats;
 *  the open drawer's own engine appends the row itself. countBefore is the
 *  author's count at send time (a lower bound for the echo). */
export type CommentCreatedOp = {
  kind: 'comment-created';
  tempId: string;
  cardId: string;
  body: string;
  author: string;
  /** The author's id + avatar — the chat-style rows render instantly at
   *  receivers, exactly like the author's optimistic row. */
  authorId: string | null;
  avatarUrl: string | null;
  createdAt: string;
  clientOp: string;
  countBefore: number;
};
export type CreateListOp = {
  kind: 'create-list';
  tempId: string;
  name: string;
  position: number;
  clientOp: string;
};
export type UpdateListOp = {
  kind: 'update-list';
  listId: string;
  name?: string;
  description?: string;
};
export type DeleteListOp = { kind: 'delete-list'; listId: string };
export type UpdateBoardOp = {
  kind: 'update-board';
  name?: string;
  description?: string;
  /** Owners/admins only — may editors grant board access themselves? */
  accessDelegation?: boolean;
};

export type BoardOpPayload =
  | CreateCardOp
  | MoveCardOp
  | UpdateCardOp
  | DeleteCardOp
  | CommentCreatedOp
  | CreateListOp
  | UpdateListOp
  | DeleteListOp
  | UpdateBoardOp;

/** What travels over the realtime broadcast (ephemeral — never trusted). */
export type BoardOp = { opId: string; payload: BoardOpPayload };
/** The author's relay when its server write failed: drop the prediction. */
export type BoardOpFail = { opId: string };

/** The op vocabulary — receivers ignore anything else (older/newer peers). */
export const OPS_KNOWN: ReadonlySet<string> = new Set<BoardOpPayload['kind']>([
  'create-card',
  'move-card',
  'update-card',
  'delete-card',
  'comment-created',
  'create-list',
  'update-list',
  'delete-list',
  'update-board',
]);

/** Entities the op must guard against intermediate durable snapshots. */
export function guardsFor(payload: BoardOpPayload): string[] {
  switch (payload.kind) {
    case 'create-card':
      return [payload.tempId];
    case 'create-list':
      return [payload.tempId];
    case 'move-card':
    case 'update-card':
    case 'delete-card':
    case 'comment-created':
      return [payload.cardId];
    case 'update-list':
    case 'delete-list':
      return [payload.listId];
    case 'update-board':
      return [BOARD_ENTITY];
  }
}

/** Locally-created entities awaiting their real id from the echo. */
export function tempIdsFor(payload: BoardOpPayload): string[] {
  if (payload.kind === 'create-card' || payload.kind === 'create-list') return [payload.tempId];
  // The comment's temp row belongs to the drawer's engine; on the board
  // engine the same id guards the card so the count bump holds until
  // the echo — marking it a temp keeps the card shimmer-free (isSaving
  // is local-only) while retiring exactly the same way.
  if (payload.kind === 'comment-created') return [];
  return [];
}

/**
 * The view invariant the durable merge maintains: lists by position, cards
 * by (list order, position). Local and provisional applies must keep it
 * too — a move that only mutates `position` leaves the card at its old
 * ARRAY slot (top of the new list) until the next durable merge sorts, a
 * visible "jump after a beat" on every author and receiver.
 */
export function sortBoardDraft(draft: BoardSnapshot): void {
  draft.lists = [...draft.lists].sort((a, b) => a.position - b.position);
  const listOrder = new Map(draft.lists.map((list, index) => [list.id, index]));
  draft.cards = [...draft.cards].sort(
    (a, b) =>
      (listOrder.get(a.list_id) ?? 0) - (listOrder.get(b.list_id) ?? 0) ||
      a.position - b.position,
  );
}

/** Apply the op's intent to a view draft (author's local apply and the
 *  receivers' provisional prediction run the SAME code), then restore the
 *  sort invariant so the move lands exactly where it will be durable. */
export function applyBoardOp(draft: BoardSnapshot, payload: BoardOpPayload, now: string): void {
  switch (payload.kind) {
    case 'create-card': {
      const row: CardView = {
        id: payload.tempId,
        board_id: draft.board.id,
        list_id: payload.listId,
        title: payload.title,
        description: '',
        position: payload.position,
        created_by: null,
        created_at: now,
        updated_at: now,
        client_op: payload.clientOp,
        number: null,
        resolved_at: null,
        resolved_by: null,
        comment_count: 0,
        last_comment_at: null,
        priority: null,
        tags: [],
        assignees: [],
      };
      draft.cards.push(row);
      break;
    }
    case 'comment-created': {
      const card = draft.cards.find((c) => c.id === payload.cardId);
      if (!card) break;
      card.comment_count = (card.comment_count ?? 0) + 1;
      card.last_comment_at = payload.createdAt;
      break;
    }
    case 'move-card': {
      const card = draft.cards.find((c) => c.id === payload.cardId);
      if (!card) break;
      card.list_id = payload.listId;
      card.position = payload.position;
      card.updated_at = now;
      break;
    }
    case 'update-card': {
      const card = draft.cards.find((c) => c.id === payload.cardId);
      if (!card) break;
      if (payload.title !== undefined) card.title = payload.title;
      if (payload.description !== undefined) card.description = payload.description;
      if (payload.priority !== undefined) card.priority = payload.priority;
      if (payload.tags !== undefined) card.tags = payload.tags;
      if (payload.assignees !== undefined) card.assignees = payload.assignees;
      card.tags = [...(card.tags ?? [])].sort((a, b) => a.name.localeCompare(b.name));
      card.updated_at = now;
      break;
    }
    case 'delete-card':
      draft.cards = draft.cards.filter((c) => c.id !== payload.cardId);
      break;
    case 'create-list': {
      const row: ListRow = {
        id: payload.tempId,
        board_id: draft.board.id,
        name: payload.name,
        position: payload.position,
        created_at: now,
        client_op: payload.clientOp,
        description: '',
      };
      draft.lists.push(row);
      break;
    }
    case 'update-list': {
      const list = draft.lists.find((l) => l.id === payload.listId);
      if (!list) break;
      if (payload.name !== undefined) list.name = payload.name;
      if (payload.description !== undefined) list.description = payload.description;
      break;
    }
    case 'delete-list':
      draft.lists = draft.lists.filter((l) => l.id !== payload.listId);
      draft.cards = draft.cards.filter((c) => c.list_id !== payload.listId);
      break;
    case 'update-board':
      draft.board = {
        ...draft.board,
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.accessDelegation !== undefined
          ? { access_delegation: payload.accessDelegation }
          : {}),
      };
      break;
  }
  sortBoardDraft(draft);
}

/** True when the durable snapshot contains this op's effect — the echo
 *  that retires the op everywhere (author and receivers alike). */
export function echoBoardOp(durable: BoardSnapshot, payload: BoardOpPayload): boolean {
  switch (payload.kind) {
    case 'create-card':
      // Exact: the durable row the author stamped (duplicate titles can't
      // confuse retirement).
      return durable.cards.some((c) => c.client_op === payload.clientOp);
    case 'create-list':
      return durable.lists.some((l) => l.client_op === payload.clientOp);
    case 'move-card': {
      const card = durable.cards.find((c) => c.id === payload.cardId);
      return !!card && card.list_id === payload.listId && card.position === payload.position;
    }
    case 'update-card': {
      const card = durable.cards.find((c) => c.id === payload.cardId);
      if (!card) return false;
      if (payload.title !== undefined && card.title !== payload.title) return false;
      if (payload.description !== undefined && card.description !== payload.description)
        return false;
      if (payload.priority !== undefined && card.priority !== payload.priority) return false;
      if (payload.tags !== undefined && JSON.stringify(card.tags) !== JSON.stringify(payload.tags))
        return false;
      if (payload.assignees !== undefined) {
        const ids = (list: string[]) => [...list].sort().join(',');
        if (ids(card.assignees) !== ids(payload.assignees)) return false;
      }
      if (payload.tags !== undefined) {
        const tagIds = (list: { id: string }[]) => [...list].map((t) => t.id).sort().join(',');
        if (tagIds(card.tags) !== tagIds(payload.tags)) return false;
      }
      return true;
    }
    case 'delete-card':
      return !durable.cards.some((c) => c.id === payload.cardId);
    case 'comment-created': {
      const card = durable.cards.find((c) => c.id === payload.cardId);
      // The author's count is a lower bound: any durable count at or past
      // it means the comment landed (concurrent ones only raise it).
      return !!card && card.comment_count >= payload.countBefore + 1;
    }
    case 'update-list': {
      const list = durable.lists.find((l) => l.id === payload.listId);
      if (!list) return false;
      if (payload.name !== undefined && list.name !== payload.name) return false;
      if (payload.description !== undefined && list.description !== payload.description)
        return false;
      return true;
    }
    case 'delete-list':
      return !durable.lists.some((l) => l.id === payload.listId);
    case 'update-board': {
      if (payload.name !== undefined && durable.board.name !== payload.name) return false;
      if (payload.description !== undefined && durable.board.description !== payload.description)
        return false;
      if (
        payload.accessDelegation !== undefined &&
        durable.board.access_delegation !== payload.accessDelegation
      )
        return false;
      return true;
    }
  }
}

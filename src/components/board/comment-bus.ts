// Extracted from the board route (phase 6): the comment bus's event
// vocabulary, shared by the route's relay wiring and the card drawer.
import type { BoardOpPayload } from '../../lib/board-ops';

/** A comment op payload (the drawer's engine consumes these too). */
export type CommentOp = Extract<BoardOpPayload, { kind: 'comment-created' }>;

/** What the open drawer hears from the board relay: a comment op, or the
 *  failure of one (both engines' predictions drop under the same id). */
export type CommentBusEvent =
  { type: 'op'; payload: CommentOp; opId: string } | { type: 'fail'; opId: string };

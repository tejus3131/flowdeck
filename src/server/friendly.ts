// Server-only: user-facing errors. Production builds sanitize server-function
// errors down to "Internal Server Error" on the wire — UNLESS the error is
// marked safe. Every guard message a user is meant to read ("this team
// still has N members…") must travel as a friendly error, or the UI shows
// the generic 500 text and the human learns nothing.
import { markSafeError } from '@solidjs/web';

/** A user-facing error whose message survives production sanitization. */
export function friendlyError(message: string): Error {
  return markSafeError(new Error(message));
}

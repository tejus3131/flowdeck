/** Pull a human-readable message out of ANY thrown value.
 *
 * Server-function failures don't always reach the browser as `Error`
 * instances — the RPC layer can hand back a reconstructed plain object,
 * and every `cause instanceof Error ? cause.message : 'Something went
 * wrong'` fallback collapsed to the generic exactly when a real reason
 * was sitting on the value (Orbit card #13). This extracts whatever
 * survived the trip — an Error's message, a thrown string, or an
 * object's `message` — and only falls back when there is genuinely
 * nothing to show. */
export function errorMessage(cause: unknown, fallback = 'Something went wrong'): string {
  if (cause instanceof Error) return cause.message || fallback;
  if (typeof cause === 'string') return cause || fallback;
  if (cause && typeof cause === 'object') {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

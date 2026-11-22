// Client-side passkey helpers. The WebAuthn ceremony has to run in the
// browser (navigator.credentials), so these use the cookie-sharing browser
// client; the profiles.has_passkey flag is synced by a database trigger on
// auth.identities, and callers revalidate `me` to pick it up.
import { browserClient } from './supabase-client';

/**
 * Run the passkey registration ceremony for the signed-in user.
 * Resolves ok:false (never throws) so callers can render the error inline.
 */
export async function addPasskey(): Promise<{ ok: boolean; error?: string }> {
  const client = browserClient();
  if (!client) {
    return { ok: false, error: 'Passkeys are unavailable — check your configuration.' };
  }
  const { error } = await client.auth.registerPasskey();
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Has the person dismissed the "add a passkey" prompt recently?
 * "Maybe later" means exactly that — not "never ask again" — so the
 * dismissal persists in localStorage for 24 hours, surviving refreshes
 * and new tabs; after that the prompt comes back. */
const DISMISS_KEY = 'flowdeck:passkey-prompt-dismissed-at';
const DISMISS_MS = 24 * 60 * 60 * 1000;

export function passkeyPromptDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? '0');
    return Number.isFinite(at) && Date.now() - at < DISMISS_MS;
  } catch {
    return false;
  }
}

export function dismissPasskeyPrompt(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    // Storage is best-effort; the prompt just reappears sooner.
  }
}

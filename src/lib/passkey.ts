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

/** Has the person dismissed the "add a passkey" prompt this session? */
export function passkeyPromptDismissed(): boolean {
  try {
    return sessionStorage.getItem('flowdeck:passkey-prompt') === 'dismissed';
  } catch {
    return false;
  }
}

export function dismissPasskeyPrompt(): void {
  try {
    sessionStorage.setItem('flowdeck:passkey-prompt', 'dismissed');
  } catch {
    // Session storage is best-effort; the prompt just reappears.
  }
}

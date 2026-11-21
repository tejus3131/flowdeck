// The browser-side Supabase client, sharing the same cookies as the server
// (so the session is one). Used for what can only happen in the browser:
// WebAuthn passkey ceremonies, presence/broadcast channels, file uploads.
// Data still flows through server functions everywhere else.
import type { SupabaseClient } from '@supabase/supabase-js';
import { createBrowserClient } from '@supabase/ssr';
import { env } from 'virtual:solid-env/client';

let client: SupabaseClient | undefined;

/** The shared browser client, or null when the public env vars are absent
 *  (feature-disabled build). Never holds secrets: the URL and publishable
 *  key are public values; RLS is the security layer. */
export function browserClient(): SupabaseClient | null {
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_PUBLISHABLE_KEY) return null;
  if (!client) {
    client = createBrowserClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY);
  }
  return client;
}

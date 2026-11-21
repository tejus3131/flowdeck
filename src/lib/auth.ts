// The auth data layer: server functions the UI calls directly.
//
// Identity is Supabase Auth (magic link) carried in Supabase cookies via
// @supabase/ssr — RLS is the security layer, and getMe() reads through the
// same request-scoped client so every row obeys the caller's policies.
import { formAction, query } from '@solidjs/router';
import { getRequestEvent, redirect } from '@solidjs/web';

import { createSupabaseRequestClient } from '../server/supabase';
import type { Database } from '../types/database.generated';

export type Profile = Database['public']['Tables']['profiles']['Row'];
export type MeProfile = Pick<
  Profile,
  'id' | 'email' | 'display_name' | 'avatar_url' | 'has_passkey' | 'theme'
>;

/** Who is signed in, from their profile row (RLS: own + peers). */
export const getMe = query(async (): Promise<MeProfile | null> => {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return null;
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, display_name, avatar_url, has_passkey, theme')
    .eq('id', user.id)
    .maybeSingle();
  // The profiles trigger mirrors every new auth user; the fallback covers
  // a user that predates it.
  return (
    profile ?? {
      id: user.id,
      email: user.email ?? '',
      display_name: user.email?.split('@')[0] ?? '',
      avatar_url: null,
      has_passkey: false,
      theme: 'system',
    }
  );
}, 'me');

/**
 * Send a magic-link email. Works as a plain form post before hydration;
 * on success we land on /sign-in?sent=1 to show the "check your inbox"
 * state.
 */
export const signIn = formAction(async (formData: FormData) => {
  'use server';
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address');
  }
  const request = getRequestEvent()?.request;
  if (!request) throw new Error('signIn: no request event');
  const origin = new URL(request.url).origin;

  const supabase = createSupabaseRequestClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/confirm` },
  });
  if (error) throw new Error(error.message);

  throw redirect('/sign-in?sent=1');
});

/** Sign out: clears the Supabase session cookies and returns home. */
export const signOut = formAction(async () => {
  'use server';
  const supabase = createSupabaseRequestClient();
  await supabase.auth.signOut();
  throw redirect('/');
});

/**
 * The sign-in branch: does this email belong to an existing account, and
 * does that account have a passkey? New users get a magic link; returning
 * users with a passkey get the passkey ceremony by default.
 */
export async function checkEmail(email: string): Promise<{ exists: boolean; hasPasskey: boolean }> {
  'use server';
  const clean = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    throw new Error('Enter a valid email address');
  }
  const supabase = createSupabaseRequestClient();
  const { data, error } = await supabase.rpc('auth_check_email', { p_email: clean });
  if (error) throw new Error(error.message);
  const result = (data ?? {}) as { exists?: boolean; has_passkey?: boolean };
  return { exists: !!result.exists, hasPasskey: !!result.has_passkey };
}

/**
 * A no-op server call whose settle revalidates the route's queries — used
 * after client-side-only changes (passkey registration, theme switch) so
 * the signed-in profile refreshes without a reload.
 */
export async function touch(): Promise<boolean> {
  'use server';
  return true;
}

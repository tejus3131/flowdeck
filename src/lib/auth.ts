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
  'id' | 'email' | 'display_name' | 'avatar_url'
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
    .select('id, email, display_name, avatar_url')
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

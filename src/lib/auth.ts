// The auth data layer: server functions the UI calls directly.
//
// Identity is Supabase Auth (magic link) carried in Supabase cookies via
// @supabase/ssr — RLS is the security layer, and getMe() reads through the
// same request-scoped client so every row obeys the caller's policies.
import { formAction, query } from '@solidjs/router';
import { getRequestEvent, redirect } from '@solidjs/web';
import { parseCookie, stringifySetCookie } from 'cookie';

import { createSupabaseRequestClient, createSupabaseServiceClient } from '../server/supabase';
import { friendlyError } from '../server/friendly';
import type { Database } from '../types/database.generated';

export type Profile = Database['public']['Tables']['profiles']['Row'];
export type MeProfile = Pick<
  Profile,
  'id' | 'email' | 'display_name' | 'username' | 'avatar_url' | 'has_passkey' | 'theme' | 'created_at'
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
    .select('id, email, display_name, username, avatar_url, has_passkey, theme, created_at')
    .eq('id', user.id)
    .maybeSingle();
  // The profiles trigger mirrors every new auth user; the fallback covers
  // a user that predates it.
  return (
    profile ?? {
      id: user.id,
      email: user.email ?? '',
      display_name: user.email?.split('@')[0] ?? '',
      username: null,
      avatar_url: null,
      has_passkey: false,
      theme: 'system',
      created_at: user.created_at ?? new Date().toISOString(),
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

  // Where to land after the link is redeemed (invite flow); same-origin
  // paths only. It rides a short-lived cookie: the email's redirect_to
  // must stay EXACTLY `${origin}/auth/confirm` to match the auth
  // allowlist — a query string would break the match and GoTrue would
  // fall back to its site URL.
  const rawNext = String(formData.get('next') ?? '');
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : null;
  if (next) {
    getRequestEvent()?.response.headers.append(
      'set-cookie',
      stringifySetCookie({ name: 'fd_next', value: next, path: '/', sameSite: 'lax', maxAge: 3600 }),
    );
  }

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
 * Delete the account and everything it owns. The database cascades from
 * auth.users: profile, memberships, boards, personal workspaces and their
 * content all go. Shared workspaces the account OWNS would cascade away
 * for everyone — deletion is refused until those are transferred or
 * shrunk to solo. The response clears the auth cookies so this device
 * signs out even though GoTrue no longer knows the session.
 */
export async function deleteAccount(): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to sign in first');

  // Refuse when an owned workspace still has other members: its cascade
  // would delete THEIR boards and content with the account.
  const { data: owned } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces(id, name)')
    .eq('user_id', user.id)
    .eq('role', 'owner');
  const shared: string[] = [];
  for (const row of owned ?? []) {
    const ws = row.workspaces as { id: string; name: string } | null;
    if (!ws) continue;
    const { count } = await supabase
      .from('workspace_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('workspace_id', ws.id)
      .neq('user_id', user.id);
    if ((count ?? 0) > 0) shared.push(ws.name);
  }
  if (shared.length > 0) {
    throw friendlyError(
      `Transfer ownership of ${shared.map((n) => `“${n}”`).join(', ')} first — deleting your account would remove it for everyone`,
    );
  }

  // Content check (the other half of the safety rule): a SOLE owner
  // deleting their account cascades every owned workspace — boards and
  // cards included. Content must be handled deliberately first: purge
  // those boards (workspace settings → Danger zone) or delete the
  // workspaces outright.
  const ownedIds = (owned ?? [])
    .map((row) => (row.workspaces as { id: string } | null)?.id)
    .filter((id): id is string => Boolean(id));
  if (ownedIds.length > 0) {
    const { count: ownedCards } = await supabase
      .from('cards')
      .select('id, boards!inner(id)', { count: 'exact', head: true })
      .in('boards.workspace_id', ownedIds);
    if ((ownedCards ?? 0) > 0) {
      throw friendlyError(
        `Your workspaces still hold ${ownedCards} card${ownedCards === 1 ? '' : 's'} — purge those boards (workspace settings → Danger zone) or delete the workspaces first; deleting your account would destroy them`,
      );
    }
  }

  const service = createSupabaseServiceClient();
  const { error } = await service.auth.admin.deleteUser(user.id);
  if (error) throw new Error(error.message);

  // The session is gone server-side; clear this device's cookies too
  // (signOut would 404 against a deleted user).
  const event = getRequestEvent();
  if (event) {
    const jar = Object.keys(parseCookie(event.request.headers.get('cookie') ?? '')).filter(
      (name) => /^sb-.*-auth-token(\.\d+)?$/.test(name),
    );
    for (const name of jar) {
      event.response.headers.append(
        'set-cookie',
        stringifySetCookie({ name, value: '', path: '/', sameSite: 'lax', maxAge: 0 }),
      );
    }
    event.response.headers.append(
      'set-cookie',
      stringifySetCookie({ name: 'fd_ws', value: '', path: '/', sameSite: 'lax', maxAge: 0 }),
    );
  }
  return true;
}

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

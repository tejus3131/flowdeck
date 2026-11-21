// Profile mutations: display name, username, avatar. All server functions
// under request-scoped Supabase so RLS applies; validation here gives
// friendly errors before the database ever sees bad data.
import { createSupabaseRequestClient } from '../server/supabase';

const USERNAME_PATTERN = /^[a-z0-9._-]{3,20}$/;

/** Normalize + validate; null clears the (optional) username. */
function cleanUsername(raw: string): string | null {
  const username = raw.trim().toLowerCase();
  if (!username) return null;
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error('Username: 3-20 characters — lowercase letters, digits, . _ or -');
  }
  return username;
}

export type ProfileInput = { displayName: string; username: string };

/**
 * Save display name + username. Username uniqueness is a database
 * constraint; the 23505 translation keeps the message human.
 */
export async function updateProfile(input: ProfileInput): Promise<{ ok: boolean }> {
  'use server';
  const displayName = String(input.displayName ?? '')
    .trim()
    .slice(0, 80);
  const username = cleanUsername(String(input.username ?? ''));

  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to sign in first');

  const { error } = await supabase
    .from('profiles')
    .update({ display_name: displayName, username })
    .eq('id', user.id);
  if (error) {
    if (error.code === '23505') {
      throw new Error('That username is already taken — try another.');
    }
    throw new Error(error.message);
  }
  return { ok: true };
}

/**
 * Persist an avatar URL (the client uploaded the file itself and hands over
 * the public URL) or clear it with null.
 */
export async function setAvatarUrl(url: string | null): Promise<boolean> {
  'use server';
  const clean = url === null ? null : String(url).trim();
  if (clean !== null && !/^https?:\/\//.test(clean)) {
    throw new Error('setAvatarUrl: expected an https URL or null');
  }

  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to sign in first');

  const { error } = await supabase.from('profiles').update({ avatar_url: clean }).eq('id', user.id);
  if (error) throw new Error(error.message);
  return true;
}

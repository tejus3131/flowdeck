// Profile mutations: display name + avatar. All server functions under
// request-scoped Supabase so RLS applies; validation here gives friendly
// errors before the database ever sees bad data. (Usernames are gone —
// display names are the single identity surface.)
import { createSupabaseRequestClient } from '../server/supabase';

export type ProfileInput = { displayName: string };

/** Save the display name. */
export async function updateProfile(input: ProfileInput): Promise<{ ok: boolean }> {
  'use server';
  const displayName = String(input.displayName ?? '')
    .trim()
    .slice(0, 80);

  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to sign in first');

  const { error } = await supabase
    .from('profiles')
    .update({ display_name: displayName })
    .eq('id', user.id);
  if (error) throw new Error(error.message);
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

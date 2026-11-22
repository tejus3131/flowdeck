// Chat-notification preferences — the Slack-style per-scope control.
// A user picks, for a board's chat (and separately for any card's
// comments): all messages, direct + team mentions, direct mentions only,
// or nothing. Mentions stay loud; "all" also files quiet chat rows.
import { createSupabaseRequestClient } from '../server/supabase';

export type ChatLevel = 'all' | 'mentions_team' | 'direct' | 'none';

export const CHAT_LEVELS: { value: ChatLevel; label: string; hint: string }[] = [
  { value: 'all', label: 'All messages', hint: 'Every message, quietly' },
  { value: 'mentions_team', label: 'Direct & team mentions', hint: 'Default' },
  { value: 'direct', label: 'Direct mentions only', hint: 'Just @you' },
  { value: 'none', label: 'Nothing', hint: 'Not even mentions' },
];

/** The saved level for a scope — null means "use the default". */
export async function getChatPref(
  scopeType: 'board' | 'card',
  scopeId: string,
): Promise<ChatLevel | null> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;
  const { data } = await supabase
    .from('chat_prefs')
    .select('level')
    .eq('user_id', auth.user.id)
    .eq('scope_type', scopeType)
    .eq('scope_id', scopeId)
    .maybeSingle();
  return (data?.level as ChatLevel | undefined) ?? null;
}

/** Save (or clear with null) the level for a scope. */
export async function setChatPref(
  scopeType: 'board' | 'card',
  scopeId: string,
  level: ChatLevel | null,
): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Sign in first');
  if (level === null) {
    await supabase
      .from('chat_prefs')
      .delete()
      .eq('user_id', auth.user.id)
      .eq('scope_type', scopeType)
      .eq('scope_id', scopeId);
    return true;
  }
  const { error } = await supabase.from('chat_prefs').upsert(
    {
      user_id: auth.user.id,
      scope_type: scopeType,
      scope_id: scopeId,
      level,
    },
    { onConflict: 'user_id,scope_type,scope_id' },
  );
  if (error) throw new Error(error.message);
  return true;
}

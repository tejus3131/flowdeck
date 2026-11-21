// Personal access tokens: the MCP/CLI credential surface. The plaintext
// token is generated server-side and shown exactly once; only its sha256
// is stored (api_tokens.token_hash). RLS keeps tokens strictly their
// owner's — the MCP edge function (service role) is the only other reader.
import { createHash, randomBytes } from 'node:crypto';

import { query } from '@solidjs/router';

import { createSupabaseRequestClient } from '../server/supabase';

export type ApiTokenSummary = {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
};

export const getMyTokens = query(async (): Promise<ApiTokenSummary[]> => {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data } = await supabase
    .from('api_tokens')
    .select('id, name, created_at, last_used_at')
    .order('created_at', { ascending: false });
  return data ?? [];
}, 'my-tokens');

/** Mint a token: fd_<hex>. The ONLY time the plaintext is ever returned. */
export async function createApiToken(name: string): Promise<{ token: string }> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to sign in first');

  const clean = String(name ?? '').trim().slice(0, 60) || 'token';
  const token = `fd_${randomBytes(24).toString('hex')}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const { error } = await supabase
    .from('api_tokens')
    .insert({ user_id: user.id, name: clean, token_hash: tokenHash });
  if (error) throw new Error(error.message);
  return { token };
}

export async function revokeApiToken(tokenId: string): Promise<boolean> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { error } = await supabase.from('api_tokens').delete().eq('id', tokenId);
  if (error) throw new Error(error.message);
  return true;
}

// The MCP consent flow's server side: the /mcp/authorize page calls
// approveMcpClient when the user clicks Allow. This is the browser half
// of the OAuth-style flow (card #16) — the edge function owns discovery
// and the token exchange; this only mints the one-time authorization
// code, after the user has seen exactly who is asking.
//
// Validation mirrors the edge function's /token checks: client_id and
// redirect_uri must match at exchange time, and the PKCE S256 challenge
// is stored with the code — the app never sees the verifier.
import { createHash, randomBytes } from 'node:crypto';

import { createSupabaseRequestClient } from '../server/supabase';

export type McpAuthorizeInput = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  challengeMethod: string;
  state?: string | null;
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    // http is fine for local clients (127.0.0.1/localhost) only.
    if (url.protocol === 'http:') {
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    }
    return url.hostname.length > 0 && !url.hash;
  } catch {
    return false;
  }
}

/** Consent granted: mint a single-use authorization code and hand back
 * the redirect that carries it (with the caller's state, if any). */
export async function approveMcpClient(input: McpAuthorizeInput): Promise<{ redirectTo: string }> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to sign in first');

  const clientId = String(input.clientId ?? '').trim().slice(0, 100);
  const redirectUri = String(input.redirectUri ?? '').trim();
  const codeChallenge = String(input.codeChallenge ?? '').trim();
  const challengeMethod = String(input.challengeMethod ?? 'S256').trim();
  const state = input.state ? String(input.state).slice(0, 2000) : null;

  if (!clientId || !redirectUri || !codeChallenge) {
    throw new Error('This authorization request is incomplete — ask the client to retry.');
  }
  if (!isHttpUrl(redirectUri)) {
    throw new Error('The redirect address must be a valid https URL (http only for localhost).');
  }
  if (challengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    throw new Error('This authorization request must use PKCE (S256) — ask the client to retry.');
  }

  const code = `mcp_${randomBytes(24).toString('hex')}`;
  const codeHash = createHash('sha256').update(code).digest('hex');
  const { error } = await supabase.from('mcp_auth_codes').insert({
    code_hash: codeHash,
    user_id: user.id,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    challenge_method: 'S256',
  });
  if (error) throw new Error(error.message);

  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  return { redirectTo: target.toString() };
}

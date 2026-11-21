// The magic-link landing route. The email link goes to Supabase's verify
// endpoint, which redirects here. @supabase/ssr uses the PKCE flow by
// default, so the redirect carries an authorization `code` (redeemed with
// the code-verifier cookie the sign-in call stored); the token_hash form
// is kept for explicit-OTP links. Either way this handler establishes the
// session — whose cookies ride the redirect out. It's an API route (GET
// export), dispatched by the createAPIHandler middleware.
import type { APIHandler } from 'filesystem-routing/api';
import type { RequestEvent, ResponseStub } from '@solidjs/web';
import type { VerifyOtpParams } from '@supabase/supabase-js';

import { createSupabaseRequestClient } from '../../server/supabase';

/** A 302 that carries any session cookies the auth flow queued on the
 *  response stub — merged manually so it never depends on the host. */
function redirectTo(
  event: RequestEvent & { response: ResponseStub },
  path: string,
): Response {
  const origin = new URL(event.request.url).origin;
  const headers = new Headers({ location: `${origin}${path}` });
  for (const cookie of event.response.headers.getSetCookie()) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
}

export const GET: APIHandler = async (event) => {
  // The API event is the core request event with matched params added on;
  // the assertion is for the type checker only.
  const e = event as unknown as RequestEvent & { response: ResponseStub };
  const url = new URL(e.request.url);

  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');

  if (!code && !(tokenHash && type)) {
    return redirectTo(e, '/sign-in?error=missing-token');
  }

  const supabase = createSupabaseRequestClient();
  let error = null as { message: string } | null;
  if (code) {
    // PKCE: redeem the authorization code with the verifier cookie.
    ({ error } = await supabase.auth.exchangeCodeForSession(code));
  } else {
    ({ error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash!,
      type: type as VerifyOtpParams['type'],
    }));
  }
  if (error) {
    return redirectTo(e, `/sign-in?error=${encodeURIComponent(error.message)}`);
  }
  return redirectTo(e, '/');
};

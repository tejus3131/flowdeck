import 'server-only';

// Supabase clients for the server side, composed over Solid's request event
// exactly like a session library: @supabase/ssr is a cookie library, and
// the request event gives it a place to read and write.
//
// The request-scoped client carries the user's Supabase cookies, so
// .auth.getUser() and every .from() query run under the caller's JWT and
// Postgres RLS is the actual security layer. The service client bypasses
// RLS and exists only for administrative calls (signed storage URLs) —
// never for anything shaped like a user read.
import { getRequestEvent } from '@solidjs/web';
import type { RequestEvent, ResponseStub } from '@solidjs/web';
import { createServerClient } from '@supabase/ssr';
import { parseCookie, stringifySetCookie } from 'cookie';
import { env } from 'virtual:solid-env/server';

import type { Database } from '../types/database.generated';

function event(): RequestEvent & { response: ResponseStub } {
  const e = getRequestEvent();
  if (!e) {
    throw new Error(
      'supabase: no request event — call within a server function, SSR handler, or middleware',
    );
  }
  return e as RequestEvent & { response: ResponseStub };
}

/**
 * A Supabase client bound to the current request's cookies. Session
 * cookies written by auth flows (verifyOtp, signOut) append to the
 * response stub and ride whatever response leaves the request.
 */
export function createSupabaseRequestClient() {
  const e = event();
  return createServerClient<Database>(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        const jar = parseCookie(e.request.headers.get('cookie') ?? '');
        return Object.entries(jar).map(([name, value]) => ({ name, value: value ?? '' }));
      },
      setAll(cookies) {
        for (const { name, value, options } of cookies) {
          e.response.headers.append(
            'set-cookie',
            stringifySetCookie({ name, value: value ?? '', ...options }),
          );
        }
      },
    },
  });
}

/**
 * The service-role client — RLS is OFF for this one. Administrative use
 * only (issuing signed storage URLs). Anything user-shaped goes through
 * createSupabaseRequestClient() so RLS applies.
 */
export function createSupabaseServiceClient() {
  return createServerClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}

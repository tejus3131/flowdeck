// Probe helper: creates (or reuses) a probe user and mints a magic-link
// token_hash via the service-key admin API, so we can sign the browser in
// through the real /auth/confirm route. Prints ONLY non-secret output.
import { createClient } from '@supabase/supabase-js';

const email = process.argv[2];
if (!email) {
  console.error('usage: node scripts/probe-link.mjs <email>');
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('missing SUPABASE_URL / SUPABASE_SECRET_KEY in env');
  process.exit(1);
}

const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const { data, error } = await admin.auth.admin.generateLink({
  type: 'magiclink',
  email,
  options: { should_create_user: true },
});
if (error) {
  console.error('generateLink failed:', error.message);
  process.exit(1);
}
// A brand-new user's first link is a SIGNUP confirmation token, not a
// magiclink — verifyOtp needs the matching type or it rejects it as
// "invalid or expired". Surface the real type for the confirm URL.
console.log(
  JSON.stringify(
    {
      token_hash: data.properties.hashed_token,
      type: data.properties.verification_type ?? 'magiclink',
      email,
      user_id: data.user?.id,
    },
    null,
    2,
  ),
);

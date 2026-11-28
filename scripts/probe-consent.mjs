// Consent-page SSR probe: reproduces the signed-in 500 on /mcp/authorize.
//
// The Cloudflare log shows the failing request carried session cookies —
// curl without cookies renders 200 — so the failure lives in a
// signed-in-only SSR path. This probe mints a throwaway user + session on
// the real project (never printed), builds the @supabase/ssr session
// cookie (base64 encoding, 3180-char chunking — mirroring cookies.ts),
// writes it to /tmp (tokens never echoed), and hits the authorize URL so
// we can compare: production vs the local production build.
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const URL = 'https://ylarhvcbpppujpjnpxkq.supabase.co';
const REF = 'ylarhvcbpppujpjnpxkq';
const keys = JSON.parse(
  execFileSync('supabase', ['projects', 'api-keys', '--output', 'json', '--project-ref', REF], {
    encoding: 'utf8',
  }),
);
const list = Array.isArray(keys) ? keys : (keys.data ?? []);
const anonKey = list.find((k) => k.name === 'anon').api_key;
const secretKey = list.find((k) => k.name === 'service_role').api_key;
const admin = createClient(URL, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const email = `consent-probe-${Date.now().toString(36)}@orbit.test`;
const password = `probe-${Date.now().toString(36)}!Aa1`;
const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (createErr || !created.user) {
  console.error('probe user failed:', createErr?.message);
  process.exit(1);
}

const pub = createClient(URL, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: signIn, error: signInErr } = await pub.auth.signInWithPassword({ email, password });
if (signInErr || !signIn.session) {
  console.error('probe sign-in failed:', signInErr?.message);
  process.exit(1);
}

// Mirror @supabase/ssr's default cookieEncoding 'base64' + createChunks.
const key = `sb-${REF}-auth-token`;
const b64 = `base64-${Buffer.from(JSON.stringify(signIn.session), 'utf8').toString('base64url')}`;
const encoded = encodeURIComponent(b64);
let cookie;
if (encoded.length <= 3180) {
  cookie = `${key}=${encoded}`;
} else {
  const chunks = [];
  let rest = encoded;
  while (rest.length > 0) {
    let head = rest.slice(0, 3180);
    const lastEsc = head.lastIndexOf('%');
    if (lastEsc > 3180 - 3) head = head.slice(0, lastEsc);
    let valueHead = '';
    while (head.length > 0) {
      try {
        valueHead = decodeURIComponent(head);
        break;
      } catch {
        head = head.slice(0, head.length - 3);
      }
    }
    chunks.push(valueHead);
    rest = rest.slice(head.length);
  }
  cookie = chunks.map((v, i) => `${key}.${i}=${encodeURIComponent(v)}`).join('; ');
}

// Session tokens: written to /tmp for the curl, never printed.
writeFileSync('/tmp/probe-cookie.txt', cookie);
// Env file for the local production build (anon key is public by design;
// never echoed).
writeFileSync(
  '/tmp/probe-env',
  `SUPABASE_URL=${URL}\nSUPABASE_PUBLISHABLE_KEY=${anonKey}\nSUPABASE_SECRET_KEY=${secretKey}\nPORT=3004\n`,
);
console.log(
  `probe user ${email} signed in; cookie written (${cookie.length} chars, chunked=${encoded.length > 3180})`,
);
console.log(
  'now run: curl -s -o /dev/null -w "%{http_code}\\n" -H "Cookie: $(cat /tmp/probe-cookie.txt)" "<authorize url>"',
);

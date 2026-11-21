import * as v from 'valibot';

// The typed env schema (probed by the plugin from the project root): plain
// objects of Standard Schema validators — valibot here, but zod, arktype, or
// any compliant library works, even mixed per key.
//
// `server` vars come through `virtual:solid-env/server` (server modules only;
// importing it from client code fails the build) and are read from
// process.env at BOOT, validated then: secrets rotate without a rebuild and
// never appear in build artifacts. `client` vars must carry the public
// VITE_ prefix and come through `virtual:solid-env/client` as validated values
// baked into the bundle. Generated types land in solid-env.d.ts.
export default {
  server: {
    // Supabase project API endpoint (local stack in dev, hosted in prod).
    SUPABASE_URL: v.pipe(v.string(), v.url()),
    // The publishable (anon) key — public by design; RLS is the security
    // layer for everything done with it.
    SUPABASE_PUBLISHABLE_KEY: v.pipe(v.string(), v.minLength(20)),
    // The secret (service role) key — server-only; used solely for
    // administrative calls (signed storage URLs etc.), never for user reads.
    SUPABASE_SECRET_KEY: v.pipe(v.string(), v.minLength(20)),
  },
  client: {
    VITE_APP_NAME: v.optional(v.pipe(v.string(), v.minLength(1)), 'Flowdeck'),
    // Public by design; used by the browser Supabase client (presence,
    // passkey ceremonies, avatar uploads). Absent → those features
    // gracefully no-op (e.g. a build without presence).
    VITE_SUPABASE_URL: v.optional(v.pipe(v.string(), v.url())),
    VITE_SUPABASE_PUBLISHABLE_KEY: v.optional(v.pipe(v.string(), v.minLength(20))),
  },
};

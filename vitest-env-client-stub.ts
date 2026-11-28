// Test stub for the plugin's `virtual:solid-env/client` module (aliased in
// vite.config.ts's test block), honoring the same contract: live reads —
// values read at ACCESS time from import.meta.env, so tests (and a test's
// vi.stubEnv) see current values, and the plugin's schema validation never
// runs inside vitest. That validation requires the full schema — including
// the required server vars — to be present in the process, which a PR CI
// run must never have (ADR-15); the client project's tests import these
// modules (the flags runtime), so both halves are stubbed for tests.
// Divergence from the real module: schema DEFAULTS (e.g. VITE_APP_NAME's
// 'Orbit') are not applied here — a test that needs a default sets it.
export const env: Record<string, string | undefined> = new Proxy(
  {},
  { get: (_, key) => (typeof key === 'string' ? import.meta.env[key as never] : undefined) },
);
export default env;

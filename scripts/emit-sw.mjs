// Emits dist/client/sw.js after `vite build` completes (run from the
// 'build' script: `vite build && node scripts/emit-sw.mjs`). Lives outside
// the Vite plugin graph because the Cloudflare plugin's buildApp override
// owns the build lifecycle: shared-plugin closeBundle hooks fire in the
// CLIENT environment only, which closes BEFORE the SSR environment writes
// dist/server/server.js — the shell prerender there found no handler and
// failed the whole build (the CI failure). After the full build both
// dist/client and dist/server are complete, so this script does the work
// with everything on disk.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { transformWithOxc } from 'vite';

const root = process.cwd();
const outDir = path.resolve(root, 'dist/client');
const swSource = path.resolve(root, 'src/sw.ts');
if (!existsSync(outDir)) {
  console.error('[emit-sw] dist/client missing — run vite build first');
  process.exit(1);
}
const serverEntry = path.resolve(root, 'dist/server/server.js');
if (!existsSync(serverEntry)) {
  console.error('[emit-sw] dist/server/server.js missing — the SSR build did not run');
  process.exit(1);
}
// Every emitted client asset (hashed filenames) + the shell documents.
const assets = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else assets.push(`/${path.relative(outDir, full).split(path.sep).join('/')}`);
  }
};
walk(outDir);
// The app shell document: the offline fallback for navigations is the app
// itself (the entity store rehydrates the board), so the precache needs a
// document at '/'. The build runs with SSR on — no static index.html is
// emitted — so this renders one through the built handler (the same
// markup a signed-out visit gets: nav + loading shell; hydration adopts
// it on load).
//
// The handler validates server env at boot; the shell document is
// user-agnostic markup (nav + loading shell), so the local stack's URL
// with placeholder keys is exactly right — nothing in the shell document
// reads Supabase.
process.env.SUPABASE_URL ??= 'http://127.0.0.1:54321';
process.env.SUPABASE_PUBLISHABLE_KEY ??= 'local-shell-placeholder-key-0123456789';
process.env.SUPABASE_SECRET_KEY ??= 'local-shell-placeholder-key-0123456789';
const { handleRequest } = await import(serverEntry);
const response = await handleRequest(new Request('http://localhost/'), {
  renderMode: 'async',
});
const html = await response.text();
if (!html.includes('<html')) throw new Error('handler returned no HTML document');
writeFileSync(path.join(outDir, 'index.html'), html);
// Written after the walk — add it to the precache list directly.
assets.push('/index.html');
const version = `assets-${Date.now().toString(36)}`;
const precache = assets.filter(
  (url) =>
    (url.startsWith('/assets/') ||
      url === '/offline.html' ||
      url === '/manifest.webmanifest' ||
      url === '/index.html') &&
    !url.endsWith('.map') &&
    // The build also emits pre-compressed .br/.gz twins (served by the
    // asset layer's content-encoding negotiation) — the SW fetches by
    // plain URL and gets the right encoding itself.
    !url.endsWith('.br') &&
    !url.endsWith('.gz'),
);
// Vite's own TypeScript transform (Oxc) — the same dependency the build
// already uses, no extra install. The SW source imports nothing, so a
// single-file transform is the whole compile.
const source = readFileSync(swSource, 'utf8')
  .replace('__FD_SW_VERSION__', version)
  .replace("'__FD_PRECACHE_MANIFEST__'", JSON.stringify(precache));
const result = await transformWithOxc(source, swSource, { target: 'es2020' });
// Served as /sw.js?v=<version>: the version query makes the controller's
// scriptURL self-identifying — the page's reload guard
// (src/lib/sw-update.ts) stores it and only skips a reload for a version
// it has already applied. The asset layer serves /sw.js regardless of
// query (max-age=0 via _headers).
writeFileSync(path.join(outDir, 'sw.js'), result.code);
writeFileSync(path.join(outDir, 'sw-version.txt'), version);
console.log(`[emit-sw] sw.js emitted — ${precache.length} precached URLs, version ${version}`);

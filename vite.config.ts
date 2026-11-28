import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileRoutes } from 'filesystem-routing/vite';
import { routePathFromFile } from 'filesystem-routing';
import { defineConfig, type Plugin } from 'vitest/config';
import solid from '@solidjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

import { manifestPlugin } from './vite-manifest-plugin';

// The Cloudflare plugin runs the ssr environment in workerd during dev.
// Outbound websockets to loopback addresses are blocked in local workerd
// (miniflare), which Supabase Realtime needs — so `pnpm dev:node` drops
// the plugin for local dev and runs the SSR in Node instead. Builds keep
// the plugin regardless: `vite build` always emits the Workers artifact.
const edgeDev = process.env.DEV_EDGE !== '0' && !process.env.VITEST;

// The service worker is a classic script at a fixed URL (/sw.js), outside
// the app graph: it must not be hashed (the browser re-checks the same
// URL), must not import the app's modules, and must know the build's
// hashed asset list to precache. This plugin transforms src/sw.ts (it
// imports nothing, so a single-file transform is the whole compile) into
// dist/client/sw.js, stamping the cache version (the build id) and the
// precache manifest (every emitted client asset + the shell documents)
// into the template's tokens. Dev serves public/sw.js as today (no
// precache — dev assets are unhashed and change constantly).
function serviceWorkerPlugin(): Plugin {
  const swSource = fileURLToPath(new URL('./src/sw.ts', import.meta.url));
  let outDir = '';
  let version = '';
  return {
    name: 'flowdeck-service-worker',
    apply: 'build',
    configResolved(config) {
      // The Cloudflare plugin flattens the client environment's outDir to
      // dist/client directly (the built wrangler.json's assets.directory
      // is ../client) — so outDir IS the client dir here. Fall back to
      // dist/client for configs where it isn't.
      const resolved = path.resolve(config.root, config.build.outDir);
      outDir = path.basename(resolved) === 'client' ? resolved : path.resolve(resolved, 'client');
      version = `${config.build.assetsDir}-${Date.now().toString(36)}`;
    },
    async closeBundle() {
      if (!existsSync(outDir)) return;
      // Every emitted client asset (hashed filenames) + the offline
      // fallback document. The precache is the shell's building blocks;
      // navigations themselves are never cached (SSR renders per user).
      const assets: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else assets.push(`/${path.relative(outDir, full).split(path.sep).join('/')}`);
        }
      };
      walk(outDir);
      const precache = assets.filter(
        (url) =>
          (url.startsWith('/assets/') ||
            url === '/offline.html' ||
            url === '/manifest.webmanifest') &&
          !url.endsWith('.map') &&
          // The build also emits pre-compressed .br/.gz twins (served by
          // the asset layer's content-encoding negotiation) — the SW
          // fetches by plain URL and gets the right encoding itself.
          !url.endsWith('.br') &&
          !url.endsWith('.gz'),
      );
      // Vite's own TypeScript transform (Oxc) — the same dependency the
      // build already uses, no extra install. The SW source imports
      // nothing, so a single-file transform is the whole compile.
      const { transformWithOxc } = await import('vite');
      const source = readFileSync(swSource, 'utf8')
        .replace('__FD_SW_VERSION__', version)
        .replace("'__FD_PRECACHE_MANIFEST__'", JSON.stringify(precache));
      const result = await transformWithOxc(source, swSource, { target: 'es2020' });
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, 'sw.js'), result.code);
    },
  };
}

export default defineConfig({
  // Turnkey streaming SSR: no index.html and no entry files — the plugin
  // generates the entries around src/App.tsx, wrapped in src/Document.tsx.
  // `vite build` emits client assets to dist/client and the request handler
  // to dist/server, plus the Node server (dist/server/node.js) `npm start` runs.
  plugins: [
    tailwindcss(),
    // The PWA manifest is emitted at build time from src/lib/brand.ts —
    // one source, no public/ copy to drift.
    manifestPlugin(),
    // Cloudflare's plugin adopts Solid's `ssr` environment before solid()
    // claims it: dev runs the server build in workerd, and `vite build`
    // emits the Worker + assets wrangler deploys. No adapter layer.
    ...(edgeDev ? [cloudflare({ viteEnvironment: { name: 'ssr' } })] : []),
    solid({
      start: {
        middleware: './src/middleware.ts',
        // Emit dist/server/node.js: a ready-to-run Node server (static
        // assets + the handler). Other platforms import dist/server/server.js.
        nodeServer: true,
        // Typed env is on by convention: ./env.ts is probed automatically.
        // (Set the top-level `env: false` option to opt out.)
      },
      // Set to false for a static shell + API server: pages render on the
      // client while server functions, sessions, and API routes keep working.
      ssr: true,
      // Dev-only: capture control at /__solid/diagnostics (see AGENTS.md).
      diagnostics: true,
      // The serverSetup module runs in the handler graph before any dispatch:
      // it registers the router's single-flight collector.
      serverFunctions: { serverSetup: './src/server-config.ts' },
      // `extensions` makes @solidjs/vite-plugin also compile the `?pick=` route
      // modules the fileRoutes plugin emits (their ids end in a query string).
      extensions: ['.jsx', '.tsx'],
    }),
    // `httpMethods` also scans route modules for GET/POST/... exports (API
    // routes); handler modules never enter the client bundle.
    //
    // `toPath`: the scanner's glob skips dot-directories, so RFC 8414
    // well-known routes live in `src/routes/well-known/` and are mapped to
    // their real `/.well-known/...` paths here. Everything else keeps the
    // default page convention.
    fileRoutes({
      httpMethods: true,
      types: true,
      toPath: (routeFile) =>
        routeFile.startsWith('/well-known/')
          ? routePathFromFile(`/.well-known/${routeFile.slice('/well-known/'.length)}`)
          : routePathFromFile(routeFile),
    }),
    // The offline shell: compile + stamp src/sw.ts → dist/client/sw.js
    // (see the plugin comment above).
    serviceWorkerPlugin(),
  ],
  server: {
    port: 3000,
  },
  test: {
    globals: false,
    setupFiles: ['./vitest-setup.ts'],
    // Two projects because they need different halves of the framework:
    // component tests run in a DOM against the browser build, server-runtime
    // tests (the session suite) run in node against the real server build.
    projects: [
      {
        extends: true,
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          alias: [
            // The plugin's env modules validate the WHOLE schema at module
            // load — including the required server vars, which a PR CI run
            // must never have (ADR-15). Client-project tests import both
            // halves (the flags runtime's snapshot reads the server module),
            // so both are stubbed with the same contract (live reads).
            {
              find: 'virtual:solid-env/client',
              replacement: fileURLToPath(new URL('./vitest-env-client-stub.ts', import.meta.url)),
            },
            {
              find: 'virtual:solid-env/server',
              replacement: fileURLToPath(new URL('./vitest-env-server-stub.ts', import.meta.url)),
            },
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'server',
          // environment:'node' projects get the server posture from the
          // plugin automatically (server conditions, framework inlined).
          environment: 'node',
          include: [
            'src/server/**/*.test.ts',
            'src/lib/mcp-permissions.test.ts',
            'src/lib/brand.test.ts',
            'src/routes/api/**/*.test.ts',
          ],
          alias: [
            // Tests run outside the turnkey server: the plugin's env module
            // is stubbed with the same contract (live process.env reads).
            {
              find: 'virtual:solid-env/server',
              replacement: fileURLToPath(new URL('./vitest-env-server-stub.ts', import.meta.url)),
            },
          ],
        },
      },
    ],
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
  },
});

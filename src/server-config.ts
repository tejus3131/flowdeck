// Pre-dispatch server-function configuration (pinned into the handler graph
// via `serverFunctions.serverSetup` in vite.config.ts; it loads before any
// dispatch, on the dev middleware and the production handler alike).
//
// Registering the router as the single-flight collector is what turns a
// mutation into ONE round trip: the action response carries the refreshed
// `query()` data for the page the client will show (the collector reruns
// that route's preloads on the server), and the router seeds its cache from
// the envelope instead of refetching.
import { configureServerFunctionsServer } from '@solidjs/web/server-functions/server';
import { createFlightDataCollector } from '@solidjs/router/server';

// Server-error instrumentation: production builds sanitize the ORIGINAL
// error down to "Internal Server Error" before it reaches logs or the wire,
// which made /mcp/authorize's production 500 undiagnosable from CF logs.
// This hook sees the original error (message + stack + owner path) and
// console.errors it — Cloudflare observability captures console output, so
// the real cause lands in the Workers logs. Once the failing page is fixed,
// this can be narrowed or removed.
import { configureServerErrors } from '@solidjs/web';

import { Router } from './router';

configureServerErrors({
  onError(error, context) {
    // Never changes the wire error (returns undefined) — logging only.
    console.error(
      '[server-error]',
      JSON.stringify({
        kind: context?.kind,
        handling: context?.handling,
        ownerPath: context?.ownerPath,
        boundaryPath: context?.boundaryPath,
      }),
      error,
    );
  },
});

configureServerFunctionsServer({
  collectFlightData: createFlightDataCollector(Router),
});

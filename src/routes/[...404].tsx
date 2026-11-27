import type { RouteDefinition } from '@solidjs/router';
import { httpStatus } from '@solidjs/web';

// The catch-all route. httpStatus() sets the response status during SSR
// (a no-op in the browser); it runs in preload so the status code is set
// before the response head flushes.
import { NotFound } from '../components/NotFound';

export const route = {
  preload: () => httpStatus(404),
} satisfies RouteDefinition;

export default function NotFoundRoute() {
  return <NotFound />;
}

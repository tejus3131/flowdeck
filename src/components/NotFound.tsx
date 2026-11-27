import { Title } from '@solidjs/meta';

// The app's one 404 view — shared by the catch-all route and the
// playground's denied state: an unauthorized /playground request gets
// the SAME response as an unknown route (the access check is the flag
// contract's fail-closed deny; this component is what that deny shows).
export function NotFound() {
  return (
    <main>
      <Title>Not Found - Solid App</Title>
      <h1>Page Not Found</h1>
      <p>
        Visit{' '}
        <a href="https://docs.solidjs.com" target="_blank" rel="noreferrer">
          docs.solidjs.com
        </a>{' '}
        to learn how to build apps.
      </p>
    </main>
  );
}

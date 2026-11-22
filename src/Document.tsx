import type { ParentProps } from 'solid-js';
import { HydrationScript, getRequestEvent } from '@solidjs/web';

// The document shell (the index.html replacement), picked up by the
// src/Document.* convention; it must render the full <html> and ships no
// client JS. <HydrationScript /> is stripped from the prerendered shell in
// client mode and activates under `ssr: true`. Delete this file to fall
// back to the plugin's built-in shell.
//
// Theming: the inline pre-paint script resolves the theme cookie against
// prefers-color-scheme and stamps <html> before the browser paints — the
// no-flash half of the theme system. The server also renders the class for
// explicit "dark" so even a JS-less load looks right. The cookie read is
// inlined here (no app imports) so this shell never pulls server-only code
// into the client graph.

const NO_FLASH_SCRIPT = `try{var m=document.cookie.match(/(?:^|; )fd_theme=(system|light|dark)/);var t=m?m[1]:'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light';}catch(e){}`;

function ssrThemeIsDark(): boolean {
  // getRequestEvent() is isomorphic and returns undefined outside a
  // request — on the client this is simply false.
  const header = getRequestEvent()?.request.headers.get('cookie') ?? '';
  return /(?:^|;\s*)fd_theme=dark(?:;|$|\s)/.test(header);
}

export default function Document(props: ParentProps) {
  return (
    <html lang="en" class={ssrThemeIsDark() ? 'dark' : undefined}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <meta name="theme-color" content="#4f46e5" />
        <title>Solid App</title>
        {/* A compile-time constant, not user input — the lint rule targets
            unsanitized data, and inline is required to beat first paint. */}
        {/* eslint-disable-next-line solid/no-innerhtml */}
        <script innerHTML={NO_FLASH_SCRIPT} />
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  );
}

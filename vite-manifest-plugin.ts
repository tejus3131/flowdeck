// The manifest plugin: emits dist/client/manifest.webmanifest at build
// time from src/lib/brand.ts — the PWA manifest has exactly one source
// (the public/ copy is gone; docs/pwa-seo-brand-plan.md, phase 5).
// Dev serves the same object from middleware so the browser gets a
// manifest during `pnpm dev` too.
import type { Plugin } from 'vite';

import { brand } from './src/lib/brand';

/** The manifest object, derived from the brand config. */
export function manifestFromBrand(): Record<string, unknown> {
  return {
    name: brand.name,
    short_name: brand.shortName,
    description: brand.description,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: brand.themeColor,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

export function manifestPlugin(): Plugin {
  return {
    name: 'flowdeck-manifest',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(manifestFromBrand(), null, 2) + '\n',
      });
    },
  };
}

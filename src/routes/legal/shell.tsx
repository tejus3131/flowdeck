// The legal pages' shared shell: the prose layout, the effective-date
// line, and the contact footer every policy page carries. Content lives
// in the route files; this only owns the frame.
import type { ParentProps } from 'solid-js';
import type { JSX } from '@solidjs/web';

import { SeoHead } from '../../lib/seo';

export function LegalPage(props: {
  title: string;
  description: string;
  path: string;
  updated: string;
  children: JSX.Element;
}) {
  return (
    <main class="mx-auto max-w-3xl px-4 py-10">
      <SeoHead title={props.title} description={props.description} path={props.path} />
      <h1 class="text-2xl font-semibold tracking-tight">{props.title}</h1>
      <p class="mt-1 text-xs text-neutral-400">Effective {props.updated}</p>
      <div class="mt-6 space-y-6 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        {props.children}
      </div>
      <p class="mt-10 border-t border-neutral-200 pt-4 text-xs text-neutral-400 dark:border-neutral-800">
        Questions about this page?{' '}
        <a href="/contact" class="text-indigo-600 underline dark:text-indigo-400">
          Contact us
        </a>
        .
      </p>
    </main>
  );
}

/** A numbered section heading inside a legal page. */
export function LegalSection(props: { n: string; title: string; children: JSX.Element }) {
  return (
    <section>
      <h2 class="text-base font-semibold tracking-tight">
        {props.n}. {props.title}
      </h2>
      <div class="mt-2 space-y-2">{props.children}</div>
    </section>
  );
}

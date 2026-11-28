// The SEO head tags a public page declares: description, OG + Twitter
// card, and a self-referencing canonical. Rendered through the
// @solidjs/meta registry (never hardcoded in Document.tsx — the registry
// dedupes; the document shell does not). App routes are noindexed by the
// middleware, so only public pages mount this.
import { Link, Meta, Title } from '@solidjs/meta';

import { brand } from './brand';

/** The absolute URL for a site-absolute path (or a full URL, unchanged). */
function absolute(pathOrUrl: string): string {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${brand.url.replace(/\/+$/, '')}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;
}

/** The public page's head: title, description, OG/Twitter, canonical.
 *  `path` is the page's own site-absolute path (the canonical target);
 *  `image` defaults to the brand OG image. */
export function SeoHead(props: {
  title: string;
  description: string;
  path: string;
  image?: string;
}) {
  const canonical = () => absolute(props.path);
  const image = () => absolute(props.image ?? brand.ogImage);
  return (
    <>
      <Title>{props.title}</Title>
      <Meta name="description" content={props.description} />
      <Meta property="og:title" content={props.title} />
      <Meta property="og:description" content={props.description} />
      <Meta property="og:type" content="website" />
      <Meta property="og:url" content={canonical()} />
      <Meta property="og:site_name" content={brand.name} />
      <Meta property="og:image" content={image()} />
      <Meta property="og:image:width" content="1200" />
      <Meta property="og:image:height" content="630" />
      <Meta name="twitter:card" content="summary_large_image" />
      <Meta name="twitter:title" content={props.title} />
      <Meta name="twitter:description" content={props.description} />
      <Meta name="twitter:image" content={image()} />
      <Link rel="canonical" href={canonical()} />
    </>
  );
}

// JSON-LD structured data for the landing page: Organization + WebSite +
// SoftwareApplication (free — price 0, no fabricated ratings). Rendered
// as one script tag; the content is a compile-time constant, not user
// input (the lint rule targets unsanitized data).
import { brand } from './brand';

/** The landing page's structured data, serialized once. */
export function landingJsonLd(): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${brand.url}/#organization`,
        name: brand.name,
        legalName: brand.legalName,
        url: brand.url,
        email: brand.contactEmail,
        ...(brand.social.length > 0 ? { sameAs: brand.social } : {}),
      },
      {
        '@type': 'WebSite',
        '@id': `${brand.url}/#website`,
        url: brand.url,
        name: brand.name,
        publisher: { '@id': `${brand.url}/#organization` },
      },
      {
        '@type': 'SoftwareApplication',
        name: brand.name,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        description: brand.description,
        url: brand.url,
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
        },
        publisher: { '@id': `${brand.url}/#organization` },
      },
    ],
  });
}

import type { DocsSeoConfig } from '@tether/docs-seo-next';

/**
 * Production SEO base URL. Set in CI/deploy (e.g. `https://docs.tether.io`).
 */
export function getDocsSeoConfig(): DocsSeoConfig {
  const origin =
    process.env.NEXT_PUBLIC_DOCS_ORIGIN ?? 'http://localhost:3001';

  return {
    metadataBase: new URL(origin),
    siteName: 'DOCS',
    imageSiteLabel: 'Tether',
    publisherName: 'Tether',
    publisherLogoUrl: process.env.NEXT_PUBLIC_DOCS_PUBLISHER_LOGO_URL,
    trailingSlash: true,
    staticOgImagePath: '/og-default.png',
  };
}

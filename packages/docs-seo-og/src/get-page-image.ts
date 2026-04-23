import type { TetherPage } from '@tetherto/docs-seo-core';

export type PageImageResult = {
  segments: string[];
  /** Root-relative URL, e.g. `/og/docs/foo/image.webp` */
  url: string;
};

/**
 * OG image segments and root-relative URL (Fumadocs convention: terminal `image.webp`).
 * With `output: 'export'`, run `precomputeTakumiOgImages` from `@tetherto/docs-seo-og/build` before
 * `next build` so these paths exist under `public/`. For dynamic SSR, use a Route Handler instead.
 * @see https://fumadocs.dev/docs/integrations/og/takumi
 */
export function getPageImage(
  page: TetherPage,
  ogRouteBase = '/og/docs',
): PageImageResult {
  const segments = [...page.slugs, 'image.webp'];
  const base = ogRouteBase.replace(/\/$/, '');
  return {
    segments,
    url: `${base}/${segments.join('/')}`,
  };
}

export function docsOgGenerateStaticParams(
  getPages: () => TetherPage[],
): { slug: string[] }[] {
  return getPages().map((page) => ({
    slug: getPageImage(page).segments,
  }));
}

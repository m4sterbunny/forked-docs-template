import type { TetherPage } from '@tetherto/docs-seo-core';
import { ImageResponse } from '@takumi-rs/image-response';
import { generate as OgTemplate } from 'fumadocs-ui/og';

export type DocsOgHandlerOptions = {
  getPage: (slugs: string[] | undefined) => TetherPage | undefined;
  /** Takumi template `site` prop (e.g. `Tether`) */
  site: string;
};

export async function docsOgGet(
  slug: string[] | undefined,
  options: DocsOgHandlerOptions,
): Promise<Response> {
  if (!slug?.length) {
    return new Response('Not Found', { status: 404 });
  }
  if (slug[slug.length - 1] !== 'image.webp') {
    return new Response('Not Found', { status: 404 });
  }

  const pageSlugs = slug.slice(0, -1);
  const page = options.getPage(pageSlugs.length ? pageSlugs : undefined);
  if (!page) {
    return new Response('Not Found', { status: 404 });
  }

  const title = page.data.title ?? '';
  const description = page.data.description ?? '';

  return new ImageResponse(
    <OgTemplate title={title} description={description} site={options.site} />,
    {
      width: 1200,
      height: 630,
      format: 'webp',
    },
  );
}

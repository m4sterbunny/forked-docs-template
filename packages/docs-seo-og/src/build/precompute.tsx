import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import matter from 'gray-matter';
import { getSlugs } from 'fumadocs-core/source';
import { ImageResponse } from '@takumi-rs/image-response';
import { generate as OgTemplate } from 'fumadocs-ui/og';

export type PrecomputeTakumiOgImagesOptions = {
  /** Absolute or cwd-relative path to `content/docs` */
  contentDocsDir: string;
  /** Absolute or cwd-relative path to Next `public` */
  publicDir: string;
  /** Takumi `site` prop (e.g. `Tether`) */
  site: string;
  /** Must match `getPageImage` / metadata (default `/og/docs`) */
  ogRouteBase?: string;
  /** Parallel renders; Takumi uses WASM so keep modest (default 3) */
  concurrency?: number;
};

function posixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

function outputFilePath(
  publicDir: string,
  ogRouteBase: string,
  segments: string[],
): string {
  const base = ogRouteBase.replace(/^\//, '').replace(/\/$/, '');
  return path.join(publicDir, ...base.split('/'), ...segments);
}

async function renderOne(
  absFile: string,
  contentDocsDir: string,
  publicDir: string,
  ogRouteBase: string,
  site: string,
): Promise<void> {
  const rel = posixRelative(contentDocsDir, absFile);
  const slugs = getSlugs(rel);
  const raw = await readFile(absFile, 'utf8');
  const { data } = matter(raw);
  const title = typeof data.title === 'string' ? data.title : '';
  const description =
    typeof data.description === 'string' ? data.description : '';

  const segments = [...slugs, 'image.webp'];
  const outPath = outputFilePath(publicDir, ogRouteBase, segments);
  await mkdir(path.dirname(outPath), { recursive: true });

  const response = new ImageResponse(
    <OgTemplate title={title} description={description} site={site} />,
    {
      width: 1200,
      height: 630,
      format: 'webp',
    },
  );

  await response.ready;
  const buf = await response.arrayBuffer();
  await writeFile(outPath, Buffer.from(buf));
}

/**
 * Generate static WebP OG images under `public/og/docs/.../image.webp` for static export.
 * Uses the same slug rules as Fumadocs (`getSlugs`) and the same path layout as `getPageImage`.
 */
export async function precomputeTakumiOgImages(
  options: PrecomputeTakumiOgImagesOptions,
): Promise<void> {
  const {
    contentDocsDir,
    publicDir,
    site,
    ogRouteBase = '/og/docs',
    concurrency = 3,
  } = options;

  const docsRoot = path.resolve(contentDocsDir);
  const pubRoot = path.resolve(publicDir);

  const { glob } = await import('glob');
  const absFiles = await glob('**/*.mdx', {
    cwd: docsRoot,
    nodir: true,
    absolute: true,
  });

  for (let i = 0; i < absFiles.length; i += concurrency) {
    const batch = absFiles.slice(i, i + concurrency);
    await Promise.all(
      batch.map((absFile) =>
        renderOne(absFile, docsRoot, pubRoot, ogRouteBase, site),
      ),
    );
  }
}

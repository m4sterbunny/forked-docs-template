import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  transpilePackages: [
    '@tetherto/docs-seo-schema',
    '@tetherto/docs-seo-core',
    '@tetherto/docs-seo-next',
    '@tetherto/docs-seo-og',
  ],
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default withMDX(config);

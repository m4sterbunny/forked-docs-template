import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  transpilePackages: [
    '@tether/docs-seo-schema',
    '@tether/docs-seo-core',
    '@tether/docs-seo-next',
    '@tether/docs-seo-og',
  ],
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default withMDX(config);

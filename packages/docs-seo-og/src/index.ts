/**
 * URL helpers safe for static export / client bundles (no Takumi).
 * For Route Handlers, import from `@tether/docs-seo-og/handler`.
 */
export {
  docsOgGenerateStaticParams,
  getPageImage,
  type PageImageResult,
} from './get-page-image';
export type { TetherPage, WarnMissingSeoFrontmatterOptions } from '@tether/docs-seo-core';
export {
  DOCS_SEO_WARN_PREFIX,
  warnMissingSeoFrontmatterFields,
} from '@tether/docs-seo-core';

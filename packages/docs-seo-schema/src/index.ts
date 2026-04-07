/**
 * SEO-related frontmatter fields for Fumadocs MDX collections.
 * @see proposals/improve-seo-technical-spec-v2/meta-standards-and-frontmatter.md
 */
import { z } from 'zod';

export const jsonLdSchemaTypeSchema = z.enum([
  'TechArticle',
  'APIReference',
  'WebPage',
]);

export const docTypeSchema = z.enum([
  'tutorial',
  'how-to',
  'reference',
  'explanation',
  'page',
  'faq',
  'getting-started',
]);

export const tetherSeoFrontmatterSchema = z.object({
  /** Non-empty after trim; required for meta, Open Graph / Twitter, and JSON-LD. */
  description: z
    .string()
    .trim()
    .min(1, 'description is required for SEO (meta, Open Graph, JSON-LD)'),
  noIndex: z.boolean().optional(),
  ogImage: z.string().optional(),
  schemaType: jsonLdSchemaTypeSchema.optional(),
  docType: docTypeSchema.optional(),
  lastModified: z.union([z.string(), z.coerce.date()]).optional(),
});

export type TetherSeoFrontmatter = z.infer<typeof tetherSeoFrontmatterSchema>;
export type JsonLdSchemaType = z.infer<typeof jsonLdSchemaTypeSchema>;
export type DocType = z.infer<typeof docTypeSchema>;

export const SEO_SCHEMA_VERSION = 1;

// --- Frontmatter gap warnings (console; deduped per page in-process). Set DOCS_SEO_SILENT=1 to disable.

export const DOCS_SEO_WARN_PREFIX = '[@tether/docs-seo]';

const warnedSlugKeys = new Set<string>();

function slugDedupeKey(slugs: string[]): string {
  return slugs.length === 0 ? '' : slugs.join('/');
}

function pageLabel(slugs: string[]): string {
  if (slugs.length === 0) return '/';
  return `/${slugs.join('/')}/`;
}

function seoWarningsSilent(): boolean {
  return process.env.DOCS_SEO_SILENT === '1';
}

function missingDescription(data: Record<string, unknown>): boolean {
  const v = data.description;
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  return false;
}

function missingOptionalEnumish(data: Record<string, unknown>, key: string): boolean {
  return data[key] === undefined || data[key] === null;
}

function missingNonEmptyString(data: Record<string, unknown>, key: string): boolean {
  const v = data[key];
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  return false;
}

function missingLastModified(data: Record<string, unknown>): boolean {
  const v = data.lastModified;
  if (v === undefined || v === null) return true;
  if (v instanceof Date) return Number.isNaN(v.getTime());
  if (typeof v === 'string') return v.trim().length === 0;
  return false;
}

export type WarnMissingSeoFrontmatterOptions = {
  /** @default console.warn */
  warn?: (message: string) => void;
};

/**
 * Emits one console warning per missing SEO-related frontmatter field.
 * Dedupes by slug path so multiple packages can call this for the same page safely.
 *
 * Required `description` is enforced by `tetherSeoFrontmatterSchema` at MDX compile time;
 * this still warns if raw content (e.g. gray-matter) is missing it before validation.
 */
export function warnMissingSeoFrontmatterFields(
  data: Record<string, unknown>,
  slugs: string[],
  options?: WarnMissingSeoFrontmatterOptions,
): void {
  if (seoWarningsSilent()) return;

  const key = slugDedupeKey(slugs);
  if (warnedSlugKeys.has(key)) return;
  warnedSlugKeys.add(key);

  const warn = options?.warn ?? console.warn;
  const label = pageLabel(slugs);

  if (missingDescription(data)) {
    warn(
      `${DOCS_SEO_WARN_PREFIX} ${label} frontmatter "description" is missing or empty (required for meta, Open Graph, JSON-LD).`,
    );
  }

  if (missingNonEmptyString(data, 'ogImage')) {
    warn(
      `${DOCS_SEO_WARN_PREFIX} ${label} frontmatter "ogImage" is missing (using generated or default social image).`,
    );
  }

  if (missingOptionalEnumish(data, 'schemaType')) {
    warn(
      `${DOCS_SEO_WARN_PREFIX} ${label} frontmatter "schemaType" is missing (JSON-LD @type is inferred from path / docType).`,
    );
  }

  if (missingOptionalEnumish(data, 'docType')) {
    warn(
      `${DOCS_SEO_WARN_PREFIX} ${label} frontmatter "docType" is missing (set for clearer Diátaxis / JSON-LD defaults).`,
    );
  }

  if (missingLastModified(data)) {
    warn(
      `${DOCS_SEO_WARN_PREFIX} ${label} frontmatter "lastModified" is missing (sitemap lastmod / JSON-LD dates will be omitted).`,
    );
  }
}

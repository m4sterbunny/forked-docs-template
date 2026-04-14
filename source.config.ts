import {
  defineConfig,
  defineDocs,
  frontmatterSchema,
  metaSchema,
} from 'fumadocs-mdx/config';
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { tetherSeoFrontmatterSchema } from '@tether/docs-seo-schema';
import { z } from "zod";
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';

// You can customise Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections#define-docs
export const docs = defineDocs({
  docs: {
    // Passthrough keeps arbitrary frontmatter (e.g. stub `external`) for page handlers;
    // known fields are still validated (SEO via tetherSeoFrontmatterSchema, Fumadocs base via frontmatterSchema).
    schema: frontmatterSchema
      .extend({
        titleStyle: z.enum(["code", "text"]).optional(),
      })
      .extend(tetherSeoFrontmatterSchema.shape)
      .passthrough(),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMath, remarkMdxMermaid],
    rehypePlugins: (v) => [rehypeKatex, ...v],
  },
});

// source.config.ts
import {
  defineConfig,
  defineDocs,
  frontmatterSchema,
  metaSchema
} from "fumadocs-mdx/config";
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { z } from "zod";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
var docs = defineDocs({
  docs: {
    schema: frontmatterSchema.extend({
      titleStyle: z.enum(["code", "text"]).optional()
    }),
    postprocess: {
      includeProcessedMarkdown: true
    }
  },
  meta: {
    schema: metaSchema
  }
});
var source_config_default = defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMath, remarkMdxMermaid],
    rehypePlugins: (v) => [rehypeKatex, ...v]
  }
});
export {
  source_config_default as default,
  docs
};

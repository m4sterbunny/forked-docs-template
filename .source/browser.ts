// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  docs: create.doc("docs", {"index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "about/about.mdx": () => import("../content/docs/about/about.mdx?collection=docs"), "faqs/faqs.mdx": () => import("../content/docs/faqs/faqs.mdx?collection=docs"), "getting-started/quickstart.mdx": () => import("../content/docs/getting-started/quickstart.mdx?collection=docs"), "how-tos/how-to.mdx": () => import("../content/docs/how-tos/how-to.mdx?collection=docs"), "references/references.mdx": () => import("../content/docs/references/references.mdx?collection=docs"), "tutorials/tutorials.mdx": () => import("../content/docs/tutorials/tutorials.mdx?collection=docs"), }),
};
export default browserCollections;
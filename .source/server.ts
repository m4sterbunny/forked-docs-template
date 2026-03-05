// @ts-nocheck
import * as __fd_glob_6 from "../content/docs/tutorials/tutorials.mdx?collection=docs"
import * as __fd_glob_5 from "../content/docs/references/references.mdx?collection=docs"
import * as __fd_glob_4 from "../content/docs/how-tos/how-to.mdx?collection=docs"
import * as __fd_glob_3 from "../content/docs/getting-started/quickstart.mdx?collection=docs"
import * as __fd_glob_2 from "../content/docs/faqs/faqs.mdx?collection=docs"
import * as __fd_glob_1 from "../content/docs/about/about.mdx?collection=docs"
import * as __fd_glob_0 from "../content/docs/index.mdx?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const docs = await create.docs("docs", "content/docs", {}, {"index.mdx": __fd_glob_0, "about/about.mdx": __fd_glob_1, "faqs/faqs.mdx": __fd_glob_2, "getting-started/quickstart.mdx": __fd_glob_3, "how-tos/how-to.mdx": __fd_glob_4, "references/references.mdx": __fd_glob_5, "tutorials/tutorials.mdx": __fd_glob_6, });
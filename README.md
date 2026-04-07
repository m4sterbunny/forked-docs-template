# DOCS docs

Official documentation and single source of truth for DOCS:

- Source code and content of the docs website.
- Automation scripts for the integration between the codebase and the documentation.

The site is a **static export** from a Next.js + [Fumadocs](https://fumadocs.dev) app (`output: 'export'`). SEO behavior is implemented with workspace packages under `@tether/docs-*` (see below).

## Installation

Prerequisites:

- Node.js >= 22.17.0
- `npm` >= 10.9.2

Install dependencies:

```bash
npm install
```

**`postinstall`** runs **fumadocs-mdx**, which generates **`.source/`** (gitignored). Run install after clone and after editing [`source.config.ts`](source.config.ts).

### Environment file

Copy the example file and fill in values (Next.js reads `.env.local` automatically):

```bash
cp env.example .env.local
```

See [`env.example`](env.example) for all variables. **Required** for production SEO:

- **`NEXT_PUBLIC_DOCS_ORIGIN`** — public docs URL for canonical and social metadata ([`seo-config.ts`](src/lib/seo-config.ts)); optional for local dev (defaults to `http://localhost:3001`).

**Optional — Inkeep:** set **`NEXT_PUBLIC_INKEEP_API_KEY`** only when you want [Inkeep](https://inkeep.com) for **search** (replacing the Fumadocs default dialog) and the **chat** widget. If it is unset, the app uses Fumadocs’ default search and hides Inkeep-specific UI ([`provider.tsx`](src/app/provider.tsx), [`layout.tsx`](src/app/layout.tsx), [`page-actions.tsx`](src/components/page-actions.tsx)).

> **Prebuild note:** `npm run prebuild` runs `tsx` outside Next.js, so **`DOCS_OG_*`** and **`SKIP_OG_BUILD`** are not read from `.env.local` unless you export them in your shell or set them in CI.

## Monorepo packages (`packages/`)

| Package | Role |
|--------|------|
| `@tether/docs-seo-schema` | Zod `tetherSeoFrontmatterSchema`: **required** `description`; optional `noIndex`, `ogImage`, `schemaType`, `docType`, `lastModified`. Exports `warnMissingSeoFrontmatterFields`, `DOCS_SEO_WARN_PREFIX`. |
| `@tether/docs-seo-core` | `getPageSeoState` (canonical, `ogImage` override, `PageSeoState` with `slugs` / `seoAuditFields`), `buildJsonLdGraph`, `inferJsonLdType`. Root-relative **`ogImage`** paths are turned into absolute URLs **without** applying doc `trailingSlash` (so `/asset.png` does not become `/asset.png/`). |
| `@tether/docs-seo-next` | `buildDocsMetadata`, `buildDocsSitemap`, `buildDocsRobots`, `DocsJsonLd`; re-exports core/schema SEO helpers. |
| `@tether/docs-seo-og` | `getPageImage` (URL layout), Takumi **prebuild** (`@tether/docs-seo-og/build`), optional Route Handler (`@tether/docs-seo-og/handler`); re-exports `warnMissingSeoFrontmatterFields`. |

The main app must **not** import `@tether/docs-seo-og/handler` in pages that ship to the static bundle; Takumi is only used at **prebuild** time or in a server Route Handler.

### Using these packages from another repository

**Current approach (Git):** install the packages from this repo’s `packages/` subpaths. Packages depend on each other with version **`0.0.0`** (workspace-style), which **does not exist on the public registry**, so the consuming app should use **`overrides`** (npm) so every `@tether/docs-*` install resolves to the same Git source.

1. In the consumer’s `package.json`, declare what you need and override all four scopes to matching URLs (same org, repo, and ref for every line):

```json
{
  "dependencies": {
    "@tether/docs-seo-next": "github:tetherto/docs-template#path:packages/docs-seo-next",
    "@tether/docs-seo-og": "github:tetherto/docs-template#path:packages/docs-seo-og",
    "@tether/docs-seo-schema": "github:tetherto/docs-template#path:packages/docs-seo-schema"
  },
  "overrides": {
    "@tether/docs-seo-schema": "github:tetherto/docs-template#path:packages/docs-seo-schema",
    "@tether/docs-seo-core": "github:tetherto/docs-template#path:packages/docs-seo-core",
    "@tether/docs-seo-next": "github:tetherto/docs-template#path:packages/docs-seo-next",
    "@tether/docs-seo-og": "github:tetherto/docs-template#path:packages/docs-seo-og"
  }
}
```

To pin a **branch or tag**, use npm’s `commit-ish` form before `path`, for example: `github:tetherto/docs-template#main:path:packages/docs-seo-core` (see [npm: git URLs as dependencies](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#github-urls)). For reproducible builds, prefer a **release tag** or **commit SHA** once you tag this repo.

2. In **Next.js**, set `transpilePackages` to include every `@tether/docs-*` package you import (sources are TypeScript).

3. Install **peer dependencies** (`fumadocs-core`, `next`, `react`, `zod` for schema, etc.) to versions compatible with each package’s `peerDependencies`.

4. For **private GitHub** repos, use SSH or a token URL npm supports (e.g. `git+ssh://git@github.com/tetherto/docs-template.git#path:packages/docs-seo-next`) and ensure CI has credentials.

**Future approach (private registry):** publish `@tether/docs-seo-*` to your org’s npm/GitHub Packages scope, remove **`"private": true`**, replace internal **`0.0.0`** dependencies with real **semver** ranges, and drop **`overrides`** in consumers in favor of normal `npm install @tether/docs-seo-next@^x`.

## SEO and frontmatter

Extended fields are merged in [`source.config.ts`](source.config.ts) via `tetherSeoFrontmatterSchema`. **`description`** is **required** (non-empty after trim) on every docs page for meta tags, Open Graph / Twitter, and JSON-LD. Other fields are optional:

- **`noIndex`** (boolean): exclude from sitemap and set `robots` to noindex.
- **`ogImage`** (string): absolute URL or site-relative path override for Open Graph / Twitter images (relative paths are normalized as static assets, not doc routes—no stray trailing slash before the file extension).
- **`schemaType`**: `TechArticle` \| `APIReference` \| `WebPage` for JSON-LD `@type`.
- **`docType`**: `tutorial` \| `how-to` \| `reference` \| `explanation` \| `page` \| `faq` \| `getting-started` (influences inferred JSON-LD when `schemaType` is omitted).
- **`lastModified`**: string or date for sitemap `lastmod` and, when set, JSON-LD `datePublished` / `dateModified` on **`WebPage`**, **`TechArticle`**, and **`APIReference`** graphs.

Per-page metadata, sitemap, robots, and JSON-LD share the same logic through [`src/lib/seo-config.ts`](src/lib/seo-config.ts) and `@tether/docs-seo-next`.

During `next build` / dev, `getPageSeoState` and `buildDocsMetadata` emit **`[@tether/docs-seo]`** `console.warn` lines for missing optional fields (`ogImage`, `schemaType`, `docType`, `lastModified`, and empty `description` if it bypasses MDX validation). Warnings are deduped per page per Node process. Set **`DOCS_SEO_SILENT=1`** to turn them off. The same helpers are re-exported from `@tether/docs-seo-schema`, `@tether/docs-seo-core`, `@tether/docs-seo-next`, and `@tether/docs-seo-og` (`warnMissingSeoFrontmatterFields`).

## Environment variables

Full template with comments: [`env.example`](env.example).

| Variable | Required | Purpose |
|----------|----------|---------|
| `NEXT_PUBLIC_DOCS_ORIGIN` | **Yes** (production) | Site origin for `metadataBase`, canonicals, and absolute `og:image` / Twitter URLs. Defaults to `http://localhost:3001` when unset. |
| `NEXT_PUBLIC_INKEEP_API_KEY` | No | Inkeep CXKit API key. If set, replaces Fumadocs default search with Inkeep and enables the Inkeep chat widget; if unset, default Fumadocs search is used. |
| `NEXT_PUBLIC_DOCS_PUBLISHER_LOGO_URL` | No | HTTPS logo for JSON-LD publisher / `Organization`. |
| `SKIP_OG_BUILD` | No | Set to `1` to use static OG fallback instead of per-page `public/og/docs/**` URLs in metadata. |
| `DOCS_OG_SITE_LABEL` | No | Takumi `site` label during OG prebuild (default `Tether`). |
| `DOCS_OG_CONCURRENCY` | No | Parallelism for OG prebuild (default `3`). |
| `DOCS_SEO_SILENT` | No | Set to `1` to disable `[@tether/docs-seo]` console warnings for missing optional frontmatter (`ogImage`, `schemaType`, `docType`, `lastModified`). |

## Open Graph images (Takumi, static hosting)

Because static export cannot use dynamic OG Route Handlers, images are **generated before `next build`** and written under `public/og/docs/.../image.webp`, matching the URLs returned by `getPageImage()`.

- **`npm run build`** and **`npm run build:static`** automatically run **`prebuild`**, which executes `tsx scripts/generate-takumi-og.mts`.
- Run the generator alone: **`npm run build:og`**.
- Replace [`public/og-default.png`](public/og-default.png) with a proper **1200×630** asset if you rely on the `SKIP_OG_BUILD` fallback.

**Git:** This template **gitignores** `public/og/docs/` (see [`.gitignore`](.gitignore)). CI and local **`npm run build`** must run **`prebuild`** so those WebP files exist before static export. To vendor generated images instead, stop ignoring that directory and commit the files.

## Development

Check broken links:

```bash
npm run check-links
```

Dev server (port 3001):

```bash
npm run dev
```

For local dev without generating OG files, you can use:

```bash
SKIP_OG_BUILD=1 npm run dev
```

## Build

Set **`NEXT_PUBLIC_DOCS_ORIGIN`** for production; add **`NEXT_PUBLIC_INKEEP_API_KEY`** only if you use Inkeep instead of default Fumadocs search (see [`env.example`](env.example)).

Static export:

```bash
npm run build
```

or:

```bash
npm run build:static
```

Next.js writes the static site to the **`out/`** directory (not `dist/`).

Serve the export locally after `npm run build`:

```bash
npm run serve
```

This serves the **`out/`** directory (Next.js static export output).

## Repository layout

- `src`: Next.js app and UI.
- `content/docs`: MDX documentation content.
- `packages`: workspace packages (`@tether/docs-seo-*`).
- `public`: static assets; **`public/og/docs/**`** holds prebuilt OG WebP files after `prebuild`.
- `examples`: runnable DOCS code samples for snippets and tooling.
- `scripts`: automation (including [`scripts/generate-takumi-og.mts`](scripts/generate-takumi-og.mts)).
- [`env.example`](env.example): environment variable template (SEO required for prod; Inkeep optional).
- [`REVIEW-CHECKLIST.md`](REVIEW-CHECKLIST.md): optional manual QA checklist for SEO / static export (stage it if you want it in the repo).
- **`.source/`** (gitignored, not in git): Fumadocs MDX output; created by **`npm install`** / **`npm run postinstall`**. Regenerate after changing [`source.config.ts`](source.config.ts).

> [!NOTE]
> Repository structure may evolve as automation and content organization mature.

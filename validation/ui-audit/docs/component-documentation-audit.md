<!-- MDK-MAINTAINERS-ONLY — do not publish -->

# Component documentation audit

DevOps prefers no leak of local paths, so local audit config files remain gitignored.

The canonical audit lives at [`../../qa/audit-demo-app-local/`](../../qa/audit-demo-app-local/). It reframes around the two questions that drive `src/data/current/components.json` triage:

1. What needs adding to `components.json`? -> `missingNeedsDocs[]`
2. What needs removing from `components.json`? -> `stale[]`

Both fall out of a list A / list B model (list A = public API surface; list B = demo app surface):

- List A (public API surface): every PascalCase component reachable from the public package barrels (`packages/<pkg>/src/index.ts`), including non-barrel internals encountered when walking each barrel source's relative imports (prefers `*.public-surface.json` under ui-client when present).
- List B (demo app surface): the subset of A that is value-imported anywhere in the demo's relative-import tree, or rendered transitively when a directly imported parent's source tree is followed up to `MDK_AUDIT_TRANSITIVE_DEPTH=4` hops (default; saturates current MDK chains).
- `missingNeedsDocs[]` = B \ `components.json` \ `dont-document-components.json`. Direct entries (`kind: "direct"`) are public-API holes. Transitive entries (`kind: "transitive"`) carry a `chain: [...]` for triage: promote the internal to docs, lift the parent's docs to cover it, or move to `dont-document-components.json`.
- `stale[]` = `components.json` \ B. The strongest stale signal is `inPublicBarrel: false` (docs advertise an import that does not exist in the package barrel).

Plus three orthogonal per-leaf checks (recipe + props applied only to `leaves[]` rows that match a `components.json` row):

1. Catalog presence: is there a row in `src/data/current/components.json` for this leaf?
2. Import recipe: does the demo's actual `import { ... } from '@tetherto/mdk-*-ui'` agree with what docs say to import? Are companion components (for example `Toaster` next to `Toast`) mentioned on the doc page?
3. Props completeness: every prop in the component's source-side `Props` type should be mentioned on the doc page.

`documented: true/false` in `leaves[]` tracks only layer 1. It is `true` iff a row exists in `src/data/current/components.json`. Layers 2 and 3 are independent and can still fail.

`dont-document-components.json` is read by the audit and enforces `missingNeedsDocs[]` exclusion. First-run noise is expected (icons, providers, internal Form/Radix primitives reached by depth-4 BFS). Bulk-add denylist entries to settle into a steady-state report.

- Local (`npm run audit:demo`): gitignored [`../../qa/audit-demo-app-local/audit.config-local.example.yaml`](../../qa/audit-demo-app-local/audit.config-local.example.yaml) with explicit `docsSiteRoot`, `docsBranch`, `sources.*.localPathToRepo`, `sources.*.branch`.
- CI (`npm run audit:demo:ci` / `CI=true`): [`../../qa/audit-demo-app-local/audit.config.yaml`](../../qa/audit-demo-app-local/audit.config.yaml) only (GitHub identity, no machine paths on PRs).
- Set `defaultSource` / `MDK_AUDIT_SOURCE` in active yaml for `public` vs `private`.
- Outputs (`components-audit.json`, `undocumented-by-section.md`) translate local paths into GitHub URLs so PR diffs do not expose working directories.

Hooks are audited separately. Run `npm run audit:hooks` (see [`../../qa/audit-hooks-local/README.md`](../../qa/audit-hooks-local/README.md)) against `src/data/current/hooks.json` and hook MDX under `content/docs/reference/app-toolkit/hooks/`.

Framework-agnostic utilities from `@tetherto/mdk-ui-core` have their own lane: `npm run audit:ui-core` (see [`../../qa/audit-ui-core-local/README.md`](../../qa/audit-ui-core-local/README.md)) walks `packages/ui-core/src/utils/` against `src/data/current/utilities.json` / `dont-document-utilities.json`.

See [`../../qa/audit-demo-app-local/README.md`](../../qa/audit-demo-app-local/README.md) for full env var reference, JSON schema, triage queries, and known caveats. GitHub Actions for drift and PR audit gates are parked under [`../../qa/audit-demo-app-ci/`](../../qa/audit-demo-app-ci/).

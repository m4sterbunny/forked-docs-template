# Package Rename Audit

**Status: COMPLETED** - All renames applied on branch `msdk-426-package-rename-sweep`

## Summary

| Retired Term | Canonical Term | Files Updated |
|--------------|----------------|---------------|
| `mdk-ui-core` | `mdk-ui-foundation` | 17 files |
| `UI Core` | `UI Foundation` | 5 files |
| `UI Kit` / `ui-kit` | `UI Devkit` / `ui-devkit` | ~35 files |
| `ORK` | `Kernel` | 13 files |
| `App Node` | `Gateway` | 14 files |

## Changes Made

### Folder Renames
- `reference/app-toolkit/ui-core/` → `reference/app-toolkit/ui-foundation/`
- `reference/app-toolkit/ui-kit/` → `reference/app-toolkit/ui-devkit/`
- `reference/ork/` → `reference/kernel/`
- `guides/ui/use-ui-core-headlessly.mdx` → `guides/ui/use-ui-foundation-headlessly.mdx`
- `public/images/ui-kit/` → `public/images/ui-devkit/`

### Redirects Added
All old paths redirect to new paths via `redirects.config.mjs`:
- `/reference/app-toolkit/ui-core` → `/reference/app-toolkit/ui-foundation`
- `/reference/app-toolkit/ui-kit/*` → `/reference/app-toolkit/ui-devkit/*`
- `/guides/ui/use-ui-core-headlessly` → `/guides/ui/use-ui-foundation-headlessly`
- `/reference/ork/*` → `/reference/kernel/*`

### Code References Preserved
The following code elements were intentionally NOT changed as they reflect actual software:
- `getOrk()` function name
- `ork.sock` socket file path
- `{ ork }` variable references in code examples

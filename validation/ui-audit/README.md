# UI Audit - Standalone Validation Tool

Standalone coverage testing and audit system for UI documentation. This tool validates that UI components, hooks, and utilities are properly documented across multiple repositories.

## Purpose

The UI audit serves as a **backup coverage test** separate from the main docs automation pipeline. It can run against:

- **mdk-docs** - Documentation site to verify coverage
- **mdk-prv** / **mdk-ui** - Source code repositories to verify public API surface

This tool was extracted from mdk-docs (MSDK-474) to make it independent and reusable.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure

Copy the example config and update paths:

```bash
cp ui-audit.config.example.yaml ui-audit.config.yaml
# Edit ui-audit.config.yaml with your local repository paths
```

The config file specifies:
- Target repositories to audit (mdk-docs, mdk-prv, etc.)
- Which audit lanes to enable (components, hooks, utilities)
- Source paths for each lane
- Notification and reporting settings

### 3. Run Audits

```bash
# Run all enabled audits
npm run audit

# Run individual audit lanes
npm run audit:demo      # Component audit
npm run audit:hooks     # Hooks audit
npm run audit:ui-core   # Utilities audit

# Run verification and classification
npm run verify          # Verify audit structure
npm run classify        # Classify issues by severity
```

## Audit Lanes

### 1. Demo App (Components)

Audits component documentation by comparing:
- **List A**: Public API surface from source code
- **List B**: Demo app component usage
- **List C**: Documentation catalog (`components.json`)

**Check**: `checks/demo-app/audit.mjs`

### 2. Hooks

Audits React hooks documentation coverage.

**Check**: `checks/hooks/audit.mjs`

### 3. UI Core (Utilities)

Audits utility functions and core UI helpers.

**Check**: `checks/ui-core/audit.mjs`

## Configuration

### Multi-Repo Targets

The YAML config supports multiple target repositories:

```yaml
targets:
  - name: mdk-docs
    path: /path/to/mdk-docs
    branch: staging
    type: docs
    enabled: true
    
  - name: mdk-prv
    path: /path/to/fork-mdk-prv
    branch: main
    type: source
    enabled: true
```

**Note**: The `branch` field is documentation only. You must checkout the desired branch before running the audit.

### Audit Configuration

Each audit lane has its own configuration:

```yaml
audit:
  demo_app:
    enabled: true
    catalog: catalogs/components.json
    dont_document: catalogs/dont-document-components.json
    sources:
      private:
        localPathToRepo: /path/to/fork-mdk-ui
        branch: develop
```

## Directory Structure

```
ui-audit/
├── README.md                           # This file
├── package.json                        # Dependencies and scripts
├── ui-audit.config.example.yaml        # Config template
├── ui-audit.config.yaml                # Your local config (git-ignored)
├── run-audit.mjs                       # Main orchestrator
├── checks/                             # Audit lane implementations
│   ├── demo-app/
│   │   ├── audit.mjs
│   │   └── classify-public-api-kind.mjs
│   ├── hooks/
│   │   └── audit.mjs
│   └── ui-core/
│       └── audit.mjs
├── scripts/                            # Supporting scripts
│   ├── classify-audit.ts               # Severity classification
│   ├── verify-audit-run.ts             # Structural validation
│   ├── notify-audit.ts                 # Slack/GitHub notifications
│   └── run-audit-verifier-local.sh     # Local test battery
├── tests/                              # Test suite
│   └── classify-audit.test.ts
├── catalogs/                           # Reference data
│   ├── components.json                 # Documented components
│   ├── hooks.json                      # Documented hooks
│   ├── utilities.json                  # Documented utilities
│   └── dont-document-*.json            # Exclusion lists
├── ci-examples/                        # CI workflow templates
│   ├── README.md
│   ├── audit-drift.yml
│   ├── audit-drift-smoke.yml
│   └── audit-cron-health.yml
└── docs/                               # Maintainer documentation
    ├── component-documentation-audit.md
    └── audit-architecture.md
```

## CI Integration

See `ci-examples/` for GitHub Actions workflow templates. These can be adapted for:

- Nightly drift detection
- PR smoke tests
- Coverage health monitoring

## Relationship to Main Docs Pipeline

**mdk-docs** now relies on the **UI autodocs process** (MSDK-433) for primary documentation:

- `npm run process:ui-manifests` - Generates docs from source manifests
- Coverage is built into the processor
- Metadata-driven enrichment and categorization

This **UI audit tool** serves as:
- Independent assurance / backup coverage test
- Historical validation against legacy catalogs
- Multi-repo validation capability
- External quality gate that doesn't block docs builds

## Development

### Running Tests

```bash
npm test
```

### Adding a New Audit Lane

1. Create directory under `checks/`
2. Implement `audit.mjs` with standard interface
3. Add catalog JSON to `catalogs/`
4. Update config to enable the lane
5. Add npm script to `package.json`

## Migration Note

This tool was extracted from `mdk-docs` in MSDK-474 (Sunset Audit). The original audit system lived in:

- `mdk-docs/qa/audit-*-local/`
- `mdk-docs/src/data/current/`
- `mdk-docs/scripts/`

All audit logic, catalogs, and supporting scripts have been moved here to create a standalone validation tool that can run against any repo.

## Troubleshooting

### Config not found

Make sure you've copied the example config:
```bash
cp ui-audit.config.example.yaml ui-audit.config.yaml
```

### Path errors

All paths in the config must be absolute. Relative paths are not supported.

### Branch mismatch

The audit doesn't checkout branches for you. Make sure all target repos are on the correct branch before running.

### Missing dependencies

Run `npm install` in this directory (ui-audit/) to install all required dependencies.

## Related Documentation

- `docs/component-documentation-audit.md` - Detailed audit model and methodology
- `docs/audit-architecture.md` - System architecture and design decisions
- `ci-examples/README.md` - CI integration guide

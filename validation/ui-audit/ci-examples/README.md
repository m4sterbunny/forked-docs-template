# CI Integration Examples

This directory contains example GitHub Actions workflows for integrating the UI audit into CI/CD pipelines.

## Workflow Templates

### audit-drift.yml

Nightly drift detection workflow that:
- Runs against latest develop/main branches
- Compares against baseline results
- Detects documentation drift over time
- Posts notifications on regressions

**Schedule**: Daily at 2 AM UTC (configurable)

**Usage**:
1. Copy to `.github/workflows/audit-drift.yml` in your repo
2. Update paths and branch names
3. Configure notification settings
4. Set up baseline comparison if desired

### audit-drift-smoke.yml

Lightweight smoke test for PR validation:
- Runs on pull request events
- Quick validation (no full audit)
- Checks for obvious regressions
- Fast feedback (<5 minutes)

**Triggers**: Pull request open/update

**Usage**:
1. Copy to `.github/workflows/audit-drift-smoke.yml`
2. Update repo paths
3. Adjust smoke test criteria
4. Configure PR comment notifications

### audit-cron-health.yml

Watchdog workflow for monitoring audit system health:
- Verifies audit runs are completing successfully
- Monitors for persistent failures
- Alerts on audit system issues
- Runs independently of actual audits

**Schedule**: Every 6 hours (configurable)

**Usage**:
1. Copy to `.github/workflows/audit-cron-health.yml`
2. Configure health check thresholds
3. Set up alerting channels
4. Define acceptable failure rates

## Configuration Requirements

All workflows require:

### Repository Secrets

```yaml
# Slack notifications (optional)
SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}

# GitHub token (automatic)
GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Workflow Permissions

```yaml
permissions:
  contents: read       # Read repo contents
  pull-requests: write # Comment on PRs (smoke test)
  actions: read        # Read workflow status (health check)
```

### Environment Variables

Update these in each workflow:

```yaml
env:
  DOCS_REPO_PATH: /path/to/mdk-docs
  SOURCE_REPO_PATH: /path/to/fork-mdk-prv
  DOCS_BRANCH: staging
  SOURCE_BRANCH: main
```

## Adapting for Your Repository

### Step 1: Choose Workflows

Decide which workflows you need:
- **Drift detection**: Full nightly audit
- **PR smoke test**: Quick PR validation
- **Health monitoring**: Watchdog for audit failures

### Step 2: Update Paths

Replace placeholder paths:
- Docs repository location
- Source code repository location
- Config file paths
- Output directories

### Step 3: Configure Branches

Set target branches:
- Docs branch (usually `staging` or `main`)
- Source branch (usually `develop` or `main`)
- Feature branch patterns for PRs

### Step 4: Set Up Notifications

Configure notification channels:
- Slack webhooks
- GitHub PR comments
- Email alerts (if configured)

### Step 5: Baseline Management

For drift detection:
1. Run initial audit to generate baseline
2. Commit baseline to repo or store as artifact
3. Update workflow to compare against baseline
4. Periodically update baseline for new features

## Integration with ui-audit

These workflows call the ui-audit tool:

```yaml
- name: Run UI Audit
  run: |
    cd /path/to/validation/ui-audit
    npm install
    npm run audit
```

Make sure the ui-audit tool is:
- Installed with dependencies
- Configured with proper paths
- Accessible from the workflow

## Best Practices

### Caching

Add caching for faster runs:

```yaml
- uses: actions/cache@v3
  with:
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
```

### Artifacts

Save audit results as artifacts:

```yaml
- uses: actions/upload-artifact@v3
  with:
    name: audit-results
    path: validation/ui-audit/results/
```

### Conditional Execution

Skip audits for certain changes:

```yaml
- name: Check if audit needed
  run: |
    if git diff --name-only HEAD~1 | grep -qE '(components|hooks|utilities)'; then
      echo "RUN_AUDIT=true" >> $GITHUB_ENV
    fi
```

### Parallel Execution

Run audit lanes in parallel:

```yaml
strategy:
  matrix:
    audit-lane: [demo-app, hooks, ui-core]
steps:
  - run: npm run audit:${{ matrix.audit-lane }}
```

## Troubleshooting

### Workflow fails with path errors

Ensure all paths are absolute and accessible from the runner environment.

### Long execution times

- Enable caching for dependencies
- Use smoke tests for PR validation
- Run full audits only on schedule

### Notification failures

Check:
- Webhook URLs are valid
- Secrets are properly configured
- Notification service is accessible

### Baseline drift

Update baseline after:
- Major feature releases
- Intentional documentation changes
- API surface updates

## Migration from mdk-docs

These workflows were previously in `mdk-docs/qa/audit-demo-app-ci/github-actions/`.

Key changes in the standalone version:
- Removed mdk-docs-specific paths
- Generalized for multi-repo support
- Added configuration via YAML
- Independent of docs build process

## Related Documentation

- `../README.md` - Main ui-audit documentation
- `../docs/audit-architecture.md` - System architecture
- `../docs/component-documentation-audit.md` - Audit methodology

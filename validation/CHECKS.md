# Validation Checks Reference

Quick reference for all available checks.

## Priority Levels

🔥 **HIGH** - Critical issues that break production or expose sensitive info  
⚠️ **MEDIUM** - Quality issues that confuse users or reduce maintainability  
ℹ️ **LOW** - Style/consistency improvements

---

## 1. no-debug-instrumentation 🔥 HIGH

**What:** Prevents Cursor debug mode instrumentation from shipping to production.

**Catches:**
- `fetch('http://127.0.0.1:...')`
- `X-Debug-Session-Id` headers
- Debug session payloads

**Impact:** Causes failed requests, browser permission prompts, console errors on live site.

**Run:**
```bash
node checks/no-debug-instrumentation.mjs /path/to/repo
```

---

## 2. docs-deprecated-apis 🔥 HIGH

**What:** Flags deprecated API usage in docs by parsing CHANGELOG.md automatically.

**Catches:**
- Old function names (e.g., `startAppNode` → `startGateway`)
- Deprecated packages (e.g., `@tetherto/mdk-ork`)
- Renamed classes (e.g., `ORKManager` → `KernelManager`)

**Impact:** Users follow outdated docs and get import/runtime errors.

**Configuration:** Requires `source_repo.path` in `config.yaml` pointing to repo with CHANGELOG.

**Run:**
```bash
node checks/docs-deprecated-apis.mjs /path/to/docs-repo
```

**Data:**
- Found 59 deprecated functions
- Found 4 deprecated packages
- Found 22 deprecated classes
- All extracted automatically from real changelogs

---

## 3. no-personal-paths 🔥 HIGH

**What:** Prevents personal filesystem paths from being committed.

**Catches:**
- `/Users/username/...` (macOS)
- `/home/username/...` (Linux)
- `C:\Users\username\...` (Windows)

**Impact:** 
- Exposes usernames
- Breaks portability
- Looks unprofessional

**Fix:** Use relative paths (`cd validation`), placeholders (`/path/to/repo`), or env vars (`$HOME`).

**Exclusions:**
- Test fixtures
- Code comments
- Config files with "Update this" instructions

**Run:**
```bash
node checks/no-personal-paths.mjs /path/to/repo
```

---

## 4. docs-stale-references ⚠️ MEDIUM

**What:** Finds function/class names in docs that don't exist in source code.

**Catches:**
- Functions mentioned but not defined
- Classes referenced but not exported
- Renamed APIs still documented

**Impact:** Users try to import non-existent code.

**Configuration:** Requires `source_repo.path` in `config.yaml`.

**Status:** Framework complete, needs tuning for production use.

**Run:**
```bash
node checks/docs-stale-references.mjs /path/to/docs-repo
```

---

## 5. changelog-outcome-vs-narration (STANDALONE) 🔥 HIGH

**What:** Validates CHANGELOG documents version outcomes, not sprint narration.

**Catches:**
- Items listed as "Removed" but never existed in previous version
- Features added and removed within same release cycle
- Sprint-level churn documented as version changes

**Impact:** Changelog narrates development process instead of documenting actual version-to-version changes.

**Standalone:** Uses `changelog-validation.config.yaml`, NOT included in `run-all.mjs`.

Enforced by `export const standalone = true` in the check, which `loadChecks()` filters out. Two reasons it sits outside the runner:

- **Different signature** — it takes a config object (repo path *plus* archive path), not the runner's single target-path string.
- **Different trigger** — it only means anything when the current `## vX.Y.Z` section of `CHANGELOG.md` changes. That's a release event, not a per-PR one.

**Setup:**
```bash
cp changelog-validation.config.example.yaml changelog-validation.config.yaml
# Edit with repo path and branch
```

**Run:**
```bash
npm run validate:changelog
# or: node checks/changelog-outcome-vs-narration.mjs
```

**CI:** see `ci-examples/changelog-validation.yml` — triggers on `CHANGELOG.md` / archive paths only.

**⚠️ Advisory, not blocking.** The check verifies each removal against prior changelog *prose*, so anything that shipped without an explicit `Added` entry is flagged even when the removal is correct. On MDK 0.6.0 all four findings were false positives — every item existed at the `v0.5.0` tag. Verify before acting:

```bash
git ls-tree -d --name-only v<prev>:<path>   # directories
git show v<prev>:<file>                     # scripts, package.json entries
```

An item present at the previous tag is a false positive. Fixing this properly means checking the git tag instead of the archive text.

**Known coverage gap:** items are only extracted from a `## Removed` bullet via **bold spans** or a **`@scope/package` code span**. A bullet written in plain prose yields nothing — MDK 0.6.0's largest removal ("The Gateway's entire built-in HTTP API surface") is not checked at all.

**Example:** If `microbt` worker was added on sprint day 2 and removed by day 8, it should NOT appear in the v0.6.0 changelog at all - the final state (v0.5.0 → v0.6.0) never included it.

---

## Running All Checks

```bash
cd validation
node run-all.mjs /path/to/target-repo
```

Exits with code 1 if any check fails.

---

## Adding New Checks

Create `checks/my-check.mjs`:

```javascript
#!/usr/bin/env node
export const checkName = 'my-check';

export async function run(targetPath) {
  // Your validation logic
  return {
    passed: true,  // or false
    violations: []  // or list of issues
  };
}

// CLI support
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await run(process.argv[2] || process.cwd());
  if (result.passed) {
    console.log('✅ Passed');
    process.exit(0);
  } else {
    console.error('❌ Failed');
    process.exit(1);
  }
}
```

The runner auto-discovers all `.mjs` files in `checks/`.

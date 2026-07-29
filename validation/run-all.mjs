#!/usr/bin/env node

/**
 * PR Validation Runner
 * 
 * Runs all validation checks against a target repository.
 * Can be run against:
 * - Local branch
 * - Local uncommitted changes
 * - Remote PR (by fetching and checking out)
 */

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const checksDir = join(__dirname, 'checks');

async function loadChecks() {
  const files = readdirSync(checksDir).filter(f => f.endsWith('.mjs'));
  const checks = [];
  const standalone = [];

  for (const file of files) {
    const module = await import(join(checksDir, file));
    const name = module.checkName || file.replace('.mjs', '');

    // Checks marked standalone take their own config rather than this runner's
    // target path, and run on their own trigger. See CHECKS.md.
    if (module.standalone) {
      standalone.push({ name, command: module.standaloneCommand });
      continue;
    }

    checks.push({ name, run: module.run, file });
  }

  return { checks, standalone };
}

async function runAllChecks(targetPath) {
  const { checks, standalone } = await loadChecks();
  const results = [];

  console.log(`Running ${checks.length} validation check(s) on: ${targetPath}\n`);

  for (const check of standalone) {
    console.log(`⏭️  Not in this run (standalone): ${check.name}`);
    if (check.command) {
      console.log(`    Run separately: ${check.command}`);
    }
    console.log('');
  }

  for (const check of checks) {
    console.log(`🔍 Running: ${check.name}`);
    const result = await check.run(targetPath);
    results.push({ name: check.name, ...result });

    // Three states, not two. A skipped check reached no verdict — reporting it
    // as a pass is how an unconfigured suite goes green without reading a file.
    if (result.skipped) {
      console.log(`  ⚠️  Skipped — ${result.reason || 'no reason given'}\n`);
    } else if (result.passed) {
      console.log(`  ✅ Passed\n`);
    } else {
      console.log(`  ❌ Failed\n`);
    }
  }

  return results;
}

// Checks don't share one violation shape, and each one's own CLI output is
// tailored to its own shape. Rather than force a single schema on all of them,
// render whichever of the three known layouts a violation uses:
//
//   grouped   {pattern, matches:[{file, location}]}   no-debug-instrumentation
//   per-file  {file, violations:[{...}]}              no-personal-paths, docs-deprecated-apis
//   flat      {file, reference, issue} etc.           docs-stale-references
//
// Anything unrecognised falls back to JSON so a new check is never silently
// reported as "failed" with no detail.
function describeItem(item) {
  if (typeof item === 'string') return item;

  const where = item.line ? `L${item.line}` : item.location || null;
  const what =
    item.path ||
    item.term ||
    item.reference ||
    item.item ||
    item.name ||
    null;
  const why = item.issue || item.type || item.username || null;

  const head = [where, what].filter(Boolean).join(': ');
  const parts = [head || null, why && head ? `(${why})` : why].filter(Boolean);

  if (parts.length === 0) return JSON.stringify(item);

  let out = parts.join(' ');
  if (item.context) out += `\n          ${item.context}`;
  return out;
}

function printViolation(violation, indent = '    ') {
  if (typeof violation === 'string') {
    console.error(`${indent}${violation}`);
    return;
  }

  const children = Array.isArray(violation.matches)
    ? violation.matches
    : Array.isArray(violation.violations)
      ? violation.violations
      : null;

  if (children) {
    const header = violation.pattern || violation.file || 'violations';
    console.error(`${indent}${header}`);
    for (const child of children) {
      // Grouped matches carry their own file; per-file groups already named it.
      const prefix = child.file && !violation.file ? `${child.file}: ` : '';
      console.error(`${indent}  ${prefix}${describeItem(child)}`);
    }
    return;
  }

  const file = violation.file ? `${violation.file} ` : '';
  console.error(`${indent}${file}${describeItem(violation)}`);
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  // Skips warn by default. --strict escalates them to failures, for pipelines
  // that require every check to be configured and actually run.
  const strict = args.includes('--strict');
  const targetPath = args.find(a => !a.startsWith('--')) || process.cwd();

  const results = await runAllChecks(targetPath);

  const skipped = results.filter(r => r.skipped);
  const failed = results.filter(r => !r.skipped && !r.passed);
  const ran = results.length - skipped.length;

  if (skipped.length > 0) {
    console.error(`⚠️  ${skipped.length} of ${results.length} check(s) did not run:\n`);
    for (const result of skipped) {
      console.error(`  ${result.name}`);
      console.error(`    ${result.reason || 'no reason given'}`);
    }
    console.error(
      strict
        ? '\n   --strict: counting these as failures.\n'
        : '\n   These reached no verdict — a skip is not a pass. Re-run with --strict to fail on them.\n'
    );
  }

  if (failed.length === 0 && !(strict && skipped.length > 0)) {
    console.log(`✅ ${ran} check(s) passed${skipped.length ? `, ${skipped.length} skipped` : ''}`);
    process.exit(0);
  }

  if (failed.length === 0) {
    // strict mode, skips only — nothing to render below.
    console.error(`❌ ${skipped.length} check(s) skipped under --strict`);
    process.exit(1);
  }

  // Reporting must never decide the exit code. A throw in here used to kill the
  // process before process.exit(1) ran, turning a failing run into exit 0.
  try {
    console.error(`\n❌ ${failed.length} check(s) failed:\n`);
    for (const result of failed) {
      const count = Array.isArray(result.violations) ? result.violations.length : 0;
      console.error(`  ${result.name}${count ? ` (${count})` : ''}`);

      if (result.reason) {
        console.error(`    ${result.reason}`);
      }
      for (const violation of result.violations || []) {
        printViolation(violation);
      }
      console.error('');
    }
  } catch (err) {
    console.error(`\n⚠️  Failed to render violations: ${err.message}`);
    console.error('   The checks above still failed. Run them individually for detail.');
  }

  process.exit(1);
}

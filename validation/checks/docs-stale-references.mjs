#!/usr/bin/env node

/**
 * Check: Stale Function/Class References
 * 
 * Finds function and class names mentioned in docs that don't exist in the source code.
 * Extracts identifiers from:
 * - Inline code: `functionName()`
 * - Code blocks: function calls, class instantiations
 * - Links: [text](url) containing code references
 * 
 * Then validates against actual source code to catch renames/deletions.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, '..', 'config.yaml');
const exampleConfigPath = join(__dirname, '..', 'config.example.yaml');

export const checkName = 'docs-stale-references';

function loadConfig() {
  if (!existsSync(configPath)) {
    if (existsSync(exampleConfigPath)) {
      console.warn('\n⚠️  config.yaml not found. Copy config.example.yaml to config.yaml and update paths.\n');
    }
    return null;
  }
  return yaml.load(readFileSync(configPath, 'utf-8'));
}

function extractCodeReferences(content) {
  const refs = new Set();
  
  // Match `code` spans
  const inlineCode = content.matchAll(/`([a-zA-Z_][a-zA-Z0-9_]*(?:\(\))?)`/g);
  for (const match of inlineCode) {
    const ref = match[1].replace(/\(\)$/, ''); // Remove trailing ()
    if (ref.length > 2 && /^[A-Z]/.test(ref) || ref.includes('start') || ref.includes('boot')) {
      refs.add(ref);
    }
  }
  
  // Match function calls in text: word()
  const functionCalls = content.matchAll(/\b([a-z][a-zA-Z0-9_]*)\(\)/g);
  for (const match of functionCalls) {
    refs.add(match[1]);
  }
  
  // Match PascalCase (likely classes/types)
  const pascalCase = content.matchAll(/\b([A-Z][a-zA-Z0-9_]{2,})\b/g);
  for (const match of functionCalls) {
    if (!match[1].match(/^(HTTP|API|JSON|XML|URL|MDK|MCP|TCP|REST|MQTT)/)) {
      refs.add(match[1]);
    }
  }
  
  return Array.from(refs);
}

const SKIP_DIRS = new Set([
  '.git', '.next', 'out', 'dist', 'build', '.cursor', '.claude',
  // Historical-record dirs: old identifiers there are expected and not a doc bug.
  'changelog-archive', 'release-notes'
]);

// Root-level historical-record files, same reasoning as SKIP_DIRS above.
const SKIP_FILES = new Set(['CHANGELOG.md', 'checklist.md']);

// Own-published packages (e.g. installed as workspace deps under node_modules/@tetherto)
// are worth checking; unrelated third-party dependencies are not, so node_modules is
// pruned everywhere except that scope. A workspace repo installs the same
// package under many node_modules/@tetherto copies (once per consuming
// sub-package/example) — searching every copy multiplies grep cost for no
// benefit, so only the first copy of each uniquely-named package is kept.
function collectScopedPackageDirs(root, scope) {
  const found = [];
  const seenPackages = new Set();

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      if (entry === 'node_modules') {
        const scopedPath = join(fullPath, scope);
        if (existsSync(scopedPath)) {
          let packages;
          try {
            packages = readdirSync(scopedPath);
          } catch {
            packages = [];
          }
          for (const pkg of packages) {
            if (seenPackages.has(pkg)) continue;
            seenPackages.add(pkg);
            found.push(join(scopedPath, pkg));
          }
        }
        continue; // never descend into other dependencies
      }
      if (SKIP_DIRS.has(entry)) continue;

      walk(fullPath);
    }
  }

  walk(root);
  return found;
}

function searchSourceForReference(searchRoots, reference) {
  if (searchRoots.length === 0) {
    return null; // Can't validate without source
  }

  // Search for function/class definition
  const patterns = [
    `function ${reference}`,
    `const ${reference} =`,
    `export.*function ${reference}`,
    `class ${reference}`,
    `export.*class ${reference}`,
    `export.*${reference}`
  ];

  const patternArgs = patterns.map(p => `-e '${p}'`).join(' ');
  const excludeArgs = ['node_modules', ...SKIP_DIRS].map(d => `--exclude-dir=${d}`).join(' ');
  const pathArgs = searchRoots.map(p => `'${p}'`).join(' ');

  try {
    execSync(`grep -rq ${excludeArgs} ${patternArgs} ${pathArgs}`, { stdio: 'ignore' });
    return true; // Found
  } catch (err) {
    // grep exits 1 for "no match" — that's a real miss. Any other exit code
    // (bad path, permissions, etc.) is a search error, not evidence of staleness.
    return err.status === 1 ? false : null;
  }
}

function* walkMarkdownFiles(dir) {
  try {
    const entries = readdirSync(dir);
    
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || SKIP_DIRS.has(entry)) {
          continue;
        }
        yield* walkMarkdownFiles(fullPath);
      } else if ((entry.endsWith('.md') || entry.endsWith('.mdx')) && !SKIP_FILES.has(entry)) {
        yield fullPath;
      }
    }
  } catch (err) {
    // Skip unreadable directories
  }
}

export async function run(targetPath) {
  const config = loadConfig();
  const sourcePath = config?.source_repo?.path;
  
  if (!sourcePath || !existsSync(sourcePath)) {
    return {
      passed: true,
      skipped: true,
      reason: sourcePath ? `Source repo not found: ${sourcePath}` : 'No source_repo configured in config.yaml'
    };
  }
  
  const packageScope = config?.source_repo?.package_scope || '@tetherto';
  const searchRoots = [sourcePath, ...collectScopedPackageDirs(sourcePath, packageScope)];

  const violations = [];
  const checkedRefs = new Set(); // Avoid checking same ref multiple times

  for (const mdFile of walkMarkdownFiles(targetPath)) {
    const content = readFileSync(mdFile, 'utf-8');
    const refs = extractCodeReferences(content);

    for (const ref of refs) {
      if (checkedRefs.has(ref)) continue;
      checkedRefs.add(ref);

      const found = searchSourceForReference(searchRoots, ref);
      
      if (found === false) {
        violations.push({
          file: mdFile.replace(targetPath, '.'),
          reference: ref,
          issue: 'Referenced function/class not found in source code'
        });
      }
    }
  }
  
  return {
    passed: violations.length === 0,
    violations
  };
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const targetPath = process.argv[2] || process.cwd();
  
  console.log(`🔍 Checking for stale code references in: ${targetPath}\n`);
  
  const result = await run(targetPath);
  
  if (result.skipped) {
    console.log(`⚠️  Skipped: ${result.reason}`);
    process.exit(0);
  }
  
  if (result.passed) {
    console.log('✅ All code references found in source');
    process.exit(0);
  } else {
    console.error('❌ Stale references found:\n');
    
    for (const v of result.violations) {
      console.error(`  ${v.file}:`);
      console.error(`    Missing: ${v.reference}`);
      console.error(`    ${v.issue}\n`);
    }
    
    process.exit(1);
  }
}

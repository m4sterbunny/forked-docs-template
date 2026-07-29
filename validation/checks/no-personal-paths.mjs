#!/usr/bin/env node

/**
 * Check: No Personal Paths
 * 
 * Prevents hardcoded personal filesystem paths from being committed.
 * Detects patterns like:
 * - /Users/username/...
 * - /home/username/...
 * - C:\Users\username\...
 * 
 * These expose user information and break portability.
 * Code/docs should use:
 * - Relative paths from repo root
 * - Generic placeholders like /path/to/repo
 * - Environment variables
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const checkName = 'no-personal-paths';

// A username segment stops at a path separator, whitespace, or any character
// that ordinarily terminates a path inside source code (quotes, brackets,
// punctuation). Without those terminators the match swallows the closing quote
// of './home/foo', which then surfaces as the reported username.
const USER_SEGMENT = "[^\\/\\\\\\s'\"`,;:)\\]}<>]+";

// Personal paths are absolute, so reject a match preceded by "." or a word
// character — otherwise the relative import './home/foo' reads as /home/foo,
// and 'src/Users/bar' reads as /Users/bar.
const NOT_PATH_TAIL = '(?<![\\w.~])';

// Patterns that indicate personal paths
const PERSONAL_PATH_PATTERNS = [
  // macOS: /Users/username
  new RegExp(`${NOT_PATH_TAIL}\\/Users\\/${USER_SEGMENT}`, 'g'),
  // Linux: /home/username
  new RegExp(`${NOT_PATH_TAIL}\\/home\\/${USER_SEGMENT}`, 'g'),
  // Windows: C:\Users\username
  new RegExp(`${NOT_PATH_TAIL}C:\\\\Users\\\\${USER_SEGMENT}`, 'gi'),
  // Windows alt: \Users\username. Also rejects a preceding ":" so a drive-letter
  // path isn't reported twice, once by this pattern and once by the one above.
  new RegExp(`(?<![\\w.~:])\\\\Users\\\\${USER_SEGMENT}`, 'g'),
];

// Exceptions - lines that contain these are allowed
const ALLOWED_EXCEPTIONS = [
  '/Users/<username>',            // Placeholder in docs
  '/Users/username',              // Generic example
  '/home/user',                   // Generic example
  'C:\\Users\\YourName',          // Generic example
  '/path/to/',                    // Already a placeholder
  'IMPORTANT: Update',            // Config instruction
  'Update these paths',           // Config instruction
  'your local environment',       // Config instruction
  '/Users/john',                  // Test fixture example
  '/Users/Alice',                 // Test fixture example
  '/home/bob',                    // Test fixture example
  '// Windows:',                  // Code comment
  '// Linux:',                    // Code comment
  '// macOS:',                    // Code comment
];

function shouldSkipLine(line) {
  // Skip code comments in source files
  if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
    return true;
  }
  
  // Skip regex pattern definitions (lines containing regex literals)
  if (line.includes('PERSONAL_PATH_PATTERNS') || line.match(/\/.*\/[gimuy]*[,;]/)) {
    return true;
  }
  
  return ALLOWED_EXCEPTIONS.some(exception => line.includes(exception));
}

function shouldSkipFile(filePath) {
  // Skip test fixtures entirely
  return filePath.includes('test-fixtures/') || 
         filePath.includes('test-fixtures\\');
}

function* walkFiles(dir, extensions = ['.md', '.mdx', '.js', '.mjs', '.ts', '.tsx', '.json', '.yaml', '.yml']) {
  try {
    const entries = readdirSync(dir);
    
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        // Skip common non-source directories
        if (['.git', 'node_modules', '.next', 'out', 'dist', 'build', '.cursor', '.claude'].includes(entry)) {
          continue;
        }
        yield* walkFiles(fullPath, extensions);
      } else if (extensions.some(ext => entry.endsWith(ext))) {
        yield fullPath;
      }
    }
  } catch (err) {
    // Skip unreadable directories
  }
}

function checkFileForPersonalPaths(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Skip if line has an allowed exception
    if (shouldSkipLine(line)) {
      continue;
    }
    
    for (const pattern of PERSONAL_PATH_PATTERNS) {
      const matches = [...line.matchAll(pattern)];
      
      for (const match of matches) {
        const path = match[0];
        
        // Extract just the username part for reporting. Same segment rule as
        // the patterns above, and either separator, so Windows paths report a
        // whole username rather than truncating at the first "s".
        const usernameMatch = path.match(
          new RegExp(`(?:Users|home)[\\/\\\\](${USER_SEGMENT})`, 'i')
        );
        const username = usernameMatch ? usernameMatch[1] : 'unknown';
        
        violations.push({
          line: i + 1,
          path: path,
          username: username,
          context: line.trim().substring(0, 100)
        });
      }
    }
  }
  
  return violations;
}

export async function run(targetPath) {
  const fileViolations = [];
  
  for (const file of walkFiles(targetPath)) {
    // Skip test fixtures
    if (shouldSkipFile(file)) {
      continue;
    }
    
    const violations = checkFileForPersonalPaths(file);
    
    if (violations.length > 0) {
      fileViolations.push({
        file: file.replace(targetPath, '.'),
        violations
      });
    }
  }
  
  return {
    passed: fileViolations.length === 0,
    violations: fileViolations
  };
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const targetPath = process.argv[2] || process.cwd();
  
  console.log(`🔍 Checking for personal paths in: ${targetPath}\n`);
  
  const result = await run(targetPath);
  
  if (result.passed) {
    console.log('✅ No personal paths found');
    process.exit(0);
  } else {
    console.error('❌ Personal paths detected:\n');
    
    for (const fileResult of result.violations) {
      console.error(`  ${fileResult.file}:`);
      for (const v of fileResult.violations) {
        console.error(`    L${v.line}: Exposes username "${v.username}"`);
        console.error(`      Path: ${v.path}`);
        console.error(`      ${v.context}\n`);
      }
    }
    
    console.error('\n💡 Fix: Replace with relative paths or generic placeholders like /path/to/repo');
    
    process.exit(1);
  }
}

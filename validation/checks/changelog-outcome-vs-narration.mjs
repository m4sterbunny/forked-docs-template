#!/usr/bin/env node

/**
 * Check: Changelog Outcome vs Narration
 *
 * Validates that CHANGELOG documents version-to-version outcomes,
 * not sprint-level narration (features added and removed in same release).
 *
 * Detection approach:
 * - Parses current CHANGELOG.md for "Removed" items
 * - Parses every archived version strictly older than the current one
 * - Flags any "Removed" item that never appears as Added/feature/package
 *   in ANY prior version (not just the immediately preceding one)
 * - This indicates the item was added + removed within the same sprint,
 *   before ever shipping in a dated release
 *
 * Standalone command: NOT included in run-all.mjs
 * Uses: changelog-validation.config.yaml (NOT config.yaml)
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, '..', 'changelog-validation.config.yaml');
const exampleConfigPath = join(__dirname, '..', 'changelog-validation.config.example.yaml');

export const checkName = 'changelog-outcome-vs-narration';

// Excluded from run-all.mjs. This check takes a config object (repo path +
// archive path), not the runner's single target-path string, and it only has
// meaning when CHANGELOG.md's "## vX.Y.Z" changes — a release trigger, not a
// per-PR one. Run it via `npm run validate:changelog`.
export const standalone = true;
export const standaloneCommand = 'npm run validate:changelog';

function loadConfig() {
  if (!existsSync(configPath)) {
    if (existsSync(exampleConfigPath)) {
      console.error('\n❌ changelog-validation.config.yaml not found.');
      console.error('   Copy changelog-validation.config.example.yaml to changelog-validation.config.yaml');
      console.error('   and update with your repo paths.\n');
    }
    return null;
  }
  return yaml.load(readFileSync(configPath, 'utf-8'));
}

function extractVersion(content) {
  // Extract version from ## v0.5.0 style headers
  const match = content.match(/^## v(\d+\.\d+\.\d+)/m);
  return match ? match[1] : null;
}

function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// Splits a changelog/archive file into its individual "## vX.Y.Z" sections,
// since a single archive file (e.g. "2026-archive.md") holds many versions.
function parseVersionSections(content) {
  // Version headers vary by depth across the archive's history: newer
  // entries use "## vX.Y.Z", older ones (e.g. v0.0.1, v0.2.0) use "# vX.Y.Z".
  const headerPattern = /^#{1,2}\s*v(\d+\.\d+\.\d+)\s*$/gm;
  const matches = [...content.matchAll(headerPattern)];
  const sections = new Map();

  for (let i = 0; i < matches.length; i++) {
    const version = matches[i][1];
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    sections.set(version, content.slice(start, end));
  }

  return sections;
}

// Strips markdown noise (backticks, bold markers) so the same logical item
// normalizes to one key regardless of which regex/section captured it.
function normalize(str) {
  return str.replace(/`/g, '').replace(/\*\*/g, '').trim().replace(/\s+/g, ' ');
}

function parseChangelogItems(content) {
  const items = {
    added: new Set(),
    removed: new Set(),
    packages: new Set(),
    features: new Set()
  };

  // Extract sections. A version's own top-level CHANGELOG.md uses "## Added"
  // etc; the same section nested inside an archived "## vX.Y.Z" entry uses
  // "### Added" — extractSection accepts either level.
  const sections = {
    added: extractSection(content, 'Added'),
    removed: extractSection(content, 'Removed'),
    breaking: extractSection(content, 'Breaking changes')
  };

  // Parse Added section
  if (sections.added) {
    parseItems(sections.added, items.added, items.packages, items.features);
  }

  // Parse Removed section
  if (sections.removed) {
    parseItems(sections.removed, items.removed, items.packages, items.features);
  }

  // Parse Breaking changes for removals
  if (sections.breaking) {
    parseBreakingChanges(sections.breaking, items.added, items.removed, items.packages);
  }

  return items;
}

function extractSection(content, sectionName) {
  // Section headings appear as "## Added" at the top level of CHANGELOG.md,
  // or "### Added" once nested inside an archived "## vX.Y.Z" block.
  const headingPattern = new RegExp(`^(#{2,3})\\s*${sectionName}\\s*$`, 'mi');
  const match = content.match(headingPattern);
  if (!match) return null;

  const level = match[1].length;
  const start = match.index + match[0].length;

  // Stop at the next heading of the same level or shallower, so deeper
  // sub-headings (e.g. "#### Some package" inside "### Added") stay in-section.
  const stopPattern = new RegExp(`^#{1,${level}}(?!#)`, 'm');
  const rest = content.slice(start);
  const nextMatch = rest.match(stopPattern);
  const end = nextMatch ? start + nextMatch.index : content.length;

  return content.slice(start, end);
}

function parseItems(section, itemsSet, packagesSet, featuresSet) {
  // Extract every bold span on each bulleted line — items are often
  // introduced with leading prose ("The **X** script") or paired up
  // ("**X** and **Y**"), so we can't anchor to the first bold span only.
  const boldPattern = /\*\*([^*]+)\*\*/g;
  for (const line of section.split('\n')) {
    if (!/^\s*[-*]\s/.test(line)) continue;
    for (const match of line.matchAll(boldPattern)) {
      const item = normalize(match[1]);
      if (item) {
        itemsSet.add(item);
        featuresSet.add(item);
      }
    }
  }

  // Extract package names from inline code
  const packagePattern = /`(@[a-z0-9.-]+\/[a-z0-9.-]+)`/g;
  for (const match of section.matchAll(packagePattern)) {
    const pkg = normalize(match[1]);
    packagesSet.add(pkg);
    itemsSet.add(pkg);
  }

  // Extract inline mentions: "removed the X and Y workers"
  const inlinePattern = /(?:removed?|deleted?|retired?)\s+(?:the\s+)?([a-z0-9-]+(?:\s+and\s+[a-z0-9-]+)?)\s+(?:workers?|packages?|features?)/gi;
  for (const match of section.matchAll(inlinePattern)) {
    for (const part of match[1].split(/\s+and\s+/)) {
      const item = normalize(part);
      itemsSet.add(item);
      featuresSet.add(item);
    }
  }
}

function parseBreakingChanges(section, addedSet, removedSet, packagesSet) {
  // Look for package renames: X → Y or X renamed to Y
  const renamePattern = /`(@[a-z0-9.-]+\/[a-z0-9.-]+)`\s+(?:→|renamed to)\s+`(@[a-z0-9.-]+\/[a-z0-9.-]+)`/g;
  for (const match of section.matchAll(renamePattern)) {
    const oldPkg = normalize(match[1]);
    const newPkg = normalize(match[2]);
    removedSet.add(oldPkg); // Old package was effectively removed
    addedSet.add(newPkg);   // New package was added
    packagesSet.add(oldPkg);
    packagesSet.add(newPkg);
  }

  // Look for explicit removals in breaking changes
  const removalPattern = /`([^`]+)`\s+(?:removed|deleted|retired)/gi;
  for (const match of section.matchAll(removalPattern)) {
    removedSet.add(normalize(match[1]));
  }
}

// Merges Added/feature/package items from every archived version strictly
// older than currentVersion, across every file in the archive directory.
function loadHistoricalItems(archivePath, currentVersion) {
  const merged = { added: new Set(), removed: new Set(), packages: new Set(), features: new Set() };
  const versionsSeen = [];

  if (!existsSync(archivePath)) {
    return { merged, versionsSeen };
  }

  const files = readdirSync(archivePath).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const content = readFileSync(join(archivePath, file), 'utf-8');
    const sections = parseVersionSections(content);

    for (const [version, sectionContent] of sections) {
      if (compareSemver(version, currentVersion) >= 0) continue;
      versionsSeen.push(version);

      const items = parseChangelogItems(sectionContent);
      for (const key of ['added', 'removed', 'packages', 'features']) {
        for (const item of items[key]) merged[key].add(item);
      }
    }
  }

  versionsSeen.sort(compareSemver);
  return { merged, versionsSeen };
}

function compareItems(currentItems, historicalItems) {
  const violations = [];

  for (const removed of currentItems.removed) {
    // Check if this item existed in ANY prior version
    const existedBefore =
      historicalItems.added.has(removed) ||
      historicalItems.features.has(removed) ||
      historicalItems.packages.has(removed);

    if (!existedBefore) {
      violations.push({
        item: removed,
        issue: 'Listed as removed but never found in any prior version',
        suspectedNarration: 'May have been added and removed within the same sprint'
      });
    }
  }

  return violations;
}

export async function run(configOverride = null) {
  const config = configOverride || loadConfig();

  if (!config) {
    return {
      passed: null,  // no verdict — `skipped` is the authoritative signal
      skipped: true,
      reason: 'No changelog-validation.config.yaml found'
    };
  }

  const repoPath = config.repo?.path;
  if (!repoPath || !existsSync(repoPath)) {
    return {
      passed: null,  // no verdict — `skipped` is the authoritative signal
      skipped: true,
      reason: `Repository not found: ${repoPath}`
    };
  }

  // Read current CHANGELOG.md
  const changelogPath = join(repoPath, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) {
    return {
      passed: null,  // no verdict — `skipped` is the authoritative signal
      skipped: true,
      reason: `CHANGELOG.md not found at: ${changelogPath}`
    };
  }

  const currentContent = readFileSync(changelogPath, 'utf-8');
  const currentVersion = extractVersion(currentContent);

  if (!currentVersion) {
    return {
      passed: null,  // no verdict — `skipped` is the authoritative signal
      skipped: true,
      reason: 'Could not detect current version from CHANGELOG.md'
    };
  }

  // Gather every prior version's items from the archive directory
  const archivePath = join(repoPath, config.changelog_archive_path);
  const { merged: historicalItems, versionsSeen } = loadHistoricalItems(archivePath, currentVersion);

  if (versionsSeen.length === 0) {
    return {
      passed: null,  // no verdict — `skipped` is the authoritative signal
      skipped: true,
      reason: `No archived versions found before v${currentVersion} in ${archivePath}`
    };
  }

  // Parse current changelog and compare against full history
  const currentItems = parseChangelogItems(currentContent);
  const violations = compareItems(currentItems, historicalItems);

  return {
    passed: violations.length === 0,
    currentVersion,
    versionsSearched: versionsSeen,
    archivePath,
    violations
  };
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('🔍 Validating CHANGELOG for outcome vs narration...\n');

  const result = await run();

  // Exits 1, unlike the skip path in the other checks' CLIs. Those run as part
  // of a sweep where an unconfigured check is a warning; this command was
  // invoked to validate one changelog, so failing to run it is a failure of
  // intent, not a skippable step.
  if (result.skipped) {
    console.error(`⚠️  Could not run: ${result.reason}`);
    process.exit(1);
  }

  console.log(`📋 Repository: ${loadConfig()?.repo?.path}`);
  console.log(`📋 Current version: v${result.currentVersion}`);
  console.log(`📋 Searched against: v${result.versionsSearched[0]} .. v${result.versionsSearched[result.versionsSearched.length - 1]} (${result.versionsSearched.length} versions)`);
  console.log(`📋 Archive path: ${result.archivePath}\n`);

  if (result.passed) {
    console.log('✅ No narration detected - changelog documents version outcomes correctly');
    process.exit(0);
  } else {
    console.error('❌ Changelog narration detected:\n');

    for (const v of result.violations) {
      console.error(`  ${v.item}:`);
      console.error(`    ✗ Listed as REMOVED in v${result.currentVersion}`);
      console.error(`    ✗ NOT FOUND in any prior version (v${result.versionsSearched[0]} .. v${result.versionsSearched[result.versionsSearched.length - 1]})`);
      console.error(`    → ${v.suspectedNarration}\n`);
    }

    console.error('💡 Changelog should document outcome, not sprint process\n');

    process.exit(1);
  }
}

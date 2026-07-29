#!/usr/bin/env node
// Run with tsx so the shared src/lib/doc-versions.ts helper imports directly.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getLatestDocVersionSlug, slugToDisplayVersion } from '../../src/lib/doc-versions.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')

// Current (highest) doc version, e.g. 0.3.0. Below-current is noFix.
const CURRENT_VERSION = slugToDisplayVersion(
  getLatestDocVersionSlug(path.join(repoRoot, 'content/docs')),
).replace(/^v/, '')

const targetFiles = [
  path.join(repoRoot, `src/data/${CURRENT_VERSION}/components.json`),
  path.join(repoRoot, `src/data/${CURRENT_VERSION}/dont-document-components.json`),
  path.join(repoRoot, `src/data/${CURRENT_VERSION}/document-when-fixed.json`),
]

const writeMode = process.argv.includes('--write')

const slotFamilies = ['Select', 'Dialog', 'Tabs', 'Tooltip', 'Popover', 'Accordion', 'Card', 'Avatar', 'Radio']
const formSlotAllowlist = new Set([
  'FormField',
  'FormItem',
  'FormControl',
  'FormMessage',
  'FormLabel',
  'FormDescription',
])

const utilityAllowlist = new Set(['Toaster'])

function classify(entry, ownerCandidatesByPkg) {
  const { name, category, package: pkg } = entry

  if (category === 'Icons' || /Icon$/.test(name)) {
    return { publicApiKind: 'icon', ownerComponent: null, ruleId: 'icon-by-category-or-suffix', confidence: 'high' }
  }

  for (const fam of slotFamilies) {
    if (name.startsWith(fam) && name !== fam) {
      const owner = fam
      if (ownerCandidatesByPkg.get(pkg)?.has(owner)) {
        return { publicApiKind: 'slot', ownerComponent: owner, ruleId: `slot-family-${fam}`, confidence: 'high' }
      }
      return { publicApiKind: 'component', ownerComponent: null, ruleId: `ambiguous-slot-family-${fam}`, confidence: 'needs-review' }
    }
  }

  if (/^Form[A-Z]/.test(name)) {
    if (formSlotAllowlist.has(name)) {
      const owner = 'Form'
      if (ownerCandidatesByPkg.get(pkg)?.has(owner)) {
        return { publicApiKind: 'slot', ownerComponent: owner, ruleId: 'form-slot-allowlist', confidence: 'medium' }
      }
      return { publicApiKind: 'component', ownerComponent: null, ruleId: 'form-slot-owner-missing', confidence: 'needs-review' }
    }
    return { publicApiKind: 'component', ownerComponent: null, ruleId: 'form-prefixed-first-class', confidence: 'high' }
  }

  if (/Provider$/.test(name) || /^create[A-Z]/.test(name) || utilityAllowlist.has(name)) {
    return { publicApiKind: 'utility', ownerComponent: null, ruleId: 'utility-allowlist-or-pattern', confidence: 'medium' }
  }

  return { publicApiKind: 'component', ownerComponent: null, ruleId: 'fallback-component', confidence: 'high' }
}

function stableStringify(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`
}

function run() {
  const docsData = JSON.parse(fs.readFileSync(targetFiles[0], 'utf8'))
  const ownerCandidatesByPkg = new Map()
  for (const row of docsData.components) {
    if (!ownerCandidatesByPkg.has(row.package)) ownerCandidatesByPkg.set(row.package, new Set())
    ownerCandidatesByPkg.get(row.package).add(row.name)
  }

  const report = []
  for (const file of targetFiles) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const nextRows = []
    for (const row of parsed.components || []) {
      const result = classify(row, ownerCandidatesByPkg)
      const next = { ...row, publicApiKind: result.publicApiKind }
      if (result.publicApiKind === 'slot') next.ownerComponent = result.ownerComponent
      else delete next.ownerComponent
      nextRows.push(next)
      report.push({
        file: path.relative(repoRoot, file),
        name: row.name,
        package: row.package,
        category: row.category,
        publicApiKind: result.publicApiKind,
        ownerComponent: result.publicApiKind === 'slot' ? result.ownerComponent : null,
        confidence: result.confidence,
        ruleId: result.ruleId,
      })
    }

    if (writeMode) {
      fs.writeFileSync(file, stableStringify({ components: nextRows }))
    }
  }

  const byKind = report.reduce((acc, row) => {
    acc[row.publicApiKind] = (acc[row.publicApiKind] || 0) + 1
    return acc
  }, {})
  const byConfidence = report.reduce((acc, row) => {
    acc[row.confidence] = (acc[row.confidence] || 0) + 1
    return acc
  }, {})

  const out = {
    mode: writeMode ? 'write' : 'dry-run',
    totalRows: report.length,
    byKind,
    byConfidence,
    needsReview: report.filter((r) => r.confidence === 'needs-review'),
    sample: report.slice(0, 20),
  }

  process.stdout.write(stableStringify(out))
}

run()

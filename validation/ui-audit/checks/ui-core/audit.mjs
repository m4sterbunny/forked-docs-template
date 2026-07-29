#!/usr/bin/env node
/**
 * UI Core utilities public-surface audit (barrel walk vs the current version's
 * utilities.json).
 *
 * `@tetherto/mdk-ui-core` ships framework-agnostic utilities under
 * `packages/ui-core/src/utils/`. They are exported from the package barrel but
 * neither the demo audit (components) nor the hooks audit covers them, so this
 * lane walks the ui-core utils barrel and cross-references the catalog at
 * `src/data/<current>/utilities.json`.
 *
 * Local: npm run audit:ui-core — reads gitignored audit.config-local.yaml only.
 * The audited version maps to current docs/data (`content/docs` and `src/data/current`).
 * Run with tsx (see package.json) so src/lib/doc-versions.ts imports directly
 * instead of duplicating version-resolution logic.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import yaml from 'js-yaml'
import { CURRENT_DOC_KEY } from '../../src/lib/doc-versions.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']
const UTIL_PATH = /\/utils\//
// ui-core utils barrel, relative to the UI repo root.
const UI_CORE_UTILS_ENTRY = 'packages/ui-core/src/utils/index.ts'

const CONFIG_PATH = path.join(__dirname, 'audit.config.yaml')
const LOCAL_CONFIG_PATH = path.join(__dirname, 'audit.config-local.yaml')

function getAuditProfile() {
  const fromArg = process.argv.find((a) => a.startsWith('--audit-profile='))
  if (fromArg) {
    const v = fromArg.split('=')[1]?.trim()
    if (v === 'local' || v === 'ci') return v
    console.error(`Invalid --audit-profile. Got: ${fromArg}`)
    process.exit(2)
  }
  if (process.env.MDK_AUDIT_PROFILE === 'local' || process.env.MDK_AUDIT_PROFILE === 'ci') {
    return process.env.MDK_AUDIT_PROFILE
  }
  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') return 'ci'
  return 'local'
}

const AUDIT_PROFILE = getAuditProfile()
const ACTIVE_CONFIG_PATH = AUDIT_PROFILE === 'local' ? LOCAL_CONFIG_PATH : CONFIG_PATH

function normalizeSourceEntry(raw, profile) {
  if (!raw || typeof raw !== 'object') return raw
  const repo = raw.localPathToRepo ?? raw.localDemoRepo ?? raw.repo
  const cSrc = raw.ciManifestClone ?? raw.clone
  let clone = raw.clone
  if (cSrc && typeof cSrc === 'object' && cSrc.ownerRepo && cSrc.ref) {
    clone = { githubRepo: String(cSrc.ownerRepo).trim(), ref: String(cSrc.ref).trim() }
  }
  const branch =
    profile === 'local'
      ? (raw.branch ?? raw.expectedBranch ?? '')
      : (raw.expectedBranch ?? raw.branch ?? clone?.ref ?? '')
  return { ...raw, repo, branch }
}

function normalizeAuditConfig(cfg, profile) {
  if (!cfg || typeof cfg !== 'object') return cfg
  const out = { ...cfg }
  if (!out.sources) return out
  const sources = {}
  for (const [name, raw] of Object.entries(out.sources)) {
    sources[name] = normalizeSourceEntry(raw, profile)
  }
  out.sources = sources
  return out
}

function assertLocalAuditConfig(cfg, sourceName, sourceCfg) {
  if (!String(cfg.docsSiteRoot ?? '').trim()) {
    console.error('audit.config-local.yaml requires docsSiteRoot.')
    process.exit(2)
  }
  if (!String(cfg.docsBranch ?? '').trim()) {
    console.error('audit.config-local.yaml requires docsBranch.')
    process.exit(2)
  }
  if (!String(sourceCfg.repo ?? '').trim()) {
    console.error(`audit.config-local.yaml requires sources.${sourceName}.localPathToRepo.`)
    process.exit(2)
  }
  if (!String(sourceCfg.branch ?? '').trim()) {
    console.error(`audit.config-local.yaml requires sources.${sourceName}.branch.`)
    process.exit(2)
  }
}

function resolveDocsSiteRoot(cfg, profile) {
  if (profile === 'local') {
    return path.resolve(String(cfg.docsSiteRoot).trim())
  }
  if (process.env.MDK_DOCS_REPO) return path.resolve(process.env.MDK_DOCS_REPO)
  return path.resolve(__dirname, '../..')
}

function gitHeadBranch(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
  } catch {
    return ''
  }
}

// Repo identifier for output (e.g. "mdk-prv", "downstream-mdk", "mdk-docs").
// Uses the git top-level dir name so the source repo is identifiable without
// leaking the absolute local path into committed audit output.
function repoLabel(repoRoot) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
    if (top) return path.basename(top)
  } catch {}
  return path.basename(repoRoot)
}

function assertBranch(repoRoot, expected, label) {
  if (!expected) return
  const head = gitHeadBranch(repoRoot)
  if (head && head !== expected) {
    console.error(`${label}: expected branch "${expected}", HEAD is "${head}" (${repoRoot})`)
    process.exit(2)
  }
}

if (!fs.existsSync(ACTIVE_CONFIG_PATH)) {
  console.error(
    AUDIT_PROFILE === 'local'
      ? `Copy ${path.basename(path.join(__dirname, 'audit.config-local.example.yaml'))} → audit.config-local.yaml`
      : `Missing ${ACTIVE_CONFIG_PATH}`,
  )
  process.exit(2)
}

const CONFIG = normalizeAuditConfig(yaml.load(fs.readFileSync(ACTIVE_CONFIG_PATH, 'utf8')), AUDIT_PROFILE)
const SOURCE = (
  process.env.MDK_AUDIT_SOURCE ||
  CONFIG.defaultSource ||
  CONFIG.default ||
  'public'
).toLowerCase()

if (!CONFIG.sources?.[SOURCE]) {
  console.error(`Unknown source=${SOURCE}`)
  process.exit(2)
}

const sourceCfg = CONFIG.sources[SOURCE]
if (AUDIT_PROFILE === 'local') assertLocalAuditConfig(CONFIG, SOURCE, sourceCfg)

const DOCS_REPO = resolveDocsSiteRoot(CONFIG, AUDIT_PROFILE)
const UI_REPO = path.resolve(
  process.env[`MDK_${SOURCE.toUpperCase()}_REPO`] || sourceCfg.repo || '',
)
const OUT_DIR = process.env.MDK_AUDIT_OUT_DIR
  ? path.resolve(process.env.MDK_AUDIT_OUT_DIR)
  : __dirname

const UTILS_DATA_FILE = path.join(DOCS_REPO, `src/data/${CURRENT_DOC_KEY}/utilities.json`)
const DONT_DOC_FILE = path.join(DOCS_REPO, `src/data/${CURRENT_DOC_KEY}/dont-document-utilities.json`)

if (!fs.existsSync(UTILS_DATA_FILE)) {
  console.error(`Missing ${UTILS_DATA_FILE}`)
  process.exit(2)
}

const UTILS_ENTRY_FILE = path.join(UI_REPO, UI_CORE_UTILS_ENTRY)
if (!fs.existsSync(UTILS_ENTRY_FILE)) {
  console.error(`[ui-core] utils barrel not found at ${UTILS_ENTRY_FILE}`)
  process.exit(2)
}

if (AUDIT_PROFILE === 'local') {
  assertBranch(DOCS_REPO, String(CONFIG.docsBranch).trim(), 'docsSiteRoot')
  assertBranch(UI_REPO, String(sourceCfg.branch).trim(), `sources.${SOURCE}`)
}

function relRepo(abs) {
  return path.relative(UI_REPO, abs)
}

function stripComments(src) {
  src = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  src = src.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (match, pre) => pre + ' '.repeat(match.length - pre.length))
  return src
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const specStripped = spec.replace(/\.(js|jsx)$/, '')
  for (const candidate of specStripped === spec ? [spec] : [specStripped, spec]) {
    const base = path.resolve(path.dirname(fromFile), candidate)
    for (const ext of EXTENSIONS) {
      const p = base + ext
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    }
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base
    for (const ext of EXTENSIONS) {
      const p = path.join(base, 'index' + ext)
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    }
  }
  return null
}

function parseNameList(body) {
  const out = []
  for (const raw of body.split(',')) {
    const part = raw.trim()
    if (!part || /^type\s+/.test(part)) continue
    const asMatch = part.match(/^(\w+)\s+as\s+(\w+)$/)
    if (asMatch) out.push({ local: asMatch[1], exported: asMatch[2] })
    else {
      const only = part.match(/^(\w+)$/)
      if (only) out.push({ local: only[1], exported: only[1] })
    }
  }
  return out
}

function parseModule(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  const src = stripComments(raw)
  const reExports = []
  const localExports = []

  for (const m of src.matchAll(/^\s*export\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm)) {
    reExports.push({ kind: 'star', from: m[1] })
  }
  for (const m of src.matchAll(/^\s*export\s+(type\s+)?\{([\s\S]*?)\}\s*from\s+['"]([^'"]+)['"]\s*;?\s*$/gm)) {
    if (m[1]) continue
    const names = parseNameList(m[2])
    if (names.length) reExports.push({ kind: 'named', from: m[3], names })
  }
  for (const m of src.matchAll(/^\s*export\s+(?:const|let|var)\s+(\w+)/gm)) {
    localExports.push({ name: m[1] })
  }
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?function\s*\*?\s*(\w+)/gm)) {
    localExports.push({ name: m[1] })
  }

  const jsdocMap = {}
  const jsDocRegex =
    /\/\*\*([\s\S]*?)\*\/\s*(?:export\s+(?:const|let|var|(?:async\s+)?function\s*\*?)\s+(\w+))/g
  for (const m of raw.matchAll(jsDocRegex)) {
    const firstLine = m[1]
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').trim())
      .find((l) => l && !l.startsWith('@'))
    if (firstLine) jsdocMap[m[2]] = firstLine
  }

  return { reExports, localExports, jsdocMap, filePath }
}

function walk(entryFile) {
  const byKey = new Map()
  const warnings = []
  const visitedStar = new Set()

  function add(rec) {
    const key = `${rec.name}:${rec.sourceFile}`
    if (!byKey.has(key)) byKey.set(key, rec)
  }

  function visitStar(file, chain) {
    if (visitedStar.has(file)) return
    visitedStar.add(file)
    const parsed = parseModule(file)
    const nextChain = [...chain, file]

    for (const le of parsed.localExports) {
      add({ name: le.name, sourceFile: file, chain: nextChain, jsdoc: parsed.jsdocMap[le.name] || null })
    }

    for (const re of parsed.reExports) {
      const resolved = resolveImport(file, re.from)
      if (!resolved) {
        warnings.push({ at: relRepo(file), missing: re.from, kind: re.kind })
        continue
      }
      if (re.kind === 'star') visitStar(resolved, nextChain)
      else if (re.kind === 'named') resolveNamed(resolved, re.names, nextChain)
    }
  }

  function resolveNamed(file, nameMap, chain) {
    const parsed = parseModule(file)
    const localSet = new Set(parsed.localExports.map((l) => l.name))
    const nextChain = [...chain, file]
    const remaining = []
    for (const nm of nameMap) {
      if (localSet.has(nm.local)) {
        add({ name: nm.exported, sourceFile: file, chain: nextChain, jsdoc: parsed.jsdocMap[nm.local] || null })
      } else remaining.push(nm)
    }
    if (!remaining.length) return
    for (const re of parsed.reExports) {
      const resolved = resolveImport(file, re.from)
      if (!resolved) continue
      if (re.kind === 'star') resolveNamed(resolved, remaining, nextChain)
    }
  }

  visitStar(entryFile, [])
  return { symbols: [...byKey.values()], warnings }
}

// Utility exports are value exports (const/function) sourced under `/utils/`.
// Skip ALL_CAPS-only? No — constants like ONE_DAY_MS are documented utilities too.
function isUtilityExport(name, sourceFile) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false
  if (sourceFile && !UTIL_PATH.test(sourceFile)) return false
  return true
}

function loadCatalog() {
  const parsed = JSON.parse(fs.readFileSync(UTILS_DATA_FILE, 'utf8'))
  const byName = new Map()
  for (const u of parsed.utilities || []) byName.set(u.name, u)
  return byName
}

function loadDontDocument() {
  if (!fs.existsSync(DONT_DOC_FILE)) return new Set()
  const parsed = JSON.parse(fs.readFileSync(DONT_DOC_FILE, 'utf8'))
  const set = new Set()
  for (const u of parsed.utilities || []) set.add(typeof u === 'string' ? u : u.name)
  return set
}

function run() {
  const catalog = loadCatalog()
  const dontDoc = loadDontDocument()
  const { symbols, warnings } = walk(UTILS_ENTRY_FILE)

  const rows = []
  const reachableNames = new Set()

  for (const s of symbols) {
    if (!isUtilityExport(s.name, s.sourceFile)) continue
    reachableNames.add(s.name)
    const docEntry = catalog.get(s.name)
    rows.push({
      name: s.name,
      package: 'ui-core',
      section: 'utilities',
      category: docEntry?.category ?? 'propose-Uncategorized',
      subcategory: docEntry?.subcategory ?? null,
      documented: !!docEntry,
      reachable: true,
      docUrl: docEntry?.docUrl ?? null,
      sourcePath: relRepo(s.sourceFile),
      summary: s.jsdoc || docEntry?.summary || null,
      notes: s.jsdoc ? [] : ['no-jsdoc'],
      missingNeedsDocs: !docEntry && !dontDoc.has(s.name),
    })
  }

  // Stale: catalog rows that no longer resolve from the ui-core utils barrel.
  for (const [name, docEntry] of catalog.entries()) {
    if (reachableNames.has(name)) continue
    rows.push({
      name,
      package: 'ui-core',
      section: 'utilities',
      category: docEntry.category ?? null,
      subcategory: docEntry.subcategory ?? null,
      documented: true,
      reachable: false,
      docUrl: docEntry.docUrl ?? null,
      sourcePath: null,
      summary: docEntry.summary ?? null,
      notes: ['stale-in-docs'],
      missingNeedsDocs: false,
    })
  }

  rows.sort((a, b) => {
    if (a.category !== b.category) return String(a.category).localeCompare(String(b.category))
    return a.name.localeCompare(b.name)
  })

  const missingNeedsDocs = rows.filter((r) => r.reachable && r.missingNeedsDocs)
  const counts = {
    total: rows.length,
    documented: rows.filter((r) => r.documented).length,
    undocumented: rows.filter((r) => r.reachable && !r.documented).length,
    staleInDocs: rows.filter((r) => r.documented && !r.reachable).length,
    missingNeedsDocs: missingNeedsDocs.length,
  }

  const out = {
    generatedAt: new Date().toISOString(),
    mode: 'ui-core-utilities',
    docsRepo: repoLabel(DOCS_REPO),
    sourceRepo: repoLabel(UI_REPO),
    catalog: `src/data/${CURRENT_DOC_KEY}/utilities.json`,
    entryPoint: UI_CORE_UTILS_ENTRY,
    counts,
    warnings,
    missingNeedsDocs: missingNeedsDocs.map(({ name, category, sourcePath }) => ({ name, category, sourcePath })),
    utilities: rows.map(({ missingNeedsDocs: _m, ...rest }) => rest),
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'utilities-audit.json'), JSON.stringify(out, null, 2) + '\n')
  fs.writeFileSync(path.join(OUT_DIR, 'undocumented-utilities-by-category.md'), renderMd(rows, counts, missingNeedsDocs))

  console.log(
    `[ui-core] Wrote utilities-audit.json (${counts.total} rows, ${counts.documented} documented, ${counts.undocumented} undocumented, ${counts.missingNeedsDocs} missing catalog, ${counts.staleInDocs} stale)`,
  )
  if (warnings.length) console.log(`[ui-core] Warnings: ${warnings.length} broken re-export chains`)
}

function groupBy(arr, fn) {
  return arr.reduce((acc, x) => {
    const k = fn(x)
    ;(acc[k] = acc[k] || []).push(x)
    return acc
  }, {})
}

function renderMd(rows, counts, missingNeedsDocs) {
  const lines = [
    '# Undocumented public UI Core utilities',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Totals: ${counts.undocumented} reachable without catalog row; ${counts.missingNeedsDocs} missing from utilities.json; ${counts.staleInDocs} stale in catalog.`,
    '',
    `Catalog source: \`src/data/${CURRENT_DOC_KEY}/utilities.json\`. Surface: \`${UI_CORE_UTILS_ENTRY}\`.`,
    '',
  ]

  if (missingNeedsDocs.length) {
    lines.push('## Missing from utilities.json (reachable, not in dont-document-utilities.json)', '')
    const byCat = groupBy(missingNeedsDocs, (r) => r.category)
    for (const cat of Object.keys(byCat).sort()) {
      lines.push(`### ${cat}`, '')
      for (const r of byCat[cat].sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`- \`${r.name}\` (\`${r.sourcePath}\`)`)
      }
      lines.push('')
    }
  }

  const stale = rows.filter((r) => r.documented && !r.reachable)
  if (stale.length) {
    lines.push('## Stale catalog entries (not reachable from the ui-core utils barrel)', '')
    for (const r of stale) lines.push(`- \`${r.name}\``)
    lines.push('')
  }

  return lines.join('\n')
}

run()

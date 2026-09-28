#!/usr/bin/env node
/**
 * Hooks public-surface audit (barrel walk vs the current version's hooks.json).
 *
 * Local: npm run audit:hooks — reads gitignored audit.config-local.yaml only.
 * The audited version maps to current docs/data (`content/docs` and `src/data/current`).
 *
 * Run with tsx (see package.json) so the shared src/lib/doc-versions.ts helper
 * imports directly instead of duplicating the version-resolution logic.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import yaml from 'js-yaml'
import { CURRENT_DOC_KEY, CURRENT_DOCS_PREFIX } from '../../src/lib/doc-versions.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']
const HOOK_PATH = /\/hooks\//

const HOOK_CATEGORY_HINTS = [
  { match: /use-beep-sound|use-chart-data-check/, category: 'Monitoring', page: 'monitoring' },
  {
    match:
      /use-has-perms|use-permissions|use-notification|use-header-controls|use-local-storage|use-pagination|use-is-feature-editing-enabled|use-timezone|use-pool-configs/,
    category: 'UI',
    page: 'ui',
  },
]

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
  return path.resolve(__dirname, '../../..')
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

const DOCS_CONTENT_REL = process.env.MDK_AUDIT_DOCS_CONTENT_REL || 'content/docs'
const HOOKS_DOCS_REL = `${DOCS_CONTENT_REL}/reference/app-toolkit/hooks`
const DOC_SITE_PREFIX = CURRENT_DOCS_PREFIX

const HOOKS_DATA_FILE = path.join(DOCS_REPO, `src/data/${CURRENT_DOC_KEY}/hooks.json`)
const DONT_DOC_FILE = path.join(DOCS_REPO, `src/data/${CURRENT_DOC_KEY}/dont-document-hooks.json`)
const HOOKS_DOCS_DIR = path.join(DOCS_REPO, HOOKS_DOCS_REL)

if (!fs.existsSync(HOOKS_DATA_FILE)) {
  console.error(`Missing ${HOOKS_DATA_FILE}`)
  process.exit(2)
}
if (!fs.existsSync(HOOKS_DOCS_DIR)) {
  console.error(`Missing hooks docs dir ${HOOKS_DOCS_DIR}`)
  process.exit(2)
}

if (AUDIT_PROFILE === 'local') {
  assertBranch(DOCS_REPO, String(CONFIG.docsBranch).trim(), 'docsSiteRoot')
  assertBranch(UI_REPO, String(sourceCfg.branch).trim(), `sources.${SOURCE}`)
}

/**
 * Load the pre-built registry.json produced by `npm run build:registry` inside
 * packages/react-devkit. Returns devkit hooks as the
 * authoritative List A for core + foundation packages.
 * Adapter hooks are NOT in the registry — those are covered by the adapter barrel walk below.
 */
function loadRegistry(uiRepo) {
  const registryPath = path.join(uiRepo, 'packages/react-devkit/dist/registry.json')
  if (!fs.existsSync(registryPath)) {
    console.error(`[hooks] registry.json not found at ${registryPath}`)
    console.error('[hooks] Run: cd packages/react-devkit && npm run build:registry')
    process.exit(2)
  }
  const d = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  const pkgOf = (p) => (p.startsWith('src/foundation/') ? 'foundation' : 'core')
  const pkgRoot = path.join(uiRepo, 'packages/react-devkit')
  return {
    hooks: (d.hooks || []).map((h) => ({
      name: h.name,
      pkg: pkgOf(h.path),
      sourceFile: path.join(pkgRoot, h.path),
      tier: h.tier,
      category: h.category,
      summary: h.description ?? null,
    })),
    meta: { generatedAt: d.generatedAt, packageVersion: d.packageVersion },
  }
}

function buildAdapterEntry(uiRepo) {
  const file = path.join(uiRepo, 'packages/react-adapter/src/index.ts')
  return fs.existsSync(file) ? [{ pkg: 'adapter', file }] : []
}

const ADAPTER_ENTRIES = buildAdapterEntry(UI_REPO)
if (!ADAPTER_ENTRIES.length) {
  console.error(`[hooks] react-adapter barrel not found under ${UI_REPO}`)
  process.exit(2)
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
  // TypeScript ESM: '.js' in source maps to '.ts' on disk — try stripping the extension
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
  for (const m of src.matchAll(/^\s*export\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm)) {
    reExports.push({ kind: 'starAs', namespace: m[1], from: m[2] })
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

function walk(entry) {
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
      add({
        name: le.name,
        exportKind: 'named',
        sourceFile: file,
        chain: nextChain,
        jsdoc: parsed.jsdocMap[le.name] || null,
      })
    }

    for (const re of parsed.reExports) {
      const resolved = resolveImport(file, re.from)
      if (!resolved) {
        warnings.push({ at: relRepo(file), missing: re.from, kind: re.kind })
        continue
      }
      if (re.kind === 'starAs') continue
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
        add({
          name: nm.exported,
          exportKind: 'named',
          sourceFile: file,
          chain: nextChain,
          jsdoc: parsed.jsdocMap[nm.local] || null,
        })
      } else remaining.push(nm)
    }
    if (!remaining.length) return
    for (const re of parsed.reExports) {
      const resolved = resolveImport(file, re.from)
      if (!resolved) continue
      if (re.kind === 'star') resolveNamed(resolved, remaining, nextChain)
      else if (re.kind === 'named') {
        const subset = remaining
          .filter((r) => re.names.some((n) => n.exported === r.local))
          .map((r) => {
            const n = re.names.find((nn) => nn.exported === r.local)
            return { local: n.local, exported: r.exported }
          })
        if (subset.length) resolveNamed(resolved, subset, nextChain)
      }
    }
  }

  visitStar(entry.file, [])
  return { symbols: [...byKey.values()], warnings }
}

function isLikelyHook(name, sourceFile) {
  if (!/^use[A-Z][A-Za-z0-9]*$/.test(name)) return false
  if (sourceFile && !HOOK_PATH.test(sourceFile)) return false
  return true
}

function loadHooksCatalog() {
  const parsed = JSON.parse(fs.readFileSync(HOOKS_DATA_FILE, 'utf8'))
  const byKey = new Map()
  const byName = new Map()
  for (const h of parsed.hooks || []) {
    byKey.set(`${h.package}::${h.name}`, h)
    // fallback: name-only, used when hook has moved to a different package
    if (!byName.has(h.name)) byName.set(h.name, h)
  }
  byKey._byName = byName
  return byKey
}

function loadDontDocument() {
  if (!fs.existsSync(DONT_DOC_FILE)) return new Set()
  const parsed = JSON.parse(fs.readFileSync(DONT_DOC_FILE, 'utf8'))
  const set = new Set()
  for (const h of parsed.hooks || []) {
    const name = typeof h === 'string' ? h : h.name
    const pkg = typeof h === 'string' ? 'foundation' : h.package || 'foundation'
    if (name) set.add(`${pkg}::${name}`)
  }
  return set
}

function collectMdxFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectMdxFiles(full, files)
    else if (entry.name.endsWith('.mdx')) files.push(full)
  }
  return files
}

function loadMdxHeadings() {
  const byKey = new Map()
  if (!fs.existsSync(HOOKS_DOCS_DIR)) return byKey
  for (const fullPath of collectMdxFiles(HOOKS_DOCS_DIR)) {
    const raw = fs.readFileSync(fullPath, 'utf8')
    const visible = raw.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    // Match H2 (## `useXxx`) and H3 (### `useXxx`) headings.
    for (const m of visible.matchAll(/^#{2,3}\s*`(use[A-Za-z0-9]+)`/gm)) {
      const hookName = m[1]
      // Key under both known package prefixes so devkit and adapter hooks resolve.
      byKey.set(`foundation::${hookName}`, fullPath)
      byKey.set(`adapter::${hookName}`, fullPath)
      byKey.set(`core::${hookName}`, fullPath)
    }
  }
  return byKey
}

function categorizeHook(sourceFile) {
  const rel = relRepo(sourceFile).toLowerCase()
  for (const h of HOOK_CATEGORY_HINTS) {
    if (h.match.test(rel)) return { section: 'hooks', category: h.category, page: h.page, proposed: false }
  }
  return { section: 'hooks', category: 'propose-Uncategorized', page: null, proposed: true }
}

function defaultDocUrl(category, name) {
  const page =
    category === 'Monitoring' ? 'monitoring' : category === 'UI' ? 'ui' : null
  if (!page) return null
  const suffix = `/reference/app-toolkit/hooks/${page}#${name.toLowerCase()}`
  return DOC_SITE_PREFIX ? `${DOC_SITE_PREFIX}${suffix}` : suffix
}

function run() {
  const catalog = loadHooksCatalog()
  const dontDoc = loadDontDocument()
  const mdxHeadings = loadMdxHeadings()
  const rows = []
  const allWarnings = []
  const reachableKeys = new Set()

  // Phase 1: devkit hooks from registry (core + foundation).
  // The registry uses ts-morph which resolves path aliases correctly.
  const registry = loadRegistry(UI_REPO)
  console.log(
    `[hooks] registry: ${registry.hooks.length} devkit hooks (generated ${registry.meta.generatedAt})`,
  )
  for (const h of registry.hooks) {
    const key = `${h.pkg}::${h.name}`
    reachableKeys.add(key)
    let docEntry = catalog.get(key)
    // Fallback: hook may have moved packages — match by name if pkg-qualified key misses
    if (!docEntry) {
      const fallback = catalog._byName.get(h.name)
      if (fallback) {
        docEntry = fallback
        reachableKeys.add(`${fallback.package}::${h.name}`)
      }
    }
    const cat = categorizeHook(h.sourceFile)
    const notes = []
    if (docEntry?.hasDetailPage && !mdxHeadings.has(key)) notes.push('heading-missing-in-mdx')

    rows.push({
      name: h.name,
      package: h.pkg,
      section: docEntry?.section ?? cat.section,
      category: docEntry?.category ?? (h.category ?? cat.category),
      subcategory: docEntry?.subcategory ?? null,
      documented: !!docEntry,
      reachable: true,
      docUrl: docEntry?.docUrl ?? defaultDocUrl(cat.category, h.name),
      demo: docEntry?.demo ?? null,
      sourcePath: relRepo(h.sourceFile),
      exportChain: [],
      exportKind: 'named',
      summary: h.summary || docEntry?.summary || null,
      notes,
      missingNeedsDocs: !docEntry && !dontDoc.has(key),
    })
  }

  // Phase 2: adapter hooks from barrel walk (react-adapter not in registry).
  for (const entry of ADAPTER_ENTRIES) {
    const { symbols, warnings } = walk(entry)
    allWarnings.push(...warnings.map((w) => ({ package: entry.pkg, ...w })))

    for (const s of symbols) {
      if (!isLikelyHook(s.name, s.sourceFile)) continue
      const key = `${entry.pkg}::${s.name}`
      reachableKeys.add(key)
      let docEntry = catalog.get(key)
      // Fallback: hook may have moved packages — match by name if pkg-qualified key misses
      if (!docEntry) {
        const fallback = catalog._byName.get(s.name)
        if (fallback) {
          docEntry = fallback
          // mark the catalog's original key reachable so the stale loop skips it
          reachableKeys.add(`${fallback.package}::${s.name}`)
        }
      }
      const cat = categorizeHook(s.sourceFile)
      const notes = []
      if (!s.jsdoc) notes.push('no-jsdoc')
      if (docEntry?.hasDetailPage && !mdxHeadings.has(key)) notes.push('heading-missing-in-mdx')

      rows.push({
        name: s.name,
        package: entry.pkg,
        section: docEntry?.section ?? cat.section,
        category: docEntry?.category ?? cat.category,
        subcategory: docEntry?.subcategory ?? null,
        documented: !!docEntry,
        reachable: true,
        docUrl: docEntry?.docUrl ?? defaultDocUrl(cat.category, s.name),
        demo: docEntry?.demo ?? null,
        sourcePath: relRepo(s.sourceFile),
        exportChain: s.chain.map(relRepo),
        exportKind: s.exportKind,
        summary: s.jsdoc || docEntry?.summary || null,
        notes,
        missingNeedsDocs: !docEntry && !dontDoc.has(key),
      })
    }
  }

  for (const [key, docEntry] of catalog.entries()) {
    if (reachableKeys.has(key)) continue
    // Only emit stale rows for packages we actually walked (registry covers core+foundation; adapter walk covers adapter)
    const walkedPkgs = new Set(['core', 'foundation', ...ADAPTER_ENTRIES.map((e) => e.pkg)])
    if (!walkedPkgs.has(docEntry.package)) continue
    rows.push({
      name: docEntry.name,
      package: docEntry.package,
      section: docEntry.section,
      category: docEntry.category,
      subcategory: docEntry.subcategory ?? null,
      documented: true,
      reachable: false,
      docUrl: docEntry.docUrl ?? null,
      demo: docEntry.demo ?? null,
      sourcePath: null,
      exportChain: [],
      exportKind: null,
      summary: docEntry.summary ?? null,
      notes: ['stale-in-docs'],
      missingNeedsDocs: false,
    })
  }

  rows.sort((a, b) => {
    if (a.package !== b.package) return a.package.localeCompare(b.package)
    if (a.category !== b.category) return a.category.localeCompare(b.category)
    return a.name.localeCompare(b.name)
  })

  const missingNeedsDocs = rows.filter((r) => r.reachable && r.missingNeedsDocs)
  const counts = {
    total: rows.length,
    documented: rows.filter((r) => r.documented).length,
    undocumented: rows.filter((r) => r.reachable && !r.documented).length,
    staleInDocs: rows.filter((r) => r.documented && !r.reachable).length,
    missingNeedsDocs: missingNeedsDocs.length,
    headingDrift: rows.filter((r) => r.notes?.includes('heading-missing-in-mdx')).length,
    byPackage: {
      core: rows.filter((r) => r.package === 'core').length,
      foundation: rows.filter((r) => r.package === 'foundation').length,
      adapter: rows.filter((r) => r.package === 'adapter').length,
    },
  }

  const out = {
    generatedAt: new Date().toISOString(),
    mode: 'hooks',
    docsRepo: repoLabel(DOCS_REPO),
    sourceRepo: repoLabel(UI_REPO),
    hooksDocsDir: HOOKS_DOCS_REL,
    entryPoints: [
      `registry:packages/react-devkit/dist/registry.json (${registry.hooks.length} hooks)`,
      ...ADAPTER_ENTRIES.map((e) => path.relative(UI_REPO, e.file)),
    ],
    counts,
    warnings: allWarnings,
    missingNeedsDocs: missingNeedsDocs.map(({ name, package: pkg, category, sourcePath }) => ({
      name,
      package: pkg,
      category,
      sourcePath,
    })),
    hooks: rows.map(({ missingNeedsDocs: _m, ...rest }) => rest),
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'hooks-audit.json'), JSON.stringify(out, null, 2) + '\n')
  fs.writeFileSync(path.join(OUT_DIR, 'undocumented-hooks-by-category.md'), renderMd(rows, counts, missingNeedsDocs))

  console.log(
    `[hooks] Wrote hooks-audit.json (${counts.total} rows, ${counts.documented} documented, ${counts.undocumented} undocumented, ${counts.missingNeedsDocs} missing catalog, ${counts.staleInDocs} stale)`,
  )
  if (allWarnings.length) {
    console.log(`[hooks] Warnings: ${allWarnings.length} broken re-export chains`)
  }
}

function renderMd(rows, counts, missingNeedsDocs) {
  const lines = [
    '# Undocumented public hooks',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Totals: ${counts.undocumented} reachable without catalog row; ${counts.missingNeedsDocs} missing from hooks.json; ${counts.staleInDocs} stale in catalog.`,
    '',
    `Catalog source: \`src/data/${CURRENT_DOC_KEY}/hooks.json\`. Docs scope: \`${HOOKS_DOCS_REL}/\`.`,
    '',
  ]

  if (missingNeedsDocs.length) {
    lines.push('## Missing from hooks.json (reachable, not in dont-document-hooks.json)', '')
    const byCat = groupBy(missingNeedsDocs, (r) => r.category)
    for (const cat of Object.keys(byCat).sort()) {
      lines.push(`### ${cat}`, '')
      for (const r of byCat[cat].sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`- \`${r.name}\` (\`${r.sourcePath}\`)`)
      }
      lines.push('')
    }
  }

  const undoc = rows.filter((r) => !r.documented && r.reachable)
  if (undoc.length) {
    lines.push('## Undocumented (no catalog row)', '')
    for (const r of undoc) {
      lines.push(`- \`${r.name}\` — \`${r.sourcePath}\` (${r.category})`)
    }
    lines.push('')
  }

  const stale = rows.filter((r) => r.documented && !r.reachable)
  if (stale.length) {
    lines.push('## Stale catalog entries (not reachable from barrel)', '')
    for (const r of stale) {
      lines.push(`- \`${r.name}\` (${r.docUrl || 'no url'})`)
    }
    lines.push('')
  }

  const drift = rows.filter((r) => r.notes?.includes('heading-missing-in-mdx'))
  if (drift.length) {
    lines.push('## Heading drift (hasDetailPage in hooks.json, no ## `useXxx` in develop MDX)', '')
    for (const r of drift) {
      lines.push(`- \`${r.name}\``)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function groupBy(arr, fn) {
  return arr.reduce((acc, x) => {
    const k = fn(x)
    ;(acc[k] = acc[k] || []).push(x)
    return acc
  }, {})
}

run()

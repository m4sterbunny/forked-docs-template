#!/usr/bin/env node
/**
 * Demo-as-source-of-truth audit (components, v2 — List A / List B model).
 *
 * Source of truth for "what should be documented":
 *   1. List A (public API surface): every PascalCase component reachable from the public
 *      package barrels (`packages/<pkg>/src/index.ts`), including non-barrel
 *      internals encountered when walking each barrel source's relative imports.
 *      Prefers `*.public-surface.json` under ui-client when present; else AST barrel parse.
 *   2. List B (demo app surface): the subset of List A that is value-imported anywhere in
 *      the demo app's relative-import tree, OR rendered transitively when a
 *      directly-imported parent's source tree is followed up to TRANSITIVE_DEPTH
 *      hops via the unified `componentIndex`.
 *
 * Two decision questions, derived from List B:
 *   * missingNeedsDocs[] = List B \ components.json \ dont-document-components.json
 *   * stale[]            = components.json \ List B  (excluding leaf primaries
 *                          already surfaced in leaves[])
 *
 * Plus three orthogonal per-leaf checks (recipe + props are unchanged):
 *   1. Catalog presence -- is there a row in `src/data/components.json` for this leaf?
 *   2. Import recipe    -- does the demo's actual `import { ... } from '@tetherto/mdk-*-ui'`
 *                          line agree with what the docs say to import?
 *   3. Props completeness -- every prop in the component's source-side props type
 *                            should be mentioned somewhere on the doc page.
 *
 * Config profile (--audit-profile=local|ci or MDK_AUDIT_PROFILE; else CI env → ci, else local):
 *   local — only `audit.config-local.yaml` (`npm run audit:demo`). Requires explicit docsSiteRoot,
 *            docsBranch, sources.<name>.localPathToRepo, sources.<name>.branch (no repo/branch env overrides).
 *   ci    — only `audit.config.yaml` (`npm run audit:demo:ci`; CI=true on runners). The two files are not merged.
 * Output URLs favor GitHub when configured; local profile may emit file:// for doc/source links.
 *
 * Env-var overrides (ci profile and tooling only, unless noted):
 *   MDK_AUDIT_SOURCE              public | private          select the source
 *   MDK_<SOURCE>_REPO             absolute path             override ui-client path (ci only)
 *   MDK_<SOURCE>_BRANCH           branch name               override expected ui-client branch (ci only)
 *   MDK_<SOURCE>_GITHUB_URL       https://github.com/...    override githubUrl (ci only)
 *   MDK_<SOURCE>_DOCS_URL         base URL                  override publishedDocsBaseUrl (ci only)
 *   MDK_DOCS_REPO                 absolute path             mdk-docs root (ci only; local uses docsSiteRoot in yaml)
 *   MDK_DOCS_EXPECTED_BRANCH      branch name               optional docs branch check (ci only)
 *   MDK_AUDIT_TRANSITIVE_DEPTH    integer >= 1, default 4   List B transitive hop depth (local + ci)
 *   MDK_AUDIT_OUT_DIR             directory                 audit JSON/markdown output (local + ci)
 *   MDK_<SOURCE>_PUBLIC_SURFACE_CORE / _FOUNDATION   optional absolute paths to
 *                                                   `*.public-surface.json` (overrides YAML).
 *   MDK_AUDIT_DOC_SITE_PREFIX     override the current-version prefix (default current-doc prefix, currently root ``) for published doc links from catalog paths
 *   MDK_AUDIT_DOCS_CONTENT_REL    path under docs repo for the current-version MDX (default `content/docs`)
 *
 * The audited version maps to `src/data/current` and current docs in `content/docs`.
 * Run with tsx (see package.json) so src/lib/doc-versions.ts imports directly.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import yaml from 'js-yaml'
import { CURRENT_DOC_KEY, CURRENT_DOCS_PREFIX } from '../../src/lib/doc-versions.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

// ---------- config ----------

const CONFIG_PATH = path.join(__dirname, 'audit.config.yaml')
const LOCAL_CONFIG_PATH = path.join(__dirname, 'audit.config-local.yaml')

function getAuditProfile() {
  const fromArg = process.argv.find((a) => a.startsWith('--audit-profile='))
  if (fromArg) {
    const v = fromArg.split('=')[1]?.trim()
    if (v === 'local' || v === 'ci') return v
    console.error(`Invalid --audit-profile (use local or ci). Got: ${fromArg}`)
    process.exit(2)
  }
  const fromEnv = process.env.MDK_AUDIT_PROFILE
  if (fromEnv === 'local' || fromEnv === 'ci') return fromEnv
  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') return 'ci'
  return 'local'
}

const AUDIT_PROFILE = getAuditProfile()
const ACTIVE_CONFIG_PATH = AUDIT_PROFILE === 'local' ? LOCAL_CONFIG_PATH : CONFIG_PATH

/** GitHub "owner/repo" only — never a URL or filesystem path. */
const GH_OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function assertOwnerRepoSlug(label, value) {
  if (value === undefined || value === null || value === '') return
  const s = String(value).trim()
  if (s.startsWith('/') || /^https?:\/\//i.test(s) || path.isAbsolute(s)) {
    console.error(
      `${label}: use GitHub "owner/repo" (e.g. tetherto/mdk), not a URL or path. Got: ${value}`,
    )
    process.exit(2)
  }
  if (!GH_OWNER_REPO.test(s)) {
    console.error(`${label}: expected "owner/repo" (letters, numbers, ._-). Got: ${value}`)
    process.exit(2)
  }
}

/**
 * Support clearer YAML names (ciManifestClone, localPathToRepo, …) and legacy
 * keys (localDemoRepo, repo, branch, githubUrl, githubSubpath, …).
 * Local profile: branch comes only from explicit `branch` or `expectedBranch` in yaml — never from ciManifestClone.ref.
 */
function normalizeSourceEntry(raw, profile) {
  if (!raw || typeof raw !== 'object') return raw
  const cSrc = raw.ciManifestClone ?? raw.manifestClone ?? raw.clone
  let clone = raw.clone
  if (cSrc && typeof cSrc === 'object' && !Array.isArray(cSrc)) {
    const githubRepo = cSrc.ownerRepo ?? cSrc.githubRepo
    const ref = cSrc.ref
    if (githubRepo != null && githubRepo !== '' && ref != null && ref !== '') {
      clone = { githubRepo: String(githubRepo).trim(), ref: String(ref).trim() }
    }
  }
  const repo = raw.localPathToRepo ?? raw.localDemoRepo ?? raw.repo
  const branch =
    profile === 'local'
      ? (raw.branch ?? raw.expectedBranch ?? '')
      : (raw.expectedBranch ?? raw.branch ?? clone?.ref)
  const githubUrl = raw.githubBaseUrl ?? raw.githubUrl
  let githubSubpath = raw.pathInsideGithubRepo ?? raw.githubSubpath ?? ''
  githubSubpath = String(githubSubpath).replace(/^\/+|\/+$/g, '')
  const docsBaseUrl = raw.publishedDocsBaseUrl ?? raw.docsBaseUrl
  const demoApp = raw.demoAppDirectory ?? raw.demoApp
  return {
    ...raw,
    clone,
    repo,
    branch,
    githubUrl,
    githubSubpath,
    docsBaseUrl,
    demoApp,
  }
}

function normalizeAuditConfig(cfg, profile) {
  if (!cfg || typeof cfg !== 'object') return cfg
  const out = { ...cfg }
  if (out.defaultSource && !out.default) out.default = out.defaultSource
  if (out.default && !out.defaultSource) out.defaultSource = out.default
  if (!out.sources || typeof out.sources !== 'object') return out
  const sources = {}
  for (const [name, raw] of Object.entries(out.sources)) {
    sources[name] = normalizeSourceEntry(raw, profile)
  }
  out.sources = sources
  return out
}

/** Local profile: require explicit roots and branches in audit.config-local.yaml (no silent defaults). */
function assertLocalAuditConfig(cfg, sourceName, sourceCfg) {
  const docsRoot = String(cfg.docsSiteRoot ?? cfg.qaDocsCheckout ?? cfg.mdkDocsRoot ?? '').trim()
  if (!docsRoot) {
    console.error(
      `audit.config-local.yaml requires docsSiteRoot — absolute path to the mdk-docs checkout (folder containing src/data/components.json).`,
    )
    process.exit(2)
  }
  const docsBr = String(cfg.docsBranch ?? cfg.docsSiteExpectedBranch ?? '').trim()
  if (!docsBr) {
    console.error(
      `audit.config-local.yaml requires docsBranch — expected git branch for that docs checkout (HEAD must match).`,
    )
    process.exit(2)
  }
  const repoPath = String(sourceCfg.repo ?? '').trim()
  if (!repoPath) {
    console.error(
      `audit.config-local.yaml requires sources.${sourceName}.localPathToRepo — absolute path to the ui-client root.`,
    )
    process.exit(2)
  }
  const br = String(sourceCfg.branch ?? '').trim()
  if (!br) {
    console.error(
      `audit.config-local.yaml requires sources.${sourceName}.branch — expected git branch for that ui-client checkout (HEAD must match). Not inferred from ciManifestClone.ref.`,
    )
    process.exit(2)
  }
}

/** Docs catalog root: local yaml-only path; ci allows MDK_DOCS_REPO and defaults to this repo checkout. */
function resolveDocsSiteRoot(cfg, profile) {
  if (profile === 'local') {
    const raw = cfg?.docsSiteRoot ?? cfg?.qaDocsCheckout ?? cfg?.mdkDocsRoot
    if (!raw || !String(raw).trim()) {
      console.error(
        `audit.config-local.yaml requires docsSiteRoot — absolute path to the mdk-docs checkout.`,
      )
      process.exit(2)
    }
    return path.resolve(String(raw).trim())
  }
  if (process.env.MDK_DOCS_REPO) return path.resolve(process.env.MDK_DOCS_REPO)
  const raw = cfg?.docsSiteRoot ?? cfg?.qaDocsCheckout ?? cfg?.mdkDocsRoot
  if (raw && String(raw).trim()) return path.resolve(String(raw).trim())
  return path.resolve(__dirname, '../../..')
}

/** https, file:, or absolute path to mdk-docs root → normalized base (empty = site-relative doc paths). */
function normalizePublishedDocsBase(raw) {
  const u = String(raw || '').trim()
  if (!u) return ''
  if (/^https?:\/\//i.test(u)) return u.replace(/\/+$/, '')
  if (u.startsWith('file:')) return u.replace(/\/+$/, '')
  if (path.isAbsolute(u)) return pathToFileURL(path.resolve(u)).href.replace(/\/$/, '')
  return u.replace(/\/+$/, '')
}

function validateCloneOwnerRepos(cfg) {
  if (!cfg?.sources) return
  for (const [name, s] of Object.entries(cfg.sources)) {
    const gh = s?.clone?.githubRepo
    if (gh) {
      assertOwnerRepoSlug(`sources.${name} ciManifestClone.ownerRepo`, gh)
    }
  }
}

if (!fs.existsSync(ACTIVE_CONFIG_PATH)) {
  if (AUDIT_PROFILE === 'local') {
    console.error(
      `Audit profile "local" requires ${LOCAL_CONFIG_PATH}\n` +
        `Copy qa/audit-demo-app-local/audit.config-local.example.yaml → audit.config-local.yaml and fill it in, then: npm run audit:demo`,
    )
  } else {
    console.error(`Audit profile "ci" requires ${CONFIG_PATH}`)
  }
  process.exit(2)
}

let CONFIG
try {
  CONFIG = yaml.load(fs.readFileSync(ACTIVE_CONFIG_PATH, 'utf8'))
} catch (err) {
  console.error(`Failed to parse ${ACTIVE_CONFIG_PATH}: ${err.message}`)
  process.exit(2)
}

CONFIG = normalizeAuditConfig(CONFIG, AUDIT_PROFILE)
validateCloneOwnerRepos(CONFIG)

const KNOWN_SOURCES = Object.keys(CONFIG?.sources || {})
if (!KNOWN_SOURCES.length) {
  console.error(`No sources defined in ${ACTIVE_CONFIG_PATH}`)
  process.exit(2)
}

const SOURCE = (
  process.env.MDK_AUDIT_SOURCE ||
  CONFIG.default ||
  CONFIG.defaultSource ||
  KNOWN_SOURCES[0]
).toLowerCase()
if (!CONFIG.sources[SOURCE]) {
  console.error(`Unknown source=${SOURCE}. Defined in config: ${KNOWN_SOURCES.join(', ')}`)
  process.exit(2)
}

const sourceCfg = CONFIG.sources[SOURCE]
const repoEnv = `MDK_${SOURCE.toUpperCase()}_REPO`
const branchEnv = `MDK_${SOURCE.toUpperCase()}_BRANCH`
const githubEnv = `MDK_${SOURCE.toUpperCase()}_GITHUB_URL`
const docsEnv = `MDK_${SOURCE.toUpperCase()}_DOCS_URL`

if (AUDIT_PROFILE === 'local') {
  assertLocalAuditConfig(CONFIG, SOURCE, sourceCfg)
}

let DOCS_REPO = resolveDocsSiteRoot(CONFIG, AUDIT_PROFILE)

const DATA_FILE = path.join(DOCS_REPO, `src/data/${CURRENT_DOC_KEY}/components.json`)
if (!fs.existsSync(DATA_FILE)) {
  console.error(
    `Missing docs catalog at ${DATA_FILE}\n` +
      `${AUDIT_PROFILE === 'local' ? `Set docsSiteRoot in audit.config-local.yaml to the mdk-docs checkout (folder containing src/data/components.json).` : `(ci) Set docsSiteRoot or MDK_DOCS_REPO in ${path.basename(ACTIVE_CONFIG_PATH)}.`}`,
  )
  process.exit(2)
}

const DOCS_BASE_URL = normalizePublishedDocsBase(
  AUDIT_PROFILE === 'local'
    ? sourceCfg.docsBaseUrl || ''
    : process.env[docsEnv] || sourceCfg.docsBaseUrl || '',
)

let EFFECTIVE_DOCS_BASE_URL = DOCS_BASE_URL
if (!EFFECTIVE_DOCS_BASE_URL && AUDIT_PROFILE === 'local') {
  EFFECTIVE_DOCS_BASE_URL = normalizePublishedDocsBase(DOCS_REPO)
}

let REQUIRED_DOCS_BRANCH = ''
if (AUDIT_PROFILE === 'local') {
  REQUIRED_DOCS_BRANCH = String(CONFIG.docsBranch ?? CONFIG.docsSiteExpectedBranch ?? '').trim()
} else {
  REQUIRED_DOCS_BRANCH = String(
    process.env.MDK_DOCS_EXPECTED_BRANCH ||
      process.env.MDK_DOCS_BRANCH ||
      CONFIG.docsSiteExpectedBranch ||
      CONFIG.docsSiteBranch ||
      '',
  ).trim()
}

if (REQUIRED_DOCS_BRANCH || AUDIT_PROFILE === 'local') {
  let docsHead = ''
  try {
    docsHead = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: DOCS_REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (err) {
    if (AUDIT_PROFILE === 'local') {
      console.error(
        `[audit-demo] docsSiteRoot must be a git checkout for branch verification (${DOCS_REPO}): ${err.message}`,
      )
      process.exit(2)
    }
    console.warn(
      `[audit-demo] docsSiteRoot is not a git checkout (${DOCS_REPO}); skipping docs branch check.`,
    )
  }
  if (docsHead && REQUIRED_DOCS_BRANCH && docsHead !== REQUIRED_DOCS_BRANCH) {
    console.error(
      `Branch mismatch for docs site (catalog + MDX): ${DOCS_REPO}\n` +
        `  required: ${REQUIRED_DOCS_BRANCH}\n` +
        `  actual:   ${docsHead}\n` +
        (AUDIT_PROFILE === 'local'
          ? `Switch the docs checkout or update docsBranch in audit.config-local.yaml.`
          : `Switch the docs checkout, set docsSiteExpectedBranch in ${path.basename(ACTIVE_CONFIG_PATH)}, or MDK_DOCS_EXPECTED_BRANCH.`),
    )
    process.exit(2)
  }
}

/** On-disk root for current-version catalog-backed component MDX. */
const AUDIT_DOCS_DISK_ROOT = path.join(
  DOCS_REPO,
  process.env.MDK_AUDIT_DOCS_CONTENT_REL?.trim() || path.join('content', 'docs'),
)

const mdkAuditDocsContentRel = process.env.MDK_AUDIT_DOCS_CONTENT_REL?.trim()
if (mdkAuditDocsContentRel) {
  const normalized = path.normalize(mdkAuditDocsContentRel).replace(/\\/g, '/')
  if (!normalized.endsWith('content/docs') && !normalized.includes('/content/docs/')) {
    console.warn(
      `[audit-demo] MDK_AUDIT_DOCS_CONTENT_REL should point at the current docs tree (expected .../content/docs). Got: ${normalized}`,
    )
  }
}

const AUDIT_DOC_SITE_PREFIX = (
  process.env.MDK_AUDIT_DOC_SITE_PREFIX?.trim() || CURRENT_DOCS_PREFIX
).replace(/\/+$/, '')

const OUT_DIR = process.env.MDK_AUDIT_OUT_DIR
  ? path.resolve(process.env.MDK_AUDIT_OUT_DIR)
  : __dirname

const UI_REPO =
  AUDIT_PROFILE === 'local' ? sourceCfg.repo : process.env[repoEnv] || sourceCfg.repo
const REQUIRED_BRANCH =
  AUDIT_PROFILE === 'local'
    ? String(sourceCfg.branch ?? '').trim()
    : process.env[branchEnv] || sourceCfg.branch
const GITHUB_URL = (
  AUDIT_PROFILE === 'local'
    ? sourceCfg.githubUrl || ''
    : process.env[githubEnv] || sourceCfg.githubUrl || ''
).replace(/\/+$/, '')
const GITHUB_SUBPATH = (sourceCfg.githubSubpath || '').replace(/^\/+|\/+$/g, '')
const DEMO_APP_REL = (sourceCfg.demoApp || 'apps/demo').replace(/^\/+|\/+$/g, '')
const TRANSITIVE_DEPTH_RAW = process.env.MDK_AUDIT_TRANSITIVE_DEPTH
const TRANSITIVE_DEPTH = Math.max(1, Number.parseInt(TRANSITIVE_DEPTH_RAW, 10) || 4)

if (!UI_REPO || !String(UI_REPO).trim()) {
  console.error(
    `Config for source=${SOURCE} is missing ui-client path.\n` +
      (AUDIT_PROFILE === 'local'
        ? `Set sources.${SOURCE}.localPathToRepo in audit.config-local.yaml — see audit.config-local.example.yaml.`
        : `Set sources.${SOURCE}.localPathToRepo (legacy: repo) in ${path.basename(ACTIVE_CONFIG_PATH)} or ${repoEnv}.`),
  )
  process.exit(2)
}

if (!REQUIRED_BRANCH) {
  console.error(
    `Config for source=${SOURCE} is missing branch.\n` +
      (AUDIT_PROFILE === 'local'
        ? `Set sources.${SOURCE}.branch in audit.config-local.yaml (explicit branch — not inferred from ciManifestClone.ref).`
        : `Set sources.${SOURCE}.expectedBranch or sources.${SOURCE}.ciManifestClone.ref (legacy: branch) in ${path.basename(ACTIVE_CONFIG_PATH)}, or ${branchEnv}.`),
  )
  process.exit(2)
}

const DEMO_DIR = path.join(UI_REPO, DEMO_APP_REL)
const NAV_FILE = path.join(DEMO_DIR, 'src/constants/navigation.tsx')
const ROUTER_FILE = path.join(DEMO_DIR, 'src/router.tsx')

/**
 * Load the pre-built registry.json produced by `npm run build:registry` inside
 * packages/react-devkit. This is the authoritative public surface for List A —
 * it is generated by the TypeScript compiler (ts-morph) which resolves path
 * aliases correctly, unlike the regex barrel walker it replaces.
 *
 * Returns:
 *   components     — Map<"core|foundation::Name", absoluteSourcePath> (full surface, traversal index)
 *   hooks          — Array of hook descriptors (used by the hooks audit only)
 *   tierByKey      — Map<key, tier|null> for every registry component
 *   agentReadyKeys — Set<key> of `@tier agent-ready` components (List A membership)
 *   meta           — { generatedAt, packageVersion }
 *
 * Known limitation: the transitive walk inside buildListB (parseIntraPackageInternalImports)
 * still uses the regex parser for following relative imports within a component's source
 * file. Path aliases inside those source files (e.g. @core, @tetherto/mdk-ui-core) cannot
 * be resolved by the regex approach. This affects only the transitive portion of List B;
 * the public surface (List A) and the direct demo-import signal are unaffected.
 * Tracked as a follow-up to replace parseIntraPackageInternalImports with ts-morph.
 */
function loadRegistry(uiRepo) {
  const registryPath = path.join(uiRepo, 'packages/react-devkit/dist/registry.json')
  if (!fs.existsSync(registryPath)) {
    console.error(`[audit-demo] registry.json not found at ${registryPath}`)
    console.error('[audit-demo] Run: cd packages/react-devkit && npm run build:registry')
    process.exit(2)
  }
  const d = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  const pkgOf = (p) => (p.startsWith('src/foundation/') ? 'foundation' : 'core')
  const pkgRoot = path.join(uiRepo, 'packages/react-devkit')
  // `components` is the full registry surface — used as the BFS traversal/source
  // index. List A *membership* is the agent-ready subset (`@tier agent-ready`,
  // the CLI's source of truth for "public"), tracked separately in
  // `agentReadyKeys`; `tierByKey` carries the raw tier for every entry.
  const components = new Map()
  const tierByKey = new Map()
  const agentReadyKeys = new Set()
  for (const c of d.components || []) {
    const key = `${pkgOf(c.path)}::${c.name}`
    if (!components.has(key)) components.set(key, path.join(pkgRoot, c.path))
    if (!tierByKey.has(key)) tierByKey.set(key, c.tier ?? null)
    if (c.tier === 'agent-ready') agentReadyKeys.add(key)
  }
  const hooks = (d.hooks || []).map((h) => ({
    name: h.name,
    pkg: pkgOf(h.path),
    sourceFile: path.join(pkgRoot, h.path),
    tier: h.tier,
    category: h.category,
    summary: h.description ?? null,
  }))
  return {
    components,
    hooks,
    tierByKey,
    agentReadyKeys,
    meta: { generatedAt: d.generatedAt, packageVersion: d.packageVersion },
  }
}

if (!fs.existsSync(NAV_FILE)) {
  console.error(`Demo navigation not found: ${NAV_FILE}\n(2) Fix sources.${SOURCE}.demoApp or localPathToRepo in ${path.basename(ACTIVE_CONFIG_PATH)}.`)
  process.exit(2)
}

let ACTUAL_BRANCH
try {
  ACTUAL_BRANCH = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: UI_REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
} catch (err) {
  console.error(
    `Could not read git HEAD in ${UI_REPO}: ${err.message}\nIs this path a git checkout?`,
  )
  process.exit(2)
}

if (ACTUAL_BRANCH !== REQUIRED_BRANCH) {
  console.error(
    `Branch mismatch for source=${SOURCE}: ${UI_REPO}\n` +
      `  required: ${REQUIRED_BRANCH}\n` +
      `  actual:   ${ACTUAL_BRANCH}\n` +
      (AUDIT_PROFILE === 'local'
        ? `Switch the ui-client checkout or update sources.${SOURCE}.branch in audit.config-local.yaml.`
        : `Switch the source checkout to '${REQUIRED_BRANCH}', or align config: ` +
          `sources.${SOURCE}.expectedBranch or ciManifestClone.ref in ${path.basename(ACTIVE_CONFIG_PATH)} (legacy: branch), or ${branchEnv}.`),
  )
  process.exit(2)
}

// ---------- path translation ----------

function relRepo(abs) {
  return path.relative(UI_REPO, abs).split(path.sep).join('/')
}

function ghUrl(absOrRel, lineSpec) {
  const rel = path.isAbsolute(absOrRel) ? relRepo(absOrRel) : absOrRel.replace(/^\/+/, '')
  const anchor = lineSpec ? `#${lineSpec}` : ''
  if (!GITHUB_URL) {
    const absFile = path.normalize(path.join(UI_REPO, rel))
    return pathToFileURL(absFile).href + anchor
  }
  const subpath = GITHUB_SUBPATH ? `${GITHUB_SUBPATH}/` : ''
  return `${GITHUB_URL}/blob/${ACTUAL_BRANCH}/${subpath}${rel}${anchor}`
}

// ---------- ESM-ish module parser (lifted/trimmed from audit-code) ----------

function stripComments(src) {
  src = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  src = src.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (match, pre) => pre + ' '.repeat(match.length - pre.length))
  return src
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const ext of EXTENSIONS) {
    const p = base + ext
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  }
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base
  for (const ext of EXTENSIONS) {
    const p = path.join(base, 'index' + ext)
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  }
  return null
}

function parseNameList(body) {
  const out = []
  for (const raw of body.split(',')) {
    const part = raw.trim()
    if (!part) continue
    if (/^type\s+/.test(part)) continue
    const asMatch = part.match(/^(\w+)\s+as\s+(\w+)$/)
    if (asMatch) {
      out.push({ local: asMatch[1], exported: asMatch[2] })
    } else {
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
  // Body uses `[^}]*?` rather than `[\s\S]*?` so a lazy match can't cross past a
  // previous block's closing `}` and conflate two separate `export { ... }` statements
  // (e.g. `export { Form, FormControl, ... }` immediately followed by
  // `export { FormCascader, ... } from './form-fields'`).
  for (const m of src.matchAll(/^\s*export\s+(type\s+)?\{([^}]*?)\}\s*from\s+['"]([^'"]+)['"]\s*;?\s*$/gm)) {
    if (m[1]) continue
    const names = parseNameList(m[2])
    if (names.length) reExports.push({ kind: 'named', from: m[3], names })
  }
  for (const m of src.matchAll(/^\s*export\s+(type\s+)?\{([^}]*?)\}\s*;?\s*$/gm)) {
    if (m[1]) continue
    const tail = src.slice(m.index + m[0].length)
    if (/^\s*from\b/.test(tail)) continue
    for (const n of parseNameList(m[2])) localExports.push({ name: n.exported })
  }
  for (const m of src.matchAll(/^\s*export\s+(?:const|let|var)\s+(\w+)/gm)) {
    localExports.push({ name: m[1] })
  }
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?function\s*\*?\s*(\w+)/gm)) {
    localExports.push({ name: m[1] })
  }
  for (const m of src.matchAll(/^\s*export\s+(?:abstract\s+)?class\s+(\w+)/gm)) {
    localExports.push({ name: m[1] })
  }

  return { reExports, localExports, raw, src, filePath }
}

// ---------- public-surface: skip-kind filter (types/consts not component-doc candidates) ----------

const MISSING_DOCS_SKIP_KINDS = new Set(['type', 'const', 'value', 'namespace', 'enum', 'class'])

// ---------- Layer 1: parse COMPONENT_NAV ----------

function pascalCase(slug) {
  return slug.split(/[-_]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('')
}

function parseNavCatalog() {
  const raw = fs.readFileSync(NAV_FILE, 'utf8')
  const src = stripComments(raw)

  // Find the assignment, then the FIRST `[` after the `=`.
  const declMatch = src.match(/export\s+const\s+COMPONENT_NAV\b[\s\S]*?=\s*/)
  if (!declMatch) throw new Error(`COMPONENT_NAV not found in ${NAV_FILE}`)
  const eqEnd = declMatch.index + declMatch[0].length
  const open = src.indexOf('[', eqEnd)
  if (open === -1) throw new Error(`COMPONENT_NAV array literal not found in ${NAV_FILE}`)
  const end = matchBracket(src, open, '[', ']')
  if (end <= open) throw new Error(`Unterminated COMPONENT_NAV array in ${NAV_FILE}`)
  const body = src.slice(open + 1, end)

  return walkArray(body, [])
}

function walkArray(body, ancestorStack) {
  // Collect every top-level object literal in this array body and recurse into its items[].
  const out = []
  let i = 0
  while (i < body.length) {
    if (body[i] !== '{') { i += 1; continue }
    const objEnd = matchBracket(body, i, '{', '}')
    const obj = body.slice(i + 1, objEnd)
    const id = matchValue(obj, /(?<![A-Za-z0-9_$])id\s*:\s*['"]([^'"]*)['"]/)
    const label = matchValue(obj, /(?<![A-Za-z0-9_$])label\s*:\s*['"]([^'"]*)['"]/)
    const itemsRe = /(?<![A-Za-z0-9_$])items\s*:\s*\[/
    const itemsKw = obj.search(itemsRe)
    if (id != null) {
      if (itemsKw !== -1) {
        const nextStack = [...ancestorStack, { id, label }]
        const arrayOpenAbs = i + 1 + obj.indexOf('[', itemsKw)
        const arrayEndAbs = matchBracket(body, arrayOpenAbs, '[', ']')
        out.push(...walkArray(body.slice(arrayOpenAbs + 1, arrayEndAbs), nextStack))
      } else if (id) {
        // Skip empty-id entries (e.g. the Home leaf with id: '').
        out.push({
          id,
          label,
          navPath: [...ancestorStack.map((a) => a.id), id],
          navLabels: [...ancestorStack.map((a) => a.label), label],
        })
      }
    }
    i = objEnd + 1
  }
  return out
}

function matchBracket(s, start, open, close) {
  let depth = 0
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i]
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return s.length - 1
}

function matchValue(obj, re) {
  const m = obj.match(re)
  return m ? m[1] : null
}

// ---------- Layer 2: parse router + per-page imports ----------

function parseRouterPageMap() {
  // navId -> demo file absolute path.
  //
  // Two passes, in priority order:
  //   1. The route table -- the literal `{ path: '<slug>', element: <Component> }` pairs.
  //      This is the ground truth: nav leaf ids match these route slugs, NOT filenames.
  //      Without this, e.g. nav id `container-controls-card` (route slug) misses its
  //      demo because the source file is `batch-container-controls-card-demo.tsx`.
  //   2. Filename heuristic on `./pages/...` import specifiers, as a fallback for
  //      any leaf whose route entry we couldn't parse (lazy/dynamic constructs etc.).
  const map = new Map()
  if (!fs.existsSync(ROUTER_FILE)) return map
  const raw = fs.readFileSync(ROUTER_FILE, 'utf8')
  const src = stripComments(raw)

  // Build nameToFile from every import in the router, eager and lazy.
  const nameToFile = new Map()

  // Eager named: import { X, Y } from './pages/...'
  for (const m of src.matchAll(/^\s*import\s+\{([^}]+)\}\s+from\s+['"](\.\/(?:pages|examples)\/[^'"]+)['"]\s*;?\s*$/gm)) {
    const file = resolveImport(ROUTER_FILE, m[2])
    if (!file) continue
    for (const nm of parseNameList(m[1])) {
      if (!nameToFile.has(nm.exported)) nameToFile.set(nm.exported, file)
    }
  }
  // Eager default: import X from './pages/...' (also examples/)
  for (const m of src.matchAll(/^\s*import\s+(\w+)\s+from\s+['"](\.\/(?:pages|examples)\/[^'"]+)['"]\s*;?\s*$/gm)) {
    const file = resolveImport(ROUTER_FILE, m[2])
    if (!file) continue
    if (!nameToFile.has(m[1])) nameToFile.set(m[1], file)
  }
  // Lazy form covers two patterns; we just need (constName, importPath, optional namedExport):
  //   const X = lazy(() => import('./pages/foo'))
  //   const X = lazy(() => import('./pages/foo').then((m) => ({ default: m.Bar })))
  // Done in two scans so the .then(...) capture is genuinely optional and avoids the
  // unterminated-group hazard of trying to cram both shapes into one alternation.
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*lazy\s*\(\s*\(\s*\)\s*=>\s*import\(\s*['"](\.\/(?:pages|examples)\/[^'"]+)['"]\s*\)/g)) {
    const file = resolveImport(ROUTER_FILE, m[2])
    if (!file) continue
    if (!nameToFile.has(m[1])) nameToFile.set(m[1], file)
  }
  for (const m of src.matchAll(/lazy\s*\(\s*\(\s*\)\s*=>\s*import\(\s*['"](\.\/(?:pages|examples)\/[^'"]+)['"]\s*\)\s*\.\s*then\s*\([^)]*\)\s*=>\s*\(\s*\{\s*default:\s*\w+\s*\.\s*(\w+)\s*\}/g)) {
    const file = resolveImport(ROUTER_FILE, m[1])
    if (!file) continue
    if (!nameToFile.has(m[2])) nameToFile.set(m[2], file)
  }

  // Pass 1: route-table truth.
  // Match `{ path: '<slug>', element: <expr> }`. Extract every PascalCase identifier
  // from the element expression and pick the first one that's in `nameToFile`. We
  // can't just grab the first PascalCase token because wrappers like `withSuspense(Foo)`
  // contain `Suspense` -- a sibling cap that isn't the page component. Trying each
  // candidate against `nameToFile` is robust against any wrapper-naming convention.
  for (const m of src.matchAll(/\{\s*path:\s*['"]([^'"]+)['"]\s*,\s*element:\s*([^,}]+?)\s*[,}]/g)) {
    const slug = m[1]
    if (!slug) continue
    const elementExpr = m[2]
    const candidates = [...elementExpr.matchAll(/[A-Z][A-Za-z0-9_]*/g)].map((mm) => mm[0])
    for (const cand of candidates) {
      const file = nameToFile.get(cand)
      if (file) {
        if (!map.has(slug)) map.set(slug, file)
        break
      }
    }
  }

  // Pass 2: fallback to filename-based slug guess for any import we know about
  // that didn't get claimed by a route-table entry.
  for (const [, file] of nameToFile) {
    const rel = path.relative(DEMO_DIR, file).replaceAll('\\', '/')
    const spec = `./${rel.replace(/\.[tj]sx?$/, '')}`
    const slug = inferSlugFromPath(spec)
    if (slug && !map.has(slug)) map.set(slug, file)
  }
  return map
}

function inferSlugFromPath(spec) {
  // './pages/action-button-page'                                  -> 'action-button'
  // './pages/dashboard/consumption-line-chart-page/...-page'      -> 'consumption-line-chart'
  // './pages/explorer-containers/bitdeer/bitdeer-page'            -> 'bitdeer'
  // './pages/explorer-details-view/.../miner-info-card.demo'      -> 'miner-info-card'
  // './pages/mosaic-page/mosaic.page'                             -> 'mosaic'
  const last = spec.split('/').pop() || ''
  return last
    .replace(/-page$/i, '')
    .replace(/-demo$/i, '')
    .replace(/\.demo$/i, '')
    .replace(/\.page$/i, '')
}

function resolvePageForLeaf(leaf, routerMap) {
  // 1. exact id match in router
  if (routerMap.has(leaf.id)) return routerMap.get(leaf.id)
  // 2. convention: apps/demo/src/pages/<id>-page.{tsx,ts}
  const conv1 = path.join(DEMO_DIR, 'src/pages', `${leaf.id}-page.tsx`)
  if (fs.existsSync(conv1)) return conv1
  const conv1ts = path.join(DEMO_DIR, 'src/pages', `${leaf.id}-page.ts`)
  if (fs.existsSync(conv1ts)) return conv1ts
  // 3. convention: apps/demo/src/pages/<id>/<id>-page.tsx
  const conv2 = path.join(DEMO_DIR, 'src/pages', leaf.id, `${leaf.id}-page.tsx`)
  if (fs.existsSync(conv2)) return conv2
  return null
}

// Parses value-imports from `@tetherto/mdk-(core|foundation)-ui` in any file.
// Used both on demo pages (Layer 2 recipe) and on package source files (transitive
// shares-leaf walk in buildComponentToLeaves).
//
// Body uses `[^}]*?` rather than `[\s\S]*?` so a lazy match can't cross past a
// previous import's closing `}` and conflate it with the next `from '@tetherto/...'`.
function parseMdkImports(file) {
  const result = { core: new Set(), foundation: new Set(), allMdkNames: new Set() }
  if (!file || !fs.existsSync(file)) return result
  const raw = fs.readFileSync(file, 'utf8')
  const src = stripComments(raw)
  const importPatterns = [
    /^\s*import\s+(type\s+)?\{([^}]*?)\}\s+from\s+['"]@tetherto\/mdk-(core|foundation)-ui['"]\s*;?\s*$/gm,
    /^\s*import\s+(type\s+)?\{([^}]*?)\}\s+from\s+['"]@tetherto\/mdk-react-devkit\/(core|foundation)['"]\s*;?\s*$/gm,
  ]
  for (const re of importPatterns) {
    for (const m of src.matchAll(re)) {
      if (m[1]) continue
      const pkg = m[3] === 'core' ? 'core' : 'foundation'
      for (const nm of parseNameList(m[2])) {
        result[pkg].add(nm.exported)
        result.allMdkNames.add(nm.exported)
      }
    }
  }
  return result
}

function packageOf(file) {
  if (!file) return null
  if (file.includes('/packages/core/') || file.includes('/react-devkit/src/core/')) return 'core'
  if (file.includes('/packages/foundation/') || file.includes('/react-devkit/src/foundation/')) {
    return 'foundation'
  }
  return null
}

// "Is this name a component?" filter shared by List A counts, List B seeds, and
// the per-leaf companions check. PascalCase names that aren't ALL_CAPS constants
// (e.g. `Button`, `LineChartCard`, `Toaster`). Excludes:
//   - ALL_CAPS constants/enums (`SETUP`, `MAX`, `BTC`, `HEATMAP`)
//   - lowerCamel hooks (`useToast`) -- they fail the leading-uppercase check
//   - type-only names that don't start with uppercase
//
// Hooks have their own audit pipeline (deferred to v2), so excluding them here
// is the correct behavior for the components audit.
function isComponentName(name) {
  return /^[A-Z][A-Za-z0-9]*$/.test(name) && !/^[A-Z0-9_]+$/.test(name)
}

// Resolve a relative import specifier from `fromFile` to an absolute path on disk.
// Tries the literal path, common TS/JS extensions, and `/index.*` variants.
// Returns null if the path doesn't resolve to a file we can read.
function resolveRelativeImport(fromFile, spec) {
  if (!fromFile || !spec) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    path.join(base, 'index.tsx'),
    path.join(base, 'index.ts'),
    path.join(base, 'index.jsx'),
    path.join(base, 'index.js'),
  ]
  for (const c of candidates) {
    try {
      const stat = fs.statSync(c)
      if (stat.isFile()) return c
    } catch {}
  }
  return null
}

// Recursively collect MDK imports across the relative-import tree of a demo
// page. A leaf demo file (e.g. `bitmain-page.tsx`) is often a thin Tabs
// composition that pulls in sibling demo files (`./settings/bitmain-settings-demo`,
// `./status/bitmain-status-item-demo`, ...) — and only those sibling files
// import the MDK components being demoed. From the user's perspective that
// whole subtree is one leaf, so for Layer 2 (recipe) and the BFS seed we treat
// the union of MDK imports across the subtree as the leaf's direct imports.
//
// Walks only relative specifiers that resolve inside `DEMO_DIR/src/` so we
// never accidentally chase out into the package source tree (the BFS handles
// that separately, with depth bounds). Cycle-safe via visited set.
function parseDemoTreeImports(rootFile) {
  const result = { core: new Set(), foundation: new Set(), allMdkNames: new Set() }
  if (!rootFile || !fs.existsSync(rootFile)) return result
  const demoSrcRoot = path.join(DEMO_DIR, 'src')
  const visited = new Set()
  const queue = [rootFile]
  while (queue.length) {
    const file = queue.shift()
    if (visited.has(file)) continue
    visited.add(file)
    const own = parseMdkImports(file)
    for (const n of own.core) { result.core.add(n); result.allMdkNames.add(n) }
    for (const n of own.foundation) { result.foundation.add(n); result.allMdkNames.add(n) }
    let raw
    try { raw = fs.readFileSync(file, 'utf8') } catch { continue }
    const src = stripComments(raw)
    for (const m of src.matchAll(/^\s*import\s+(?!type\s)[^'"]+\s+from\s+['"](\.{1,2}\/[^'"]+)['"]\s*;?\s*$/gm)) {
      const resolved = resolveRelativeImport(file, m[1])
      if (!resolved) continue
      if (!resolved.startsWith(`${demoSrcRoot}${path.sep}`)) continue
      if (!visited.has(resolved)) queue.push(resolved)
    }
  }
  return result
}

// Parse relative imports from `file` and return PascalCase named imports,
// regardless of whether the target is in the package's barrel. Used by:
//   - List A's BFS (filter to non-barrel members afterwards to count internals).
//   - List B's transitive BFS (every name encountered is a render the leaf gets,
//     so we want both barrel members and internals).
//
// Skips ALL_CAPS names (constants/enums) and `import type` imports. Returns a
// Set<string> -- names live in the same package as `file` (resolved via
// `packageOf(file)`).
//
// Caveat: imports != renders. A `import { X } from './x'` line is treated as
// "this parent renders X" even if X is referenced only as a type (without the
// `import type` keyword). The `dont-document-components.json` deny-list is the
// long-term escape hatch for false positives.
function parseIntraPackageInternalImports(file) {
  const result = new Set()
  if (!file || !fs.existsSync(file)) return result
  const ownPkg = packageOf(file)
  if (!ownPkg) return result
  const raw = fs.readFileSync(file, 'utf8')
  const src = stripComments(raw)
  // Body uses `[^}]*?` rather than `[\s\S]*?` so a lazy match can't cross past a
  // previous import's closing `}` and conflate it with the next `from './...'`.
  for (const m of src.matchAll(/^\s*import\s+(type\s+)?\{([^}]*?)\}\s+from\s+['"](\.{1,2}\/[^'"]+)['"]\s*;?\s*$/gm)) {
    if (m[1]) continue
    for (const nm of parseNameList(m[2])) {
      const n = nm.exported
      if (!/^[A-Z]/.test(n)) continue
      if (/^[A-Z0-9_]+$/.test(n)) continue
      result.add(n)
    }
  }
  return result
}

// List B: subset of List A that is imported (or rendered transitively) in the
// demo. Returned shape:
//
//   Map<`${pkg}::${Name}`, {
//     kind:          'direct' | 'transitive',  // direct wins precedence across leaves
//     leafSources:   [{                        // every leaf that pulls this name in
//       leafId,
//       kind:        'direct' | 'transitive',
//       chain?:      string[],                 // transitive only: chain from direct parent
//       depth?:      number,                   // transitive only: 1..TRANSITIVE_DEPTH
//     }],
//     sourceFile:    string | null,            // from componentIndex
//   }>.
//
// Walks a BFS through both:
//   - cross-package MDK imports (`@tetherto/mdk-(core|foundation)-ui`)
//   - intra-package relative imports (every PascalCase name, not just barrel
//     members) -- so internal-rendered-by-internal chains continue walking.
// up to `TRANSITIVE_DEPTH` levels. Cycle-safe via per-leaf visited set; shortest
// chain wins (BFS naturally yields shortest path).
//
// Source resolution at every BFS hop uses `componentIndex.get(key)` rather than
// `barrelIndex.get(key)` -- this is the critical change vs. v1, which had to
// terminate at internals because it could only resolve barrel names.
function buildListB(leaves, routerMap, barrelIndex, componentIndex) {
  const map = new Map()
  const ensure = (key) => {
    if (!map.has(key)) {
      map.set(key, { leafSources: [], sourceFile: componentIndex.get(key) || null })
    }
    return map.get(key)
  }

  // Cache per-source-file: the deduped list of {name, pkg} pairs it imports,
  // filtered to component-shaped names (skips hooks, ALL_CAPS, etc.).
  const importsCache = new Map()
  const importsOf = (file) => {
    if (!file) return []
    if (importsCache.has(file)) return importsCache.get(file)
    const pkgImports = parseMdkImports(file)
    const ownPkg = packageOf(file)
    const relNames = parseIntraPackageInternalImports(file)
    const seen = new Set()
    const all = []
    const push = (name, pkg) => {
      if (!isComponentName(name)) return
      const k = `${pkg}::${name}`
      if (seen.has(k)) return
      seen.add(k)
      all.push({ name, pkg })
    }
    for (const n of pkgImports.core) push(n, 'core')
    for (const n of pkgImports.foundation) push(n, 'foundation')
    if (ownPkg) for (const n of relNames) push(n, ownPkg)
    importsCache.set(file, all)
    return all
  }

  for (const leaf of leaves) {
    const demoFile = resolvePageForLeaf(leaf, routerMap)
    if (!demoFile) continue
    // Recursive demo-tree walker collects every MDK import across the leaf's
    // sibling sub-demos (e.g. bitmain-page -> ./settings/bitmain-settings-demo).
    // Filter to component-shaped names so hooks/constants don't leak into List B.
    const directImports = parseDemoTreeImports(demoFile)
    const directList = []
    for (const n of directImports.core) if (isComponentName(n)) directList.push({ name: n, pkg: 'core' })
    for (const n of directImports.foundation) if (isComponentName(n)) directList.push({ name: n, pkg: 'foundation' })

    // Per-leaf visited set keyed by `pkg::Name`. Prevents cycles AND re-crediting
    // at greater depths -- BFS naturally yields the shortest chain per leaf.
    const visited = new Set()

    for (const { name, pkg } of directList) {
      const key = `${pkg}::${name}`
      visited.add(key)
      ensure(key).leafSources.push({ leafId: leaf.id, kind: 'direct' })
    }

    let frontier = directList.map(({ name, pkg }) => ({ name, pkg, chain: [name] }))
    for (let depth = 1; depth <= TRANSITIVE_DEPTH; depth++) {
      if (!frontier.length) break
      const next = []
      for (const node of frontier) {
        const parentKey = `${node.pkg}::${node.name}`
        const parentSource = componentIndex.get(parentKey) || null
        if (!parentSource) continue
        for (const { name: childName, pkg: childPkg } of importsOf(parentSource)) {
          if (childName === node.name && childPkg === node.pkg) continue
          const childKey = `${childPkg}::${childName}`
          if (visited.has(childKey)) continue
          visited.add(childKey)
          ensure(childKey).leafSources.push({
            leafId: leaf.id,
            kind: 'transitive',
            chain: node.chain.slice(),
            depth,
          })
          if (depth < TRANSITIVE_DEPTH) {
            next.push({ name: childName, pkg: childPkg, chain: [...node.chain, childName] })
          }
        }
      }
      frontier = next
    }
  }

  // Compute row-level kind (direct wins precedence) and stabilize leafSources order.
  for (const v of map.values()) {
    v.kind = v.leafSources.some((ls) => ls.kind === 'direct') ? 'direct' : 'transitive'
    v.leafSources.sort((a, b) => {
      if (a.leafId !== b.leafId) return a.leafId.localeCompare(b.leafId)
      if (a.kind !== b.kind) return a.kind === 'direct' ? -1 : 1
      return (a.depth || 0) - (b.depth || 0)
    })
  }
  return map
}

// ---------- Layer 3a: prop-type extraction ----------

function extractPropsForComponent(componentName, sourceFile) {
  if (!sourceFile || !fs.existsSync(sourceFile)) return null
  const raw = fs.readFileSync(sourceFile, 'utf8')
  const src = stripComments(raw)

  const interfaceName = `${componentName}Props`
  const result = { interfaceName, props: [], extension: false, found: false }

  // interface XxxProps [extends Y] { ... } — exported or not.
  const ifaceRe = new RegExp(
    `^\\s*(?:export\\s+)?interface\\s+${interfaceName}\\b([^\\{]*)\\{([\\s\\S]*?)^\\}`,
    'm',
  )
  const ifaceMatch = src.match(ifaceRe)
  if (ifaceMatch) {
    result.found = true
    result.extension = /\bextends\b/.test(ifaceMatch[1])
    result.props = readPropNames(ifaceMatch[2])
    return result
  }

  // type XxxProps = { ... } [& Y] — exported or not. Find the assignment, then take the
  // first balanced `{...}` block as the body; record extension if there are & or |
  // operators outside that block.
  const typeStartRe = new RegExp(`^\\s*(?:export\\s+)?type\\s+${interfaceName}\\s*=\\s*`, 'm')
  const typeMatch = src.match(typeStartRe)
  if (typeMatch) {
    result.found = true
    const after = src.slice(typeMatch.index + typeMatch[0].length)
    const braceOpen = after.indexOf('{')
    if (braceOpen !== -1) {
      const braceEnd = matchBracket(after, braceOpen, '{', '}')
      if (braceEnd > braceOpen) {
        const body = after.slice(braceOpen + 1, braceEnd)
        result.props = readPropNames(body)
      }
      const tail = after.slice(braceEnd + 1).split(/\n/)[0] || ''
      if (/[&|]/.test(tail) || /\b(Pick|Omit|Partial|Required|Readonly)\s*</.test(tail))
        result.extension = true
    } else {
      // RHS is something like `BaseProps & SomethingElse` — purely intersection, no inline body.
      result.extension = true
    }
    return result
  }

  return result
}

function readPropNames(body) {
  // Strip nested braces (object types) so we don't catch nested keys.
  // Heuristic: replace any matching {...} inside the body with a placeholder, recursively.
  let s = body
  let prev = ''
  while (prev !== s) {
    prev = s
    s = s.replace(/\{[^{}]*\}/g, ' ')
  }

  const props = []
  for (const line of s.split(/\n|;/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//')) continue
    const m = trimmed.match(/^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\??)\s*:/)
    if (!m) continue
    props.push({ name: m[1], required: m[2] !== '?' })
  }
  return props
}

// ---------- Docs cross-reference ----------

function loadComponentDocs() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8')
  const parsed = JSON.parse(raw)
  const validKinds = new Set(['component', 'slot', 'icon', 'utility'])
  const byKey = new Map()
  const byName = new Map()
  const byNameLower = new Map()
  const byDocAnchor = new Map()
  for (const c of parsed.components) {
    if (!validKinds.has(c.publicApiKind)) {
      console.warn(
        `[audit-demo] WARN missing/invalid publicApiKind for ${c.package || '?'}::${c.name || '?'} in src/data/components.json`,
      )
    }
    if (c.publicApiKind === 'slot' && !c.ownerComponent) {
      console.warn(
        `[audit-demo] WARN slot missing ownerComponent for ${c.package || '?'}::${c.name || '?'} in src/data/components.json`,
      )
    }
    byKey.set(`${c.package}::${c.name}`, c)
    if (!byName.has(c.name)) byName.set(c.name, c)
    if (!byNameLower.has(c.name.toLowerCase())) byNameLower.set(c.name.toLowerCase(), c)
    if (c.docUrl) byDocAnchor.set(c.docUrl.toLowerCase(), c)
  }
  return { byKey, byName, byNameLower, byDocAnchor, all: parsed.components }
}

// Load `src/data/dont-document-components.json` -- the explicit deny-list of
// barrel-exported names the team has decided not to document. Returns a Set of
// `${pkg}::${name}` keys, mirroring the keying used everywhere else.
//
// Behavior change vs. v1: the audit now reads this file. Previously it was a
// docs-side convention only; v2 enforces it as the missingNeedsDocs filter so
// reviewers can bulk-exclude internal primitives (Form*, Radix patterns, *Icon
// families) without the audit re-flagging them every run.
function loadDontDocument() {
  return loadKeySet(path.join(DOCS_REPO, `src/data/${CURRENT_DOC_KEY}/dont-document-components.json`))
}

// Load `src/data/document-when-fixed.json` -- names we *would* document but
// can't yet because of an upstream gap (e.g. source exists but isn't re-exported
// from the package barrel, or a known SVG bug). Returned keys are merged with the
// dont-document set at the missingNeedsDocs filter stage so these don't churn
// the audit while QA waits for the fix. Move entries back to components.json
// once upstream lands the fix.
//
// Each row may include `maintainerNotes` (internal backlog context); full rows are
// echoed in components-audit.json under `documentWhenFixed[]`.
function loadDocumentWhenFixedData() {
  const keySet = new Set()
  const entries = []
  const file = path.join(DOCS_REPO, `src/data/${CURRENT_DOC_KEY}/document-when-fixed.json`)
  if (!fs.existsSync(file)) return { keySet, entries }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const c of parsed.components || []) {
      if (c?.package && c?.name) {
        keySet.add(`${c.package}::${c.name}`)
        entries.push(c)
      }
    }
  } catch {
    // tolerate parse errors — audit still runs, just without this list applied
  }
  return { keySet, entries }
}

function loadKeySet(file) {
  const set = new Set()
  if (!fs.existsSync(file)) return set
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const c of parsed.components || []) {
      if (c?.package && c?.name) set.add(`${c.package}::${c.name}`)
    }
  } catch {
    // tolerate parse errors -- audit still runs, just without that file applied
  }
  return set
}

function findDocEntryForLeaf(leaf, docs, canonicalName) {
  // 0. If we already know the canonical name (e.g. from the barrel), match that first
  //    case-sensitively then fall back to case-insensitive.
  if (canonicalName) {
    if (docs.byName.has(canonicalName)) return docs.byName.get(canonicalName)
    const ci = docs.byNameLower.get(canonicalName.toLowerCase())
    if (ci) return ci
  }
  // 1. PascalCase form of leaf id matches a name in any package (exact, then ci).
  const pascal = pascalCase(leaf.id)
  if (docs.byName.has(pascal)) return docs.byName.get(pascal)
  const pascalCi = docs.byNameLower.get(pascal.toLowerCase())
  if (pascalCi) return pascalCi
  // 2. Strip trailing 's' (plural) and try again (e.g. 'buttons' -> 'Button').
  if (leaf.id.endsWith('s')) {
    const singular = pascalCase(leaf.id.slice(0, -1))
    if (docs.byName.has(singular)) return docs.byName.get(singular)
    const singularCi = docs.byNameLower.get(singular.toLowerCase())
    if (singularCi) return singularCi
  }
  // 3. docUrl ends with #<id>
  for (const [url, entry] of docs.byDocAnchor) {
    if (url.endsWith(`#${leaf.id}`)) return entry
  }
  return null
}

// Mirrors `slug` in `src/components/component-table.tsx`. Keep these in lockstep — the
// docs site routes URLs off this exact function.
function slug(s) {
  return (s || '').toLowerCase().replace(/\s+/g, '-')
}

// Mirrors `getDocUrl(component)` in `src/components/component-table.tsx`. Returns the
// site-relative path. Use buildLiveDocUrl() to turn it into a full https:// link.
// First match wins — Icons must precede broader filename patterns (card, alert, …).
const CORE_CATEGORY_HINTS = [
  { match: /\/components\/icons\//, category: 'Icons', section: 'components', publicApiKind: 'icon' },
]

function suggestCatalogFields(pkg, name, sourceFile) {
  const base = {
    section: '',
    category: '',
    subcategory: null,
    publicApiKind: null,
    hasDetailPage: true,
  }
  if (!sourceFile) {
    if (/Icon$/.test(name)) {
      return {
        ...base,
        section: 'components',
        category: 'Icons',
        publicApiKind: 'icon',
        hasDetailPage: false,
      }
    }
    return base
  }
  const rel = path.relative(UI_REPO, sourceFile).split(path.sep).join('/')
  for (const h of CORE_CATEGORY_HINTS) {
    if (h.match.test(rel)) {
      return {
        section: h.section,
        category: h.category,
        subcategory: null,
        publicApiKind: h.publicApiKind,
        hasDetailPage: false,
      }
    }
  }
  if (/Icon$/.test(name)) {
    return {
      section: 'components',
      category: 'Icons',
      subcategory: null,
      publicApiKind: 'icon',
      hasDetailPage: false,
    }
  }
  return base
}

function getDocUrl(entry) {
  if (!entry) return null
  if (entry.docUrl) return entry.docUrl
  if (!entry.package || !entry.section || !entry.category || !entry.name) return null
  const anchor = entry.name.toLowerCase()
  if (entry.package === 'core' && entry.category === 'Icons') {
    return `/reference/ui/react/core/icons#${anchor}`
  }
  const pkgSegment = entry.package === 'core' ? 'core' : 'foundation'
  const pathSlug = entry.subcategory
    ? `${slug(entry.category)}/${slug(entry.subcategory)}`
    : slug(entry.category)
  return `/reference/ui/react/${pkgSegment}/${entry.section}/${pathSlug}#${anchor}`
}

/** Site paths for audit output, under the current-version tab (AUDIT_DOC_SITE_PREFIX). */
function docsPathForPublishedSite(rel) {
  if (!rel || /^https?:\/\//i.test(rel)) return rel
  if (!AUDIT_DOC_SITE_PREFIX) return rel
  let out = rel
  if (!out.startsWith(`${AUDIT_DOC_SITE_PREFIX}/`)) {
    out = `${AUDIT_DOC_SITE_PREFIX}${out.startsWith('/') ? '' : '/'}${out}`
  }
  const i = out.indexOf('#')
  if (i === -1) return out
  const base = out.slice(0, i)
  const frag = out.slice(i)
  const nb = base.endsWith('/') ? base : `${base}/`
  return `${nb}${frag}`
}

function buildLiveDocUrl(entry) {
  const rel = getDocUrl(entry)
  if (!rel) return null
  const pathForSite = docsPathForPublishedSite(rel)
  if (!EFFECTIVE_DOCS_BASE_URL) return pathForSite
  if (/^https?:\/\//.test(pathForSite)) return pathForSite
  if (EFFECTIVE_DOCS_BASE_URL.startsWith('file:')) {
    let sitePath = pathForSite
    const hashIdx = sitePath.indexOf('#')
    const frag = hashIdx !== -1 ? sitePath.slice(hashIdx) : ''
    if (hashIdx !== -1) sitePath = sitePath.slice(0, hashIdx)
    const prefix = AUDIT_DOC_SITE_PREFIX.replace(/\/+$/, '')
    let normalized = sitePath.replace(/\/+$/, '')
    if (!normalized.startsWith('/')) normalized = `/${normalized}`
    let rest = ''
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      rest = normalized === prefix ? '' : normalized.slice(prefix.length + 1)
    } else {
      rest = normalized.replace(/^\/+/, '')
    }
    const segments = rest.split('/').filter(Boolean)
    let diskPath =
      segments.length > 0 ? path.join(AUDIT_DOCS_DISK_ROOT, ...segments) : AUDIT_DOCS_DISK_ROOT
    const last = segments[segments.length - 1]
    if (segments.length && last && !last.includes('.')) {
      if (fs.existsSync(`${diskPath}.mdx`)) diskPath = `${diskPath}.mdx`
      else if (fs.existsSync(path.join(diskPath, 'index.mdx'))) {
        diskPath = path.join(diskPath, 'index.mdx')
      }
    }
    return pathToFileURL(diskPath).href + frag
  }
  return `${EFFECTIVE_DOCS_BASE_URL}${pathForSite.startsWith('/') ? pathForSite : '/' + pathForSite}`
}

// Used only for resolving local .mdx files on disk; tolerant of `&`, punctuation, etc.
function slugifyCategory(s) {
  return (s || '').toLowerCase().replace(/&/g, 'and').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')
}

// Returns the list of .mdx files that belong to this component's category section.
// docUrl is preferred when present; otherwise we derive from package + section + category.
function resolveDocFiles(docEntry) {
  if (!docEntry) return []
  const candidates = []

  if (docEntry.docUrl) {
    const noAnchor = docEntry.docUrl.split('#')[0]
    const parts = noAnchor.split('/').filter(Boolean)
    if (
      (parts[0] === 'reference' && parts[1] === 'ui' && parts[2] === 'react') ||
      (parts[0] === 'ui' && parts[1] === 'react')
    ) {
      const tail = parts[0] === 'reference' ? parts.slice(3).join('/') : parts.slice(2).join('/')
      candidates.push(path.join(AUDIT_DOCS_DISK_ROOT, 'reference', 'ui', 'react', `${tail}.mdx`))
      candidates.push(path.join(AUDIT_DOCS_DISK_ROOT, 'reference', 'ui', 'react', tail, 'index.mdx'))
      candidates.push(path.join(AUDIT_DOCS_DISK_ROOT, 'ui', 'react', `${tail}.mdx`))
      candidates.push(path.join(AUDIT_DOCS_DISK_ROOT, 'ui', 'react', tail, 'index.mdx'))
    }
  }

  if (docEntry.package && docEntry.section && docEntry.category) {
    const catSlug = slugifyCategory(docEntry.category)
    if (docEntry.package === 'core' && docEntry.category === 'Icons') {
      candidates.push(path.join(AUDIT_DOCS_DISK_ROOT, 'reference', 'ui', 'react', 'core', 'icons.mdx'))
      candidates.push(path.join(AUDIT_DOCS_DISK_ROOT, 'ui', 'react', 'core', 'icons.mdx'))
    }
    const base = docEntry.subcategory
      ? path.posix.join(
          docEntry.package,
          docEntry.section,
          catSlug,
          slugifyCategory(docEntry.subcategory),
        )
      : path.posix.join(docEntry.package, docEntry.section, catSlug)
    candidates.push(path.join(AUDIT_DOCS_DISK_ROOT, 'reference', 'ui', 'react', `${base}.mdx`))
    candidates.push(path.join(AUDIT_DOCS_DISK_ROOT, 'reference', 'ui', 'react', base, 'index.mdx'))
    candidates.push(path.join(AUDIT_DOCS_DISK_ROOT, 'ui', 'react', `${base}.mdx`))
    candidates.push(path.join(AUDIT_DOCS_DISK_ROOT, 'ui', 'react', base, 'index.mdx'))
    // If the category is a folder, scan the whole folder (every .mdx in it).
    for (const dir of [
      path.join(AUDIT_DOCS_DISK_ROOT, 'reference', 'ui', 'react', base),
      path.join(AUDIT_DOCS_DISK_ROOT, 'ui', 'react', base),
    ]) {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.mdx')) candidates.push(path.join(dir, f))
        }
      }
    }
  }

  // Dedupe + filter to existing files.
  const seen = new Set()
  const found = []
  for (const c of candidates) {
    if (seen.has(c)) continue
    seen.add(c)
    if (fs.existsSync(c)) found.push(c)
  }
  return found
}

function readDocText(mdxFiles) {
  if (!mdxFiles?.length) return ''
  return mdxFiles
    .map((f) => fs.readFileSync(f, 'utf8').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ''))
    .join('\n\n')
}

function textMentionsName(text, name) {
  if (!text || !name) return false
  return new RegExp(`\\b${name}\\b`).test(text)
}

// ---------- Main ----------

function main() {
  console.log(`[audit-demo] (1) Docs QA'd (catalog + MDX): ${DOCS_REPO}`)
  console.log(`[audit-demo] (2) Component library + demo: ${UI_REPO}`)
  console.log(
    `[audit-demo] source=${SOURCE} branch=${ACTUAL_BRANCH} demo=${DEMO_APP_REL} ` +
      `github=${GITHUB_URL || '(unset, source links use file://)'} docs=${EFFECTIVE_DOCS_BASE_URL || '(unset, doc links site-relative)'}`,
  )

  const docs = loadComponentDocs()
  const documentWhenFixedData = loadDocumentWhenFixedData()
  // `dontDoc` is the union of the explicit deny-list (`dont-document-components.json`)
  // and the upstream-fix waiting list (`document-when-fixed.json`). Both contribute
  // the same exclusion: don't flag these in missingNeedsDocs[].
  const dontDoc = new Set([...loadDontDocument(), ...documentWhenFixedData.keySet])
  const leaves = parseNavCatalog()
  const routerMap = parseRouterPageMap()
  const { components: barrelIndex, tierByKey, agentReadyKeys, meta: registryMeta } = loadRegistry(UI_REPO)
  const exportKindByKey = new Map()
  // List A membership is the agent-ready tier (the CLI's source of truth for the
  // public surface). The full registry stays as the BFS traversal/source index so
  // List B can still walk through advanced/untagged components to reach leaves.
  const componentIndex = barrelIndex
  const listARegistryCount = [...barrelIndex.keys()].filter((k) => isComponentName(k.split('::')[1])).length
  const listAAgentReadyCount = [...agentReadyKeys].filter((k) => isComponentName(k.split('::')[1])).length
  console.log(
    `[audit-demo] public-surface: registry → ${barrelIndex.size} exports, ` +
      `${listAAgentReadyCount} agent-ready components (List A) ` +
      `(generated ${registryMeta.generatedAt}, devkit@${registryMeta.packageVersion})`,
  )
  // Phase 2: List B -- subset of A imported or rendered transitively in the demo.
  const listB = buildListB(leaves, routerMap, barrelIndex, componentIndex)

  // Lowercase -> canonical name lookup over the barrel, used to recover the real
  // exported casing when the leaf id PascalCases to the wrong shape (e.g. demo nav
  // says `textarea` -> Textarea but the export is `TextArea`).
  const barrelNamesLower = new Map()
  for (const key of barrelIndex.keys()) {
    const [, name] = key.split('::')
    if (!barrelNamesLower.has(name.toLowerCase())) barrelNamesLower.set(name.toLowerCase(), name)
  }

  // Phase 3: per-leaf rows (recipe + props checks). Tracks every doc key that
  // is the primary of some leaf so stale[] can exclude them (already surfaced
  // here with full recipe/props detail).
  const leafRows = []
  const leafPrimaryKeys = new Set()

  for (const leaf of leaves) {
    const demoFile = resolvePageForLeaf(leaf, routerMap)
    // Recursive walk so a Tabs-style composite leaf (e.g. bitmain-page) resolves
    // imports through its sibling sub-demos. Layer 2 (recipe) and companions
    // both check against this union.
    const imports = parseDemoTreeImports(demoFile)

    // Recover canonical name from (a) demo file imports, then (b) barrel exports —
    // both case-insensitive against the PascalCase'd leaf id. Only then fall back to
    // the PascalCase guess. This stops `textarea` -> `Textarea` from missing the
    // existing `TextArea` row in components.json.
    const guess = pascalCase(leaf.id)
    const guessLower = guess.toLowerCase()
    let canonicalFromImports = null
    for (const n of imports.allMdkNames) {
      if (n.toLowerCase() === guessLower) { canonicalFromImports = n; break }
    }
    const canonicalFromBarrel = barrelNamesLower.get(guessLower) || null
    const canonicalName = canonicalFromImports || canonicalFromBarrel

    const docEntry = findDocEntryForLeaf(leaf, docs, canonicalName)
    const docKey = docEntry ? `${docEntry.package}::${docEntry.name}` : null
    if (docKey) leafPrimaryKeys.add(docKey)

    const componentName = docEntry?.name || canonicalName || guess
    const pkg = docEntry?.package || null

    // Container-leaf detection. Some nav entries are showcase pages that host
    // multiple MDK components rather than a single one (e.g. `form-advanced`
    // demos both `FormCascader` and `FormTagInput`). Heuristic:
    //   1. No row in components.json matches the leaf id (so the audit's
    //      PascalCase guess doesn't reflect a real component).
    //   2. The demo file resolves AND imports >= 2 component-shaped MDK names.
    //   3. None of those imports matches the leaf's PascalCase guess
    //      (case-insensitive) -- confirms the leaf id isn't a misnamed
    //      single-component leaf.
    // When all true, we suppress `suggestedComponentsJsonRow`, skip recipe/
    // props checks, and emit a `container-leaf` note with `hostedComponents[]`
    // listing the MDK components the page demos.
    const componentImports = [...imports.allMdkNames].filter(isComponentName).sort()
    const matchesAnyImport = componentImports.some((n) => n.toLowerCase() === guessLower)
    const isContainerLeaf =
      !docEntry && !!demoFile && componentImports.length >= 2 && !matchesAnyImport

    // Recipe
    const primaryInImports =
      (pkg === 'core' && imports.core.has(componentName)) ||
      (pkg === 'foundation' && imports.foundation.has(componentName)) ||
      imports.allMdkNames.has(componentName)

    let recipeMatch = 'unknown'
    let recipeFoundIn = null
    if (isContainerLeaf) recipeMatch = 'container-leaf'
    else if (!demoFile) recipeMatch = 'no-demo-file'
    else if (!docEntry) recipeMatch = 'no-doc-entry'
    else if (!imports.allMdkNames.size) recipeMatch = 'no-mdk-imports'
    else if (primaryInImports) {
      recipeFoundIn = imports.core.has(componentName) ? 'core' : (imports.foundation.has(componentName) ? 'foundation' : null)
      recipeMatch = recipeFoundIn === pkg ? 'ok' : 'wrong-package'
    } else {
      recipeMatch = 'missing-primary'
    }

    const companions = []
    for (const n of imports.allMdkNames) {
      if (n === componentName) continue
      if (isComponentName(n)) companions.push(n)
    }

    // Companion mention check (only if we know which doc files to look at).
    // Skip for container leaves -- there's no single doc page to check against.
    const docFiles = isContainerLeaf ? [] : resolveDocFiles(docEntry)
    const docText = readDocText(docFiles)
    const missingCompanions = []
    if (!isContainerLeaf && docFiles.length) {
      for (const c of companions) {
        if (!textMentionsName(docText, c)) missingCompanions.push(c)
      }
    }

    // Layer 3a: props. Skipped for container leaves (no single component).
    let propsResult = null
    let undocumentedProps = []
    if (!isContainerLeaf && docEntry && pkg) {
      const sourceFile = barrelIndex.get(`${pkg}::${componentName}`) || null
      propsResult = extractPropsForComponent(componentName, sourceFile)
      if (propsResult?.found && docFiles.length) {
        for (const p of propsResult.props) {
          // `className` is forwarded to the root element on every component by
          // convention (documented once on the components overview page), so it
          // is not re-flagged per component. Named *ClassName hooks (e.g.
          // contentClassName, dropdownClassName) are still checked below.
          if (p.name === 'className') continue
          if (!textMentionsName(docText, p.name)) {
            undocumentedProps.push({ name: p.name, required: p.required })
          }
        }
      }
    }

    // Public-barrel presence: the doc page promises `import { X } from '@tetherto/mdk-{pkg}-ui'`
    // works. If `X` isn't in `packages/<pkg>/src/index.ts` (directly or via re-export) the
    // doc is lying. Strongest possible stale/lift signal — flag separately from demo presence.
    const inPublicBarrel = !!(pkg && barrelIndex.has(`${pkg}::${componentName}`))

    const notes = []
    if (isContainerLeaf) notes.push('container-leaf')
    if (!docEntry && !isContainerLeaf) notes.push('no-doc-entry')
    if (recipeMatch === 'wrong-package') notes.push(`wrong-package:expected-${pkg}-found-${recipeFoundIn}`)
    if (recipeMatch === 'missing-primary' && demoFile) notes.push('primary-not-imported-in-demo')
    if (recipeMatch === 'no-mdk-imports' && demoFile) notes.push('demo-file-has-no-mdk-imports')
    if (recipeMatch === 'no-demo-file') notes.push('no-demo-file-found')
    for (const c of missingCompanions) notes.push(`companion-not-mentioned:${c}`)
    if (propsResult && !propsResult.found && pkg) notes.push('props-type-not-found')
    if (propsResult?.extension) notes.push('props-type-extends-or-intersects')
    for (const p of undocumentedProps) {
      notes.push(`${p.required ? 'prop-undocumented-required' : 'prop-undocumented'}:${p.name}`)
    }
    if (docEntry && !inPublicBarrel) notes.push('not-in-public-barrel')

    const layers = {
      catalog: isContainerLeaf ? null : !!docEntry,
      recipe: isContainerLeaf
        ? null
        : recipeMatch === 'ok' ? true : (recipeMatch === 'unknown' || !docEntry ? null : false),
      props: isContainerLeaf
        ? null
        : (propsResult?.found ? undocumentedProps.length === 0 : (docEntry ? null : null)),
    }

    // Suggest a row payload to add to src/data/components.json when no docs row
    // matches AND the leaf isn't a container. Container leaves intentionally have
    // no payload -- the components they host are themselves separately tracked
    // in listB / missingNeedsDocs / leaves[].
    const leafPkg = leaf.navPath?.[0] === 'foundation' ? 'foundation' : 'core'
    const leafSourceFile =
      barrelIndex.get(`${leafPkg}::${componentName}`) || componentIndex.get(`${leafPkg}::${componentName}`) || null
    const suggestedRow = !docEntry && !isContainerLeaf
      ? {
          name: componentName,
          summary: '',
          description: '',
          package: leafPkg,
          demo: '',
          ...suggestCatalogFields(leafPkg, componentName, leafSourceFile),
        }
      : null

    leafRows.push({
      navId: leaf.id,
      navLabel: leaf.label,
      navPath: leaf.navPath,
      navLabels: leaf.navLabels,
      componentName: isContainerLeaf ? null : componentName,
      package: pkg,
      documented: isContainerLeaf ? null : !!docEntry,
      inDemo: !!demoFile,
      containerLeaf: isContainerLeaf,
      hostedComponents: isContainerLeaf ? componentImports : null,
      docUrl: buildLiveDocUrl(docEntry),
      demoPageUrl: demoFile ? ghUrl(demoFile) : null,
      sourceUrl: inPublicBarrel ? ghUrl(barrelIndex.get(`${pkg}::${componentName}`)) : null,
      inPublicBarrel: isContainerLeaf ? null : inPublicBarrel,
      suggestedComponentsJsonRow: suggestedRow,
      recipe: isContainerLeaf
        ? null
        : {
            package: pkg,
            name: componentName,
            match: recipeMatch,
            foundInPackage: recipeFoundIn,
            companions,
            missingCompanions,
          },
      props: propsResult
        ? {
            interfaceName: propsResult.interfaceName,
            found: propsResult.found,
            extension: propsResult.extension,
            total: propsResult.props.length,
            undocumented: undocumentedProps,
          }
        : null,
      layers,
      notes,
    })
  }

  // Phase 4: missingNeedsDocs = List B \ components.json \ dont-document-components.json.
  //   - direct entries: barrel exports value-imported in the demo. Highest-priority
  //     public-API holes (a developer copying a working demo import will look for docs).
  //   - transitive entries: barrel exports OR internal components reached transitively
  //     from a direct demo import. Triage with the `transitive-only` note: promote to
  //     barrel + docs, lift the parent to docs, or move to dont-document-components.json.
  const missingNeedsDocs = []
  for (const [key, info] of listB) {
    if (docs.byKey.has(key)) continue
    if (dontDoc.has(key)) continue
    // Only suggest docs for the agent-ready surface (List A). Advanced/untagged
    // components reached via the demo are intentionally not pushed into docs;
    // they remain visible (with tier) in the listB[] surface for triage.
    if (!agentReadyKeys.has(key)) continue
    const surfaceKind = exportKindByKey.get(key)
    if (surfaceKind && MISSING_DOCS_SKIP_KINDS.has(surfaceKind)) continue
    const [pkg, name] = key.split('::')
    const inPublicBarrel = barrelIndex.has(key)
    const sourceFile = info.sourceFile || componentIndex.get(key) || null
    const sourceUrl = sourceFile ? ghUrl(sourceFile) : null
    const notes = []
    if (info.kind === 'transitive') notes.push('transitive-only')
    if (!inPublicBarrel) notes.push('not-in-public-barrel')
    missingNeedsDocs.push({
      componentName: name,
      package: pkg,
      kind: info.kind,
      inPublicBarrel,
      sourceUrl,
      leafSources: info.leafSources,
      // Suggested row payload for src/data/components.json. Reviewer fills in
      // section/category/subcategory/demo by hand. Keys ordered to match
      // existing entries in components.json.
      suggestedComponentsJsonRow: {
        name,
        summary: '',
        description: '',
        package: pkg,
        demo: '',
        ...suggestCatalogFields(pkg, name, sourceFile),
      },
      notes,
    })
  }
  // Direct first (highest priority), then transitive, then alpha within each.
  missingNeedsDocs.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'direct' ? -1 : 1
    return a.componentName.localeCompare(b.componentName)
  })

  // Phase 5: stale = components.json \ List B (excluding leaf primaries; those
  // are already surfaced in leaves[] with full recipe/props detail).
  const staleRows = []
  for (const c of docs.all) {
    const key = `${c.package}::${c.name}`
    if (listB.has(key)) continue
    if (leafPrimaryKeys.has(key)) continue
    if (dontDoc.has(key)) continue
    const inPublicBarrel = barrelIndex.has(key)
    const notes = ['stale-no-demo-page']
    if (!inPublicBarrel) notes.push('not-in-public-barrel')
    staleRows.push({
      componentName: c.name,
      package: c.package,
      inPublicBarrel,
      sourceUrl: inPublicBarrel ? ghUrl(barrelIndex.get(key)) : null,
      docUrl: buildLiveDocUrl(c),
      leafSources: [],
      notes,
    })
  }
  // Not-in-public-barrel first (highest priority lift candidates), then alpha.
  staleRows.sort((a, b) => {
    if (a.inPublicBarrel !== b.inPublicBarrel) return a.inPublicBarrel ? 1 : -1
    return a.componentName.localeCompare(b.componentName)
  })

  leafRows.sort((a, b) => {
    const ap = (a.navPath || []).join('/')
    const bp = (b.navPath || []).join('/')
    if (ap !== bp) return ap < bp ? -1 : 1
    return a.componentName < b.componentName ? -1 : 1
  })

  // documentedNotInBarrel is orthogonal to List B membership: any components.json
  // row whose key isn't in barrelIndex is a strong stale/lift signal.
  const documentedNotInBarrel = docs.all.filter((c) => !barrelIndex.has(`${c.package}::${c.name}`)).length

  // documentedNotAgentReady: rows that DO ship in the registry but are not
  // agent-ready (advanced / internal / untagged). With agent-ready as the docs
  // surface (List A), each row is a fork: lift the source `@tier` to agent-ready,
  // or retire the doc page. Rows absent from the registry entirely are covered by
  // documentedNotInBarrel / stale instead, so they're excluded here.
  const documentedNotAgentReady = docs.all
    .filter((c) => {
      const key = `${c.package}::${c.name}`
      return componentIndex.has(key) && !agentReadyKeys.has(key)
    })
    .map((c) => {
      const key = `${c.package}::${c.name}`
      return {
        componentName: c.name,
        package: c.package,
        tier: tierByKey.get(key) ?? null,
        sourceUrl: ghUrl(componentIndex.get(key)),
        docUrl: buildLiveDocUrl(c),
      }
    })
    .sort((a, b) => a.package.localeCompare(b.package) || a.componentName.localeCompare(b.componentName))

  const byKind = {
    component: docs.all.filter((c) => c.publicApiKind === 'component').length,
    slot: docs.all.filter((c) => c.publicApiKind === 'slot').length,
    icon: docs.all.filter((c) => c.publicApiKind === 'icon').length,
    utility: docs.all.filter((c) => c.publicApiKind === 'utility').length,
  }

  const counts = {
    listAAgentReady: listAAgentReadyCount,
    listARegistry: listARegistryCount,
    listB: listB.size,
    listBDirect: [...listB.values()].filter((v) => v.kind === 'direct').length,
    listBTransitive: [...listB.values()].filter((v) => v.kind === 'transitive').length,
    missingNeedsDocs: missingNeedsDocs.length,
    missingDirect: missingNeedsDocs.filter((r) => r.kind === 'direct').length,
    missingTransitive: missingNeedsDocs.filter((r) => r.kind === 'transitive').length,
    stale: staleRows.length,
    documentedNotInBarrel,
    documentedNotAgentReady: documentedNotAgentReady.length,
    catalogLeaves: leafRows.length,
    containerLeaves: leafRows.filter((r) => r.containerLeaf).length,
    documented: leafRows.filter((r) => r.documented === true).length,
    undocumentedFromDemo: leafRows.filter((r) => r.documented === false && !r.containerLeaf).length,
    recipeOk: leafRows.filter((r) => r.recipe?.match === 'ok').length,
    recipeIssues: leafRows.filter((r) => r.recipe && !['ok', 'no-doc-entry'].includes(r.recipe.match)).length,
    propsClean: leafRows.filter((r) => r.props?.found && r.props.undocumented.length === 0).length,
    propsWithUndocumented: leafRows.filter((r) => r.props?.found && r.props.undocumented.length > 0).length,
    byKind,
  }

  // listB[] surface: every name in List B with its provenance. The user-facing
  // triage buckets are missingNeedsDocs and stale, but exposing listB lets
  // reviewers answer "which leaves render Toaster?" or verify regression cases
  // (e.g. "is AddUserModal still classified as transitive via SettingsDashboard
  // -> RBACControlSettings?") via simple jq queries.
  const listBArr = []
  for (const [key, info] of listB) {
    const [pkg, name] = key.split('::')
    const inPublicBarrel = barrelIndex.has(key)
    listBArr.push({
      componentName: name,
      package: pkg,
      kind: info.kind,
      surfaceKind: exportKindByKey.get(key) || null,
      tier: tierByKey.get(key) ?? null,
      agentReady: agentReadyKeys.has(key),
      documented: docs.byKey.has(key),
      inPublicBarrel,
      sourceUrl: info.sourceFile ? ghUrl(info.sourceFile) : null,
      leafSources: info.leafSources,
    })
  }
  listBArr.sort((a, b) =>
    a.package.localeCompare(b.package) || a.componentName.localeCompare(b.componentName),
  )

  const out = {
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    repoLayout: 'registry',
    githubUrl: GITHUB_URL || null,
    docsBaseUrl: EFFECTIVE_DOCS_BASE_URL || null,
    branch: ACTUAL_BRANCH,
    demoApp: DEMO_APP_REL,
    transitiveDepth: TRANSITIVE_DEPTH,
    publicSurface: { mode: 'registry', surface: 'agent-ready', generatedAt: registryMeta.generatedAt, packageVersion: registryMeta.packageVersion, exports: barrelIndex.size, agentReady: listAAgentReadyCount },
    counts,
    documentWhenFixed: documentWhenFixedData.entries,
    missingNeedsDocs,
    stale: staleRows,
    documentedNotAgentReady,
    leaves: leafRows,
    listB: listBArr,
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'components-audit.json'), JSON.stringify(out, null, 2) + '\n')
  fs.writeFileSync(path.join(OUT_DIR, 'undocumented-by-section.md'), renderMarkdown(out))

  console.log(
    `[audit-demo] Wrote components-audit.json (List A (agent-ready): ${counts.listAAgentReady} of ${counts.listARegistry} registry components. Demo app surface (List B): ${counts.listB} (${counts.listBDirect} direct / ${counts.listBTransitive} transitive). Missing: ${counts.missingNeedsDocs} (${counts.missingDirect} direct / ${counts.missingTransitive} transitive). Stale: ${counts.stale}. Not-in-barrel: ${counts.documentedNotInBarrel}. Documented-not-agent-ready: ${counts.documentedNotAgentReady}.)`,
  )
  console.log(
    `[audit-demo] Per-leaf checks: ${counts.catalogLeaves} catalog leaves (${counts.containerLeaves} container, ${counts.documented} documented, ${counts.undocumentedFromDemo} undocumented). Recipe: ${counts.recipeOk} ok / ${counts.recipeIssues} issues. Props: ${counts.propsClean} clean / ${counts.propsWithUndocumented} with undocumented props.`,
  )
}

function renderMarkdown(out) {
  const lines = []
  lines.push('# Demo-driven component audit')
  lines.push('')
  lines.push(`Generated: ${out.generatedAt}`)
  lines.push('')
  lines.push(`- Source: \`${out.source}\``)
  lines.push(
    `- GitHub: ${out.githubUrl || '(unset — \`sourceUrl\` entries use file:// to local ui-client)'}`,
  )
  lines.push(`- Branch: \`${out.branch}\``)
  lines.push(`- Demo app: \`${out.demoApp}\``)
  lines.push(`- Docs site: ${out.docsBaseUrl || '(not configured — `docUrl` values are site-relative)'}`)
  lines.push(`- Transitive depth: ${out.transitiveDepth}`)
  lines.push('')

  const c = out.counts
  lines.push(
    `**Public API surface (List A — agent-ready):** ${c.listAAgentReady} of ${c.listARegistry} registry components. ` +
      `**Demo app surface (List B):** ${c.listB} (${c.listBDirect} direct / ${c.listBTransitive} transitive).`,
  )
  lines.push(
    `**Missing-needs-docs**: ${c.missingNeedsDocs} (${c.missingDirect} direct / ${c.missingTransitive} transitive). ` +
      `**Stale**: ${c.stale}. **Documented but not in public barrel**: ${c.documentedNotInBarrel}. ` +
      `**Documented but not agent-ready**: ${c.documentedNotAgentReady}.`,
  )
  lines.push(
    `**Per-leaf checks**: ${c.catalogLeaves} catalog leaves (${c.containerLeaves} container, ${c.documented} documented, ${c.undocumentedFromDemo} undocumented). ` +
      `Recipe: ${c.recipeOk} ok / ${c.recipeIssues} issues. ` +
      `Props: ${c.propsClean} clean / ${c.propsWithUndocumented} with gaps.`,
  )
  lines.push('')

  // ---------- Missing: highest-priority section ----------

  const missingDirect = (out.missingNeedsDocs || []).filter((r) => r.kind === 'direct')
  const missingTransitive = (out.missingNeedsDocs || []).filter((r) => r.kind === 'transitive')

  if (missingDirect.length) {
    lines.push('## Missing — needs docs (direct imports, highest priority)')
    lines.push('')
    lines.push(
      'These names are value-imported by demo files via `import { X } from \'@tetherto/mdk-<pkg>-ui\'` but have no row in `src/data/components.json`. A developer copying the demo import will look for documentation and find none. Add a row to `components.json` and write the MDX.',
    )
    lines.push('')
    for (const m of missingDirect) {
      const bits = [`\`${m.componentName}\` (${m.package})`]
      if (m.sourceUrl) bits.push(`source: ${m.sourceUrl}`)
      lines.push(`- ${bits.join(' — ')}`)
      const leafIds = [...new Set(m.leafSources.map((ls) => ls.leafId))].sort()
      if (leafIds.length) lines.push(`  - leaves: ${leafIds.join(', ')}`)
      for (const n of m.notes) lines.push(`  - note: \`${n}\``)
    }
    lines.push('')
  }

  if (missingTransitive.length) {
    lines.push('## Missing — needs docs (transitive renders, triage)')
    lines.push('')
    lines.push(
      'These names are reached only through another component\'s render tree (no demo file imports them directly). Decide per row: (a) promote to a barrel export + docs if it\'s genuinely user-facing, (b) lift the parent\'s docs and treat this as an implementation detail, or (c) move to `dont-document-components.json` to silence future audits.',
    )
    lines.push('')
    for (const m of missingTransitive) {
      const bits = [`\`${m.componentName}\` (${m.package})`]
      if (m.sourceUrl) bits.push(`source: ${m.sourceUrl}`)
      lines.push(`- ${bits.join(' — ')}`)
      for (const ls of m.leafSources) {
        const chain = ls.chain?.length ? ls.chain.join(' > ') : ''
        lines.push(`  - leaf \`${ls.leafId}\` (depth ${ls.depth ?? '?'})${chain ? ` via ${chain}` : ''}`)
      }
      for (const n of m.notes) lines.push(`  - note: \`${n}\``)
    }
    lines.push('')
  }

  // ---------- Stale ----------

  const staleNotInBarrel = (out.stale || []).filter((s) => s.inPublicBarrel === false)
  const staleInBarrel = (out.stale || []).filter((s) => s.inPublicBarrel !== false)

  if (staleNotInBarrel.length) {
    lines.push('## Stale — documented but not in public barrel (highest priority)')
    lines.push('')
    lines.push(
      'These names appear in `src/data/components.json` but are not exported from `packages/<pkg>/src/index.ts`. The doc page tells users to write `import { X } from \'@tetherto/mdk-<pkg>-ui\'`, which fails at build time. Lift to `dont-document-components.json` and remove the MDX prose, or export the name from the package barrel if it should genuinely be public.',
    )
    lines.push('')
    for (const s of staleNotInBarrel) {
      const bits = [`\`${s.componentName}\` (${s.package})`]
      if (s.docUrl) bits.push(`doc: ${s.docUrl}`)
      lines.push(`- ${bits.join(' — ')}`)
    }
    lines.push('')
  }

  if (staleInBarrel.length) {
    lines.push('## Stale — in barrel but not in demo')
    lines.push('')
    lines.push(
      `These names appear in \`src/data/components.json\` and are publicly importable, but the demo app surface (List B) doesn\'t include them — no demo file value-imports them and no \`TRANSITIVE_DEPTH=${out.transitiveDepth}\` walk reaches them. Candidates for lift to \`dont-document-components.json\` plus prose removal, or add a focused demo so List B picks them up.`,
    )
    lines.push('')
    for (const s of staleInBarrel) {
      const bits = [`\`${s.componentName}\` (${s.package})`]
      if (s.docUrl) bits.push(`doc: ${s.docUrl}`)
      if (s.sourceUrl) bits.push(`source: ${s.sourceUrl}`)
      lines.push(`- ${bits.join(' — ')}`)
    }
    lines.push('')
  }

  // ---------- Documented but not agent-ready ----------

  const documentedNotAgentReady = out.documentedNotAgentReady || []
  if (documentedNotAgentReady.length) {
    lines.push('## Documented but not agent-ready')
    lines.push('')
    lines.push(
      'These names have a row in `src/data/components.json` and ship in the registry, but their `@tier` is not `agent-ready` (the documentation surface, List A). Per row, decide: (a) lift the source `@tier` to `agent-ready` if it should be a documented, supported component, or (b) retire the doc page if it is advanced/internal-only.',
    )
    lines.push('')
    for (const r of documentedNotAgentReady) {
      const bits = [`\`${r.componentName}\` (${r.package})`, `tier: \`${r.tier ?? 'untagged'}\``]
      if (r.sourceUrl) bits.push(`source: ${r.sourceUrl}`)
      if (r.docUrl) bits.push(`doc: ${r.docUrl}`)
      lines.push(`- ${bits.join(' — ')}`)
    }
    lines.push('')
  }

  // ---------- Container leaves (showcase pages, no single component) ----------

  const containerLeaves = (out.leaves || []).filter((r) => r.containerLeaf)
  if (containerLeaves.length) {
    lines.push('## Container leaves (showcase pages, no single component)')
    lines.push('')
    lines.push(
      'These nav entries demo multiple MDK components rather than a single one (e.g. a "Form (Advanced)" page hosting both `FormCascader` and `FormTagInput`). The audit detects them automatically and skips the recipe/props checks. Use this list to compare docs nav vs. demo nav.',
    )
    lines.push('')
    for (const r of containerLeaves) {
      lines.push(`- nav \`${r.navId}\` — ${r.navLabels?.join(' / ') || r.navLabel || ''}`)
      if (r.demoPageUrl) lines.push(`  - demo: ${r.demoPageUrl}`)
      if (r.hostedComponents?.length) {
        lines.push(`  - hosts: ${r.hostedComponents.map((n) => `\`${n}\``).join(', ')}`)
      }
    }
    lines.push('')
  }

  // ---------- Per-leaf rows: catalog presence + recipe + props ----------

  const componentLeaves = (out.leaves || []).filter((r) => !r.containerLeaf)
  if (componentLeaves.length) {
    lines.push('## Per-leaf checks (catalog / recipe / props)')
    lines.push('')

    const grouped = new Map()
    for (const r of componentLeaves) {
      const top = r.navPath?.[0] || 'misc'
      if (!grouped.has(top)) grouped.set(top, [])
      grouped.get(top).push(r)
    }

    for (const top of [...grouped.keys()].sort()) {
      lines.push(`### ${top}`)
      lines.push('')
      const subgrouped = new Map()
      for (const r of grouped.get(top)) {
        const sub = r.navPath?.[1] || 'top-level'
        if (!subgrouped.has(sub)) subgrouped.set(sub, [])
        subgrouped.get(sub).push(r)
      }
      for (const sub of [...subgrouped.keys()].sort()) {
        lines.push(`#### ${sub}`)
        lines.push('')
        for (const r of subgrouped.get(sub)) {
          const flagBits = []
          flagBits.push(r.documented ? 'doc:ok' : 'doc:missing')
          if (r.recipe) flagBits.push(`recipe:${r.recipe.match}`)
          if (r.props) {
            if (!r.props.found) flagBits.push('props:no-type')
            else if (r.props.undocumented.length === 0) flagBits.push('props:ok')
            else flagBits.push(`props:${r.props.undocumented.length}-missing`)
          }
          const head = `- \`${r.componentName}\` (${r.package || '?'}, nav \`${r.navId}\`) — ${flagBits.join(' / ')}`
          lines.push(head)
          if (r.docUrl) lines.push(`  - doc: ${r.docUrl}`)
          if (r.demoPageUrl) lines.push(`  - demo: ${r.demoPageUrl}`)
          if (r.sourceUrl) lines.push(`  - source: ${r.sourceUrl}`)
          if (r.suggestedComponentsJsonRow) {
            lines.push(
              `  - action: add a row to \`src/data/components.json\` (suggested package \`${r.suggestedComponentsJsonRow.package}\`; pick \`section\` + \`category\`, then write the MDX)`,
            )
          }
          for (const n of r.notes) lines.push(`  - note: \`${n}\``)
        }
        lines.push('')
      }
    }
  }

  return lines.join('\n')
}

main()

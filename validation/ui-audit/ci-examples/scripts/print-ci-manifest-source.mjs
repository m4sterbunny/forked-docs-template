#!/usr/bin/env node
/**
 * Emit ciManifestClone (or legacy clone) for GitHub Actions (MDX manifest fetch).
 * Reads checks/demo-app/audit.config.yaml (single source of truth for clone ref).
 * Writes surface_repo= and surface_ref= to GITHUB_OUTPUT when set; else prints to stdout.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cfgPath = path.join(__dirname, '../../checks/demo-app/audit.config.yaml')
const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8'))
const pub = cfg?.sources?.public
const c = pub?.ciManifestClone ?? pub?.manifestClone ?? pub?.clone
const ownerRepo = c?.ownerRepo ?? c?.githubRepo
const ref = c?.ref
if (!ownerRepo || !ref) {
  console.error(
    'audit.config.yaml must define sources.public.ciManifestClone.ownerRepo and .ref (or legacy clone.githubRepo + ref).',
  )
  process.exit(1)
}
const out = process.env.GITHUB_OUTPUT
if (out) {
  fs.appendFileSync(out, `surface_repo=${ownerRepo}\n`)
  fs.appendFileSync(out, `surface_ref=${ref}\n`)
} else {
  process.stdout.write(`surface_repo=${ownerRepo}\nsurface_ref=${ref}\n`)
}
